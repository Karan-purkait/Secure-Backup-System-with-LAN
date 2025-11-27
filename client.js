// sender/client.js
// Usage: node client.js <rootPath> <receiverHost:port>
// Example: node client.js "C:\\Users\\puskar" "192.168.1.10:8080"
// node index.js . http://192.168.1.15:8080

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const klaw = require("klaw");

if (process.argv.length < 4) {
  console.error("Usage: node client.js <rootPath> <receiverHost:port>");
  process.exit(1);
}
const root = path.resolve(process.argv[2]);
const receiver = process.argv[3].startsWith("http")
  ? process.argv[3]
  : `http://${process.argv[3]}`;

const clientId = require("os").hostname() + "_" + process.pid;
const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Walk the directory and compute file list and sha256 for each file
async function buildManifest(root) {
  const files = [];
  const promises = [];
  return new Promise((resolve, reject) => {
    klaw(root)
      .on("data", (item) => {
        if (!item.stats.isFile()) return;
        // compute relative path
        const rel = path.relative(root, item.path).split(path.sep).join("/");
        files.push({
          fullpath: item.path,
          relpath: rel,
          size: item.stats.size,
          mtime: item.stats.mtimeMs,
        });
      })
      .on("end", async () => {
        for (const f of files) {
          // compute sha256 for each file (stream)
          f.sha = await sha256OfFile(f.fullpath);
        }
        resolve(files);
      })
      .on("error", reject);
  });
}

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function run() {
  console.log(
    "Scanning files (this may take a while for millions of files)... Root:",
    root
  );
  const manifest = await buildManifest(root);
  console.log("Found", manifest.length, "files. Calculated hashes.");

  // send initial request to server, which returns missing hashes
  const initResp = await axios.post(
    `${receiver}/init-backup`,
    {
      date: dateStr,
      clientId,
      manifest: manifest.map((f) => ({
        relpath: f.relpath,
        size: f.size,
        mtime: f.mtime,
        sha: f.sha,
      })),
    },
    { timeout: 60000 }
  );

  const { dayIndex, versionId, sessionKey, missingHashes } = initResp.data;
  console.log(
    "Server responded: dayIndex=",
    dayIndex,
    "versionId=",
    versionId,
    "missingHashesCount=",
    missingHashes.length
  );

  // Build a map of sha->file for faster upload decisions
  const shaToFile = {};
  for (const f of manifest) shaToFile[f.sha] = f;

  // Upload missing files concurrently
  const parallel = 3; // tune concurrency
  const queue = missingHashes.slice();
  async function worker() {
    while (queue.length) {
      const sha = queue.shift();
      const f = shaToFile[sha];
      if (!f) {
        console.warn("server asked for sha we dont have:", sha);
        continue;
      }
      await uploadFileWithResume(f, sha, versionId);
    }
  }
  const workers = [];
  for (let i = 0; i < parallel; i++) workers.push(worker());
  await Promise.all(workers);

  console.log("All missing file uploads finished. Now committing version...");

  // commit: send full manifest (map relpath->sha,size,mtime)
  const commitResp = await axios.post(
    `${receiver}/commit-version`,
    {
      sessionKey,
      manifest: manifest.map((f) => ({
        relpath: f.relpath,
        sha: f.sha,
        size: f.size,
        mtime: f.mtime,
      })),
      extra: { host: require("os").hostname() },
    },
    { timeout: 60000 }
  );

  console.log("Commit response:", commitResp.data);
  console.log("Backup completed for date", dateStr, "day", dayIndex);
}

async function uploadFileWithResume(file, sha, versionId) {
  const url = `${receiver}/upload-file?sha=${sha}&relpath=${encodeURIComponent(
    file.relpath
  )}&versionId=${encodeURIComponent(versionId)}`;
  // check server offset
  try {
    const offResp = await axios.get(`${receiver}/file-offset?sha=${sha}`, {
      timeout: 10000,
    });
    const existing =
      offResp.data && offResp.data.bytes ? offResp.data.bytes : 0;
    if (existing >= file.size) {
      console.log("Server already has file", file.relpath);
      return;
    }
    const start = existing;
    // stream remaining bytes
    const readStream = fs.createReadStream(file.fullpath, { start });
    console.log(`Uploading ${file.relpath} from byte ${start}`);
    const stat = fs.statSync(file.fullpath);

    const resp = await axios({
      method: "post",
      url,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-start-byte": String(start),
        "x-filesize": String(stat.size),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      data: readStream,
      timeout: 0, // allow long uploads
    });
    if (resp.data && resp.data.status === "ok") {
      console.log("Uploaded", file.relpath);
    } else {
      console.warn("Upload response for", file.relpath, resp.data);
    }
  } catch (err) {
    console.error("Upload error for", file.relpath, err.message || err);
    throw err;
  }
}

run().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
