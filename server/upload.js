// Resumable, chunked upload API — the core of MovieEdit's "handles large files"
// requirement.
//
// Why chunked + streamed to disk:
//   - The request body of each chunk is piped straight to disk; the full file is
//     never held in memory, so a 20 GB source costs a few MB of RAM.
//   - Uploads resume after a dropped connection or a page reload: the client
//     asks how many bytes landed and continues from there.
//   - Each chunk is written at an exact byte offset (flags "r+"), so re-sending a
//     chunk that failed mid-flight overwrites the partial tail instead of
//     corrupting the file.
//
// Protocol:
//   POST   /api/uploads                 { filename, size, mimeType } -> { uploadId, received, chunkBytes }
//   GET    /api/uploads/:id             -> { received, size }          (resume probe)
//   PUT    /api/uploads/:id?offset=N    <raw chunk body>  -> { received }
//   POST   /api/uploads/:id/complete    -> { asset }
//
// For production scale this same protocol maps cleanly onto S3 multipart / tus;
// the client contract would not change.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { paths, config } from "./config.js";
import { createAsset } from "./store.js";
import { probeMedia } from "./media.js";

export const uploadRouter = express.Router();

function sessionFile(id) {
  return path.join(paths.uploadsTmp, `${id}.json`);
}
function partFile(id) {
  return path.join(paths.uploadsTmp, `${id}.part`);
}
function loadSession(id) {
  const f = sessionFile(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
function saveSession(s) {
  fs.writeFileSync(sessionFile(s.id), JSON.stringify(s));
}

// Keep a filesystem-safe, human-recognizable name.
function safeName(name) {
  const base = path.basename(String(name || "upload"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "upload";
}

// Begin an upload session.
uploadRouter.post("/", express.json(), (req, res) => {
  const { filename, size, mimeType } = req.body || {};
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) {
    return res.status(400).json({ error: "size (bytes) is required" });
  }
  if (total > config.maxUploadBytes) {
    return res.status(413).json({
      error: `file too large: ${total} > max ${config.maxUploadBytes} bytes`,
    });
  }
  const session = {
    id: randomUUID(),
    filename: safeName(filename),
    size: total,
    mimeType: mimeType || "application/octet-stream",
    received: 0,
    createdAt: new Date().toISOString(),
  };
  fs.closeSync(fs.openSync(partFile(session.id), "w")); // create empty part file
  saveSession(session);
  res.json({ uploadId: session.id, received: 0, chunkBytes: config.uploadChunkBytes });
});

// Resume probe: how many bytes have we durably stored?
uploadRouter.get("/:id", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown upload" });
  res.json({ received: s.received, size: s.size });
});

// Append one chunk at the given byte offset.
uploadRouter.put("/:id", (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown upload" });

  const offset = Number(req.query.offset);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "offset query param required" });
  }
  // Only accept a chunk that continues from what we durably have. The client can
  // re-send the in-flight chunk (offset === received) after a failure.
  if (offset !== s.received) {
    return res
      .status(409)
      .json({ error: "offset mismatch", received: s.received });
  }

  const ws = fs.createWriteStream(partFile(s.id), { flags: "r+", start: offset });
  let written = 0;
  let failed = false;

  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    ws.destroy();
    if (!res.headersSent) res.status(code).json({ error: msg });
  };

  req.on("data", (buf) => {
    written += buf.length;
    if (offset + written > s.size) fail(400, "exceeds declared size");
  });
  req.on("aborted", () => fail(499, "client aborted"));
  req.on("error", () => fail(500, "request stream error"));
  ws.on("error", () => fail(500, "write error"));

  ws.on("finish", () => {
    if (failed) return;
    // Only now, after the chunk fully landed, advance the durable cursor.
    s.received = offset + written;
    saveSession(s);
    res.json({ received: s.received });
  });

  req.pipe(ws);
});

// Finalize: verify size, promote the part file into the asset store.
uploadRouter.post("/:id/complete", express.json(), async (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown upload" });
  if (s.received !== s.size) {
    return res
      .status(409)
      .json({ error: "incomplete upload", received: s.received, size: s.size });
  }

  const finalName = `${s.id}-${s.filename}`;
  const finalPath = path.join(paths.assets, finalName);
  fs.renameSync(partFile(s.id), finalPath);
  fs.rmSync(sessionFile(s.id), { force: true });

  const media = await probeMedia(finalPath);
  const asset = createAsset({
    originalName: s.filename,
    storedPath: finalPath,
    size: s.size,
    mimeType: s.mimeType,
    media,
  });
  res.json({ asset });
});
