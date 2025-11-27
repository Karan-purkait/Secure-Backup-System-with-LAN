// receiver/server.js
// A simple backup receiver HTTP server.
// Usage: node server.js [PORT]
// Data root: ./data

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mkdirp = require("mkdirp");
const getRawBody = require("raw-body");
const mime = require('mime-types')
const { URL } = require('url')
const DATA_ROOT = path.resolve(__dirname, "data");
const BACKUPS_DIR = path.join(DATA_ROOT, "backups");
const STORE_DIR = path.join(DATA_ROOT, "store");
const META_FILE = path.join(DATA_ROOT, "metadata.json");

mkdirp.sync(BACKUPS_DIR);
mkdirp.sync(STORE_DIR);

// load or init metadata
let meta = { days: {}, nextDayIdByDate: {}, sessions: {} };
if (fs.existsSync(META_FILE)) {
  try {
    meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch (e) {
    console.warn("meta load failed", e);
  }
} else {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}
function saveMeta() {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

const app = express();
// small JSON bodies (init & commit)
app.use(express.json({ limit: "10mb" }));

// helper: ensure folder exists
function ensureSync(p) {
  mkdirp.sync(p);
}

// Endpoint: get offset for a partial file (resume)
app.get("/file-offset", (req, res) => {
  const sha = req.query.sha;
  if (!sha) return res.status(400).json({ error: "sha required" });
  const storePath = path.join(STORE_DIR, sha);
  if (fs.existsSync(storePath)) {
    const s = fs.statSync(storePath);
    return res.json({ exists: true, bytes: s.size });
  } else {
    return res.json({ exists: false, bytes: 0 });
  }
});

app.get('/',(req,res)=>{
  res.status(200).send("working")
})

// Endpoint: init-backup
// Body: { date: "YYYY-MM-DD", clientId: "...", manifest: [{relpath, size, mtime, sha}] }
// Server returns { dayIndex, versionId, missingHashes: [] }
app.post("/init-backup", (req, res) => {
  const { date, clientId, manifest } = req.body;
  if (!date || !clientId || !manifest)
    return res.status(400).json({ error: "date, clientId, manifest required" });
  // day index incrementing per date
  let dayIndex = meta.nextDayIdByDate[date] || 1;
  meta.nextDayIdByDate[date] = dayIndex + 1;
  saveMeta();

  // build list of missing hashes
  const missing = [];
  for (const f of manifest) {
    const storePath = path.join(STORE_DIR, f.sha);
    if (!fs.existsSync(storePath)) missing.push(f.sha);
  }

  // create a version id
  const versionId = `version-${new Date().toISOString().replace(/:/g, "-")}`;
  // create folders for day & version
  const dateFolder = `date-[${date}] (day ${dayIndex})`;
  const dayPath = path.join(BACKUPS_DIR, dateFolder);
  const versionPath = path.join(dayPath, versionId);
  ensureSync(versionPath);

  // store a provisional manifest spot for this version
  const provisional = {
    date,
    dayIndex,
    versionId,
    clientId,
    createdAt: new Date().toISOString(),
    files: {}, // will be filled in on commit
  };
  const sessionKey = `${clientId}_${Date.now()}`;
  meta.sessions[sessionKey] = {
    date,
    dayIndex,
    versionId,
    versionPath,
    provisional,
  };
  saveMeta();

  res.json({
    dayIndex,
    versionId,
    versionPath,
    missingHashes: missing,
    sessionKey,
  });
});

// Endpoint: upload-file
// Query: sha, relpath, versionId
// Headers: filesize
// Body: raw stream of file bytes. Supports X-Start-Byte header for resume.
app.post("/upload-file", async (req, res) => {
  const sha = req.query.sha;
  const relpath = req.query.relpath;
  const versionId = req.query.versionId;
  if (!sha || !relpath || !versionId)
    return res.status(400).json({ error: "sha, relpath, versionId required" });

  // find the session by versionId
  const session = Object.values(meta.sessions).find(
    (s) => s.versionId === versionId
  );
  if (!session) return res.status(400).json({ error: "unknown versionId" });

  const storeFile = path.join(STORE_DIR, sha);
  ensureSync(path.dirname(storeFile));

  // resume support: if X-Start-Byte present, the client intends to continue from offset.
  const startByteHeader = req.header("x-start-byte");
  let startByte = startByteHeader ? parseInt(startByteHeader, 10) : 0;
  if (fs.existsSync(storeFile)) {
    const st = fs.statSync(storeFile);
    if (st.size > startByte) {
      // server already has more; send current size
      return res.json({ status: "exists", bytes: st.size });
    } else {
      startByte = st.size; // append from there
    }
  }

  // We'll append to storeFile
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(storeFile, { flags: "a" });
    req.pipe(writeStream);
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
    req.on("aborted", () => {
      writeStream.close();
      reject(new Error("client aborted"));
    });
  }).catch((err) => {
    console.error("upload-stream error", err);
    return res
      .status(500)
      .json({ error: "upload failed", details: err.message });
  });

  // After writing, verify sha256 matches
  const computed = await sha256OfFile(storeFile);
  if (computed !== sha) {
    // corrupt — remove file part
    console.error("hash mismatch", computed, sha);
    return res.status(400).json({ error: "hash mismatch", computed });
  }

  // Register file: map relpath -> sha inside version manifest
  const versionPath = session.versionPath;
  const manifestFile = path.join(versionPath, "manifest.json");
  let manifest = { files: {} };
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile));
    } catch {}
  }
  manifest.files[relpath] = { sha, uploadedAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  res.json({ status: "ok", sha });
});

// Endpoint: commit-version
// Body: { sessionKey, manifest: [{relpath, size, mtime, sha}], extra }
app.post("/commit-version", (req, res) => {
  const { sessionKey, manifest, extra } = req.body;
  if (!sessionKey || !manifest)
    return res.status(400).json({ error: "sessionKey and manifest required" });
  const session = meta.sessions[sessionKey];
  if (!session) return res.status(400).json({ error: "invalid sessionKey" });

  const { date, dayIndex, versionId, versionPath } = session;

  // Write final version manifest (map relpath->sha + meta)
  const final = {
    metadata: {
      date,
      dayIndex,
      versionId,
      createdAt: new Date().toISOString(),
      extra: extra || {},
    },
    files: {},
  };
  for (const f of manifest) {
    final.files[f.relpath] = { sha: f.sha, size: f.size, mtime: f.mtime };
  }
  fs.writeFileSync(
    path.join(versionPath, "manifest.json"),
    JSON.stringify(final, null, 2)
  );

  // Update server-level index (e.g., record this version)
  const dateFolder = `date-[${date}] (day ${dayIndex})`;
  const dayPath = path.join(BACKUPS_DIR, dateFolder);
  ensureSync(dayPath);
  // move/ensure version folder located inside dayPath
  // session.versionPath was created inside BACKUPS_DIR earlier so it's ok.
  // update meta.days index
  meta.days[`${dateFolder}`] = meta.days[`${dateFolder}`] || [];
  meta.days[`${dateFolder}`].push({
    versionId,
    path: path.relative(DATA_ROOT, versionPath),
    createdAt: new Date().toISOString(),
  });
  saveMeta();

  // remove session
  delete meta.sessions[sessionKey];
  saveMeta();

  res.json({ status: "committed", versionId, versionPath });
});

// simple endpoint to check which of a list of hashes exist
// GET /status/has-hashes?sha=sha1&sha=sha2
app.get("/status/has-hashes", (req, res) => {
  const arr = Array.isArray(req.query.sha)
    ? req.query.sha
    : req.query.sha
    ? [req.query.sha]
    : [];
  const exist = {};
  for (const sha of arr) {
    const sp = path.join(STORE_DIR, sha);
    exist[sha] = fs.existsSync(sp);
  }
  res.json(exist);
});

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("data", (d) => hash.update(d));
    s.on("end", () => resolve(hash.digest("hex")));
    s.on("error", reject);
  });
}




// helper: prevent path traversal and ensure version path is under DATA_ROOT
function safeResolveVersionPath(versionPath) {
  // versionPath is stored relative to DATA_ROOT in meta.days entries.
  const abs = path.isAbsolute(versionPath) ? versionPath : path.join(DATA_ROOT, versionPath);
  const normalized = path.normalize(abs);
  if (!normalized.startsWith(DATA_ROOT)) throw new Error('invalid versionPath');
  return normalized;
}

// 1) browse: list date folders & summary
// GET /browse
app.get('/browse', (req, res) => {
  // meta.days keys are like "date-[YYYY-MM-DD] (day N)"
  const result = [];
  for (const [dateFolder, versions] of Object.entries(meta.days)) {
    result.push({
      dateFolder,
      versions: versions.map(v => ({ versionId: v.versionId, path: v.path, createdAt: v.createdAt }))
    });
  }
  res.json({ days: result });
});

// 2) list versions in a dateFolder (client can pass encoded folder name)
// GET /list?dateFolder=...
app.get('/list', (req, res) => {
  const dateFolder = req.query.dateFolder;
  if (!dateFolder) return res.status(400).json({ error: 'dateFolder required' });
  const versions = meta.days[dateFolder] || [];
  res.json({ dateFolder, versions });
});

// 3) return the version manifest.json
// GET /version-manifest?versionPath=<encoded>
app.get('/version-manifest', (req, res) => {
  const versionPath = req.query.versionPath;
  if (!versionPath) return res.status(400).json({ error: 'versionPath required' });
  try {
    const vp = safeResolveVersionPath(versionPath);
    const mf = path.join(vp, 'manifest.json');
    if (!fs.existsSync(mf)) return res.status(404).json({ error: 'manifest not found' });
    const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
    res.json({ manifest: data, versionPath: path.relative(DATA_ROOT, vp) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 4) stream/download a file by versionPath + relpath (relpath is the path as in manifest)
// GET /file?versionPath=<encoded>&relpath=<encoded>
// supports Range
app.get('/file', (req, res) => {
  const { versionPath, relpath } = req.query;
  if (!versionPath || !relpath) return res.status(400).json({ error: 'versionPath & relpath required' });
  try {
    const vp = safeResolveVersionPath(versionPath);
    const mf = path.join(vp, 'manifest.json');
    if (!fs.existsSync(mf)) return res.status(404).json({ error: 'manifest not found' });
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    // manifest.files keys are relpaths
    const fileEntry = manifest.files[relpath];
    if (!fileEntry) return res.status(404).json({ error: 'file not found in manifest' });
    const sha = fileEntry.sha;
    const storeFile = path.join(STORE_DIR, sha);
    if (!fs.existsSync(storeFile)) return res.status(404).json({ error: 'content not found in store' });

    const stat = fs.statSync(storeFile);
    const total = stat.size;

    // Range support
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (!m) return res.status(416).end();
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= total) return res.status(416).end();
      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start) + 1,
        'Content-Type': mime.lookup(relpath) || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(relpath)}"`
      });
      const rs = fs.createReadStream(storeFile, { start, end });
      rs.pipe(res);
    } else {
      res.set({
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': mime.lookup(relpath) || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(relpath)}"`
      });
      const rs = fs.createReadStream(storeFile);
      rs.pipe(res);
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 5) stream/download by sha directly (handy for previews)
// GET /file-by-sha?sha=<sha>
app.get('/file-by-sha', (req, res) => {
  const sha = req.query.sha;
  if (!sha) return res.status(400).json({ error: 'sha required' });
  const storeFile = path.join(STORE_DIR, sha);
  if (!fs.existsSync(storeFile)) return res.status(404).json({ error: 'not found' });

  const stat = fs.statSync(storeFile);
  const total = stat.size;
  const range = req.headers.range;
  const mimeType = mime.lookup(storeFile) || 'application/octet-stream';

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) return res.status(416).end();
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || end >= total) return res.status(416).end();
    res.status(206);
    res.set({
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': (end - start) + 1,
      'Content-Type': mimeType
    });
    fs.createReadStream(storeFile, { start, end }).pipe(res);
  } else {
    res.set({
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType
    });
    fs.createReadStream(storeFile).pipe(res);
  }
});

// 6) simple search across manifests (filename substring match)
// GET /search?q=...  (returns up to 500 matches)
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.status(400).json({ error: 'q required' });
  const matches = [];
  // iterate all days and versions in meta.days
  for (const [dateFolder, versions] of Object.entries(meta.days)) {
    for (const v of versions) {
      try {
        const vp = safeResolveVersionPath(v.path);
        const mfFile = path.join(vp, 'manifest.json');
        if (!fs.existsSync(mfFile)) continue;
        const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
        for (const [rel, info] of Object.entries(mf.files || {})) {
          if (rel.toLowerCase().includes(q)) {
            matches.push({
              dateFolder,
              versionId: v.versionId,
              versionPath: v.path,
              relpath: rel,
              sha: info.sha,
              size: info.size || null
            });
            if (matches.length >= 500) break;
          }
        }
      } catch (e) {
        // skip corrupt manifests
        console.warn('search skip', e.message);
      }
    }
  }
  res.json({ q, count: matches.length, matches });
});

// 7) tiny HTML explorer UI (single-file web UI)
// GET /explorer
app.get('/explorer/v1', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Backup Explorer</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 12px; }
    .col { float:left; width: 30%; margin-right: 2%; }
    .box { border: 1px solid #ddd; padding: 8px; border-radius:6px; min-height:200px; }
    ul { list-style:none; padding:0; }
    li { padding:4px 0; cursor:pointer; }
    .muted { color:#666; font-size:12px; }
    .file { color: #333; }
    .btn { padding:6px 8px; margin:4px; cursor:pointer; background:#007bff; color:white; border-radius:4px; display:inline-block; }
    a { color: #007bff; text-decoration:none; }
  </style>
</head>
<body>
  <h2>Backup Explorer</h2>
  <div>
    <input id="search" placeholder="search filenames..." style="width:40%"/>
    <button onclick="doSearch()" class="btn">Search</button>
    <span id="searchResult" class="muted"></span>
  </div>
  <div style="margin-top:10px;">
    <div class="col"><div class="box"><h4>Days</h4><ul id="days"></ul></div></div>
    <div class="col"><div class="box"><h4>Versions</h4><ul id="versions"></ul></div></div>
    <div class="col"><div class="box"><h4>Files</h4><ul id="files"></ul></div></div>
    <div style="clear:both"></div>
  </div>

<script>
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Fetch failed: ' + r.status);
  return r.json();
}

async function loadDays(){
  const j = await fetchJSON('/browse');
  const ul = document.getElementById('days'); ul.innerHTML = '';
  j.days.forEach(d => {
    const li = document.createElement('li');
    li.textContent = d.dateFolder + ' (' + d.versions.length + ' versions)';
    li.onclick = () => loadVersions(encodeURIComponent(d.dateFolder));
    ul.appendChild(li);
  });
}
async function loadVersions(encodedDateFolder){
  const j = await fetchJSON('/list?dateFolder=' + encodedDateFolder);
  const ul = document.getElementById('versions'); ul.innerHTML = '';
  j.versions.forEach(v => {
    const li = document.createElement('li');
    li.textContent = v.versionId + ' — ' + v.createdAt;
    li.onclick = () => loadManifest(encodeURIComponent(v.path));
    ul.appendChild(li);
  });
}
async function loadManifest(versionPath){
  const j = await fetchJSON('/version-manifest?versionPath=' + encodeURIComponent(versionPath));
  const ul = document.getElementById('files'); ul.innerHTML = '';
  const files = j.manifest && j.manifest.files ? Object.entries(j.manifest.files) : [];
  files.forEach(([rel, info])=>{
    const li = document.createElement('li');
    li.innerHTML = '<span class="file">'+rel+'</span><div class="muted">sha:'+info.sha+' size:'+ (info.size||'n/a') +'</div>';
    const dl = document.createElement('a');
    dl.textContent = ' Download ';
    dl.href = '/file?versionPath=' + encodeURIComponent(versionPath) + '&relpath=' + encodeURIComponent(rel);
    dl.style.marginLeft='8px';
    li.appendChild(dl);
    // preview if image
    if (rel.match(/\\.(jpg|jpeg|png|gif|webp)$/i)) {
      const pv = document.createElement('a');
      pv.textContent = ' Preview ';
      pv.href = '/file?versionPath=' + encodeURIComponent(versionPath) + '&relpath=' + encodeURIComponent(rel);
      pv.target = '_blank';
      li.appendChild(pv);
    }
    ul.appendChild(li);
  });
}

async function doSearch(){
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  document.getElementById('searchResult').textContent = 'Searching...';
  const r = await fetchJSON('/search?q=' + encodeURIComponent(q));
  document.getElementById('searchResult').textContent = r.count + ' matches';
  const ul = document.getElementById('files'); ul.innerHTML = '';
  r.matches.forEach(m=>{
    const li = document.createElement('li');
    li.innerHTML = '<div><strong>'+m.relpath+'</strong></div><div class="muted">'+m.dateFolder+' / '+m.versionId+'</div>';
    const dl = document.createElement('a');
    dl.textContent = ' Download ';
    dl.href = '/file?versionPath=' + encodeURIComponent(m.versionPath) + '&relpath=' + encodeURIComponent(m.relpath);
    dl.style.marginLeft='8px';
    li.appendChild(dl);
    ul.appendChild(li);
  });
}

loadDays();
</script>
</body>
</html>
  `);
});



// Replace the '/explorer' endpoint in server.js with this enhanced version:

app.get('/explorer', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Backup Explorer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #f8f9fa;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    
    /* Header */
    .header {
      background: white;
      border-bottom: 1px solid #e0e0e0;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .header h2 {
      font-size: 20px;
      color: #5f6368;
      font-weight: 400;
    }
    .search-box {
      flex: 1;
      max-width: 600px;
      position: relative;
    }
    .search-box input {
      width: 100%;
      padding: 10px 40px 10px 16px;
      border: 1px solid #dfe1e5;
      border-radius: 24px;
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
    }
    .search-box input:focus {
      border-color: #1a73e8;
      box-shadow: 0 1px 6px rgba(26,115,232,0.3);
    }
    .search-box button {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      color: #5f6368;
    }
    
    /* Main Layout */
    .main-container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    
    /* Sidebar */
    .sidebar {
      width: 280px;
      background: white;
      border-right: 1px solid #e0e0e0;
      overflow-y: auto;
      padding: 16px 0;
    }
    .sidebar-section {
      margin-bottom: 24px;
    }
    .sidebar-title {
      padding: 8px 24px;
      font-size: 11px;
      font-weight: 600;
      color: #5f6368;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .sidebar-item {
      padding: 10px 24px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #202124;
      font-size: 14px;
      transition: background 0.2s;
    }
    .sidebar-item:hover {
      background: #f1f3f4;
    }
    .sidebar-item.active {
      background: #e8f0fe;
      color: #1a73e8;
      border-right: 3px solid #1a73e8;
    }
    .sidebar-item .icon {
      width: 20px;
      text-align: center;
      font-size: 18px;
    }
    .sidebar-item .count {
      margin-left: auto;
      color: #5f6368;
      font-size: 12px;
    }
    
    /* Content Area */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }
    
    /* Breadcrumb */
    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #5f6368;
    }
    .breadcrumb-item {
      cursor: pointer;
      transition: color 0.2s;
    }
    .breadcrumb-item:hover {
      color: #1a73e8;
    }
    .breadcrumb-separator {
      color: #dadce0;
    }
    
    /* View Controls */
    .view-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .view-type {
      display: flex;
      gap: 8px;
    }
    .view-btn {
      padding: 8px 12px;
      border: 1px solid #dadce0;
      background: white;
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
      transition: all 0.2s;
    }
    .view-btn:hover {
      background: #f8f9fa;
    }
    .view-btn.active {
      background: #e8f0fe;
      color: #1a73e8;
      border-color: #1a73e8;
    }
    .sort-select {
      padding: 8px 12px;
      border: 1px solid #dadce0;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
    }
    
    /* List View */
    .file-list {
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .file-list-header {
      display: grid;
      grid-template-columns: 40px 1fr 120px 120px 80px;
      padding: 12px 16px;
      background: #f8f9fa;
      border-bottom: 1px solid #e0e0e0;
      font-size: 12px;
      font-weight: 600;
      color: #5f6368;
      text-transform: uppercase;
    }
    .file-item {
      display: grid;
      grid-template-columns: 40px 1fr 120px 120px 80px;
      padding: 12px 16px;
      border-bottom: 1px solid #f1f3f4;
      cursor: pointer;
      transition: background 0.2s;
      align-items: center;
    }
    .file-item:hover {
      background: #f8f9fa;
    }
    .file-item:last-child {
      border-bottom: none;
    }
    .file-icon {
      font-size: 24px;
      text-align: center;
    }
    .file-name {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .file-name-text {
      font-size: 14px;
      color: #202124;
    }
    .file-path {
      font-size: 11px;
      color: #5f6368;
    }
    .file-size {
      font-size: 13px;
      color: #5f6368;
    }
    .file-date {
      font-size: 13px;
      color: #5f6368;
    }
    .file-actions {
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 4px 12px;
      background: #1a73e8;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    .action-btn:hover {
      background: #1557b0;
    }
    
    /* Grid View */
    .file-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 16px;
    }
    .grid-item {
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }
    .grid-item:hover {
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border-color: #1a73e8;
    }
    .grid-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    .grid-name {
      font-size: 14px;
      color: #202124;
      word-break: break-word;
    }
    .grid-size {
      font-size: 12px;
      color: #5f6368;
      margin-top: 4px;
    }
    
    /* Loading & Empty States */
    .loading, .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #5f6368;
    }
    .loading {
      font-size: 16px;
    }
    .empty-state {
      font-size: 14px;
    }
    .empty-icon {
      font-size: 64px;
      margin-bottom: 16px;
      opacity: 0.3;
    }
    
    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: #f1f3f4;
    }
    ::-webkit-scrollbar-thumb {
      background: #dadce0;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #bdc1c6;
    }

    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h2>🗄️ Backup Explorer</h2>
    <div class="search-box">
      <input id="searchInput" type="text" placeholder="Search in backups...">
      <button onclick="performSearch()">🔍</button>
    </div>
  </div>

  <!-- Main Container -->
  <div class="main-container">
    <!-- Sidebar -->
    <div class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-title">Backup Dates</div>
        <div id="sidebarDays"></div>
      </div>
    </div>

    <!-- Content -->
    <div class="content">
      <!-- Breadcrumb -->
      <div class="breadcrumb" id="breadcrumb"></div>

      <!-- View Controls -->
      <div class="view-controls">
        <div class="view-type">
          <button class="view-btn active" onclick="setView('list')">📋 List</button>
          <button class="view-btn" onclick="setView('grid')">⊞ Grid</button>
        </div>
        <select class="sort-select" id="sortSelect" onchange="sortFiles()">
          <option value="name">Sort by Name</option>
          <option value="size">Sort by Size</option>
          <option value="date">Sort by Date</option>
          <option value="type">Sort by Type</option>
        </select>
      </div>

      <!-- Loading State -->
      <div class="loading" id="loading">Loading backups...</div>

      <!-- File List View -->
      <div class="file-list hidden" id="fileList">
        <div class="file-list-header">
          <div></div>
          <div>Name</div>
          <div>Size</div>
          <div>Modified</div>
          <div>Actions</div>
        </div>
        <div id="fileListContent"></div>
      </div>

      <!-- Grid View -->
      <div class="file-grid hidden" id="fileGrid"></div>

      <!-- Empty State -->
      <div class="empty-state hidden" id="emptyState">
        <div class="empty-icon">📁</div>
        <div>No files found</div>
      </div>
    </div>
  </div>

<script>
let currentView = 'list';
let allDays = [];
let currentDay = null;
let currentVersion = null;
let currentPath = [];
let fileStructure = null;

// Initialize
async function init() {
  await loadDays();
}

// Fetch JSON helper
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Fetch failed: ' + r.status);
  return r.json();
}

// Load all backup days
async function loadDays() {
  try {
    const data = await fetchJSON('/browse');
    allDays = data.days;
    renderSidebar();
    document.getElementById('loading').classList.add('hidden');
    if (allDays.length > 0) {
      selectDay(allDays[0], 0);
    } else {
      showEmptyState();
    }
  } catch (e) {
    console.error('Failed to load days:', e);
    document.getElementById('loading').textContent = 'Error loading backups';
  }
}

// Render sidebar with days
function renderSidebar() {
  const container = document.getElementById('sidebarDays');
  container.innerHTML = '';
  
  allDays.forEach((day, index) => {
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.id = 'sidebar-day-' + index;
    item.innerHTML = \`
      <span class="icon">📅</span>
      <span>\${day.dateFolder}</span>
      <span class="count">\${day.versions.length}</span>
    \`;
    item.onclick = () => selectDay(day, index);
    container.appendChild(item);
  });
}

// Select a day
async function selectDay(day, index) {
  currentDay = day;
  currentVersion = null;
  currentPath = [];
  
  // Highlight active item
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.remove('active');
  });
  document.getElementById('sidebar-day-' + index).classList.add('active');
  
  // Load latest version
  if (day.versions.length > 0) {
    await loadVersion(day.versions[day.versions.length - 1]);
  }
}

// Load a specific version
async function loadVersion(version) {
  currentVersion = version;
  currentPath = [];
  
  try {
    document.getElementById('loading').classList.remove('hidden');
    hideFileViews();
    
    const data = await fetchJSON('/version-manifest?versionPath=' + encodeURIComponent(version.path));
    buildFileStructure(data.manifest.files);
    renderBreadcrumb();
    renderFiles();
    
    document.getElementById('loading').classList.add('hidden');
  } catch (e) {
    console.error('Failed to load version:', e);
    document.getElementById('loading').textContent = 'Error loading version';
  }
}

// Build nested folder structure from flat file list
function buildFileStructure(files) {
  const root = { name: 'root', type: 'folder', children: {}, files: [] };
  
  Object.entries(files).forEach(([relpath, info]) => {
    const parts = relpath.split(/[\\/\\\\]/);
    let current = root;
    
    // Navigate/create folder structure
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      if (!current.children[folderName]) {
        current.children[folderName] = {
          name: folderName,
          type: 'folder',
          children: {},
          files: []
        };
      }
      current = current.children[folderName];
    }
    
    // Add file to current folder
    const fileName = parts[parts.length - 1];
    current.files.push({
      name: fileName,
      type: 'file',
      relpath: relpath,
      size: info.size || 0,
      mtime: info.mtime,
      sha: info.sha
    });
  });
  
  fileStructure = root;
}

// Get current folder based on path
function getCurrentFolder() {
  let current = fileStructure;
  for (const part of currentPath) {
    current = current.children[part];
  }
  return current;
}

// Render breadcrumb
function renderBreadcrumb() {
  const breadcrumb = document.getElementById('breadcrumb');
  breadcrumb.innerHTML = '';
  
  // Add root
  const root = document.createElement('span');
  root.className = 'breadcrumb-item';
  root.textContent = currentDay?.dateFolder || 'Backups';
  root.onclick = () => navigateToPath([]);
  breadcrumb.appendChild(root);
  
  // Add path parts
  currentPath.forEach((part, index) => {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-separator';
    sep.textContent = '›';
    breadcrumb.appendChild(sep);
    
    const item = document.createElement('span');
    item.className = 'breadcrumb-item';
    item.textContent = part;
    item.onclick = () => navigateToPath(currentPath.slice(0, index + 1));
    breadcrumb.appendChild(item);
  });
}

// Navigate to a path
function navigateToPath(path) {
  currentPath = path;
  renderBreadcrumb();
  renderFiles();
}

// Render files based on current view
function renderFiles() {
  const folder = getCurrentFolder();
  const items = [
    ...Object.values(folder.children),
    ...folder.files
  ];
  
  // Sort items
  sortItems(items);
  
  if (items.length === 0) {
    showEmptyState();
    return;
  }
  
  hideEmptyState();
  
  if (currentView === 'list') {
    renderListView(items);
  } else {
    renderGridView(items);
  }
}

// Sort items
function sortItems(items) {
  const sortBy = document.getElementById('sortSelect').value;
  
  items.sort((a, b) => {
    // Folders first
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'size':
        return (b.size || 0) - (a.size || 0);
      case 'date':
        return (b.mtime || '').localeCompare(a.mtime || '');
      case 'type':
        return getFileExtension(a.name).localeCompare(getFileExtension(b.name));
      default:
        return 0;
    }
  });
}

// Render list view
function renderListView(items) {
  const list = document.getElementById('fileList');
  const content = document.getElementById('fileListContent');
  const grid = document.getElementById('fileGrid');
  
  list.classList.remove('hidden');
  grid.classList.add('hidden');
  content.innerHTML = '';
  
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'file-item';
    
    const icon = getFileIcon(item);
    const size = item.type === 'folder' ? '-' : formatSize(item.size || 0);
    const date = item.mtime ? new Date(item.mtime).toLocaleDateString() : '-';
    
    const itemCount = item.type === 'folder' ? (Object.keys(item.children).length + item.files.length) : 0;
    
    row.innerHTML = \`
      <div class="file-icon">\${icon}</div>
      <div class="file-name">
        <div class="file-name-text">\${escapeHtml(item.name)}</div>
        \${item.type === 'folder' ? '<div class="file-path">' + itemCount + ' items</div>' : ''}
      </div>
      <div class="file-size">\${size}</div>
      <div class="file-date">\${date}</div>
      <div class="file-actions" id="actions-\${item.type === 'folder' ? 'folder' : item.sha}">
      </div>
    \`;
    
    if (item.type === 'folder') {
      row.onclick = (e) => {
        if (!e.target.classList.contains('action-btn')) {
          currentPath.push(item.name);
          navigateToPath(currentPath);
        }
      };
    } else {
      const actionsDiv = row.querySelector('.file-actions');
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'action-btn';
      downloadBtn.textContent = 'Download';
      downloadBtn.onclick = (e) => {
        e.stopPropagation();
        downloadFile(item.relpath);
      };
      actionsDiv.appendChild(downloadBtn);
    }
    
    content.appendChild(row);
  });
}

// Render grid view
function renderGridView(items) {
  const grid = document.getElementById('fileGrid');
  const list = document.getElementById('fileList');
  
  grid.classList.remove('hidden');
  list.classList.add('hidden');
  grid.innerHTML = '';
  
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'grid-item';
    
    const icon = getFileIcon(item);
    const size = item.type === 'folder' ? 
      (Object.keys(item.children).length + item.files.length) + ' items' : 
      formatSize(item.size || 0);
    
    card.innerHTML = \`
      <div class="grid-icon">\${icon}</div>
      <div class="grid-name">\${escapeHtml(item.name)}</div>
      <div class="grid-size">\${size}</div>
    \`;
    
    if (item.type === 'folder') {
      card.onclick = () => {
        currentPath.push(item.name);
        navigateToPath(currentPath);
      };
    } else {
      card.ondblclick = () => downloadFile(item.relpath);
    }
    
    grid.appendChild(card);
  });
}

// Get file icon based on type
function getFileIcon(item) {
  if (item.type === 'folder') return '📁';
  
  const ext = getFileExtension(item.name).toLowerCase();
  const iconMap = {
    'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'webp': '🖼️', 'svg': '🖼️',
    'mp4': '🎬', 'avi': '🎬', 'mov': '🎬', 'mkv': '🎬',
    'mp3': '🎵', 'wav': '🎵', 'flac': '🎵',
    'pdf': '📄', 'doc': '📄', 'docx': '📄', 'txt': '📄',
    'zip': '📦', 'rar': '📦', 'tar': '📦', 'gz': '📦',
    'js': '💻', 'py': '💻', 'java': '💻', 'cpp': '💻', 'html': '💻', 'css': '💻',
    'xlsx': '📊', 'xls': '📊', 'csv': '📊',
  };
  
  return iconMap[ext] || '📄';
}

// Get file extension
function getFileExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

// Format file size
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Download file
function downloadFile(relpath) {
  if (!currentVersion) return;
  const url = '/file?versionPath=' + encodeURIComponent(currentVersion.path) + 
              '&relpath=' + encodeURIComponent(relpath);
  window.open(url, '_blank');
}

// Set view type
function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  renderFiles();
}

// Sort files
function sortFiles() {
  renderFiles();
}

// Search
async function performSearch() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) return;
  
  try {
    document.getElementById('loading').classList.remove('hidden');
    hideFileViews();
    
    const data = await fetchJSON('/search?q=' + encodeURIComponent(query));
    renderSearchResults(data.matches, query);
    
    document.getElementById('loading').classList.add('hidden');
  } catch (e) {
    console.error('Search failed:', e);
    document.getElementById('loading').textContent = 'Search failed';
  }
}

// Render search results
function renderSearchResults(matches, query) {
  currentPath = [];
  
  const breadcrumb = document.getElementById('breadcrumb');
  breadcrumb.innerHTML = '';
  const searchCrumb = document.createElement('span');
  searchCrumb.className = 'breadcrumb-item';
  searchCrumb.textContent = 'Search results for "' + escapeHtml(query) + '"';
  breadcrumb.appendChild(searchCrumb);
  
  const list = document.getElementById('fileList');
  const content = document.getElementById('fileListContent');
  const grid = document.getElementById('fileGrid');
  
  list.classList.remove('hidden');
  grid.classList.add('hidden');
  
  if (matches.length === 0) {
    showEmptyState();
    return;
  }
  
  hideEmptyState();
  content.innerHTML = '';
  
  matches.forEach(match => {
    const row = document.createElement('div');
    row.className = 'file-item';
    
    const icon = getFileIcon({ name: match.relpath, type: 'file' });
    const size = formatSize(match.size || 0);
    
    row.innerHTML = \`
      <div class="file-icon">\${icon}</div>
      <div class="file-name">
        <div class="file-name-text">\${escapeHtml(match.relpath.split(/[\\/\\\\]/).pop())}</div>
        <div class="file-path">\${escapeHtml(match.dateFolder)} / \${escapeHtml(match.versionId)}</div>
      </div>
      <div class="file-size">\${size}</div>
      <div class="file-date">-</div>
      <div class="file-actions"></div>
    \`;
    
    const actionsDiv = row.querySelector('.file-actions');
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'action-btn';
    downloadBtn.textContent = 'Download';
    downloadBtn.onclick = (e) => {
      e.stopPropagation();
      downloadSearchFile(match.versionPath, match.relpath);
    };
    actionsDiv.appendChild(downloadBtn);
    
    content.appendChild(row);
  });
}

// Download from search results
function downloadSearchFile(versionPath, relpath) {
  const url = '/file?versionPath=' + encodeURIComponent(versionPath) + 
              '&relpath=' + encodeURIComponent(relpath);
  window.open(url, '_blank');
}

// Show/hide empty state
function showEmptyState() {
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('fileList').classList.add('hidden');
  document.getElementById('fileGrid').classList.add('hidden');
}

function hideEmptyState() {
  document.getElementById('emptyState').classList.add('hidden');
}

function hideFileViews() {
  document.getElementById('fileList').classList.add('hidden');
  document.getElementById('fileGrid').classList.add('hidden');
  document.getElementById('emptyState').classList.add('hidden');
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Handle Enter key in search
document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') performSearch();
});

// Initialize on load
init();
</script>
</body>
</html>
  `);
});



const port = process.argv[2] ? parseInt(process.argv[2], 10) : 8080;
app.listen(port, () => {
  console.log(`Backup Receiver listening on ${port}`);
  console.log(`Data root at ${DATA_ROOT}`);
});
