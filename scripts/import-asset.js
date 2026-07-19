// Import a media file that is ALREADY on the machine running MovieEdit —
// without going through the browser chunked upload.
//
// This is the fast path for very large sources (e.g. a 5-hour recording already
// sitting on the server's disk): it symlinks the file into assets/ (no copy,
// so no extra disk and no wait), probes its duration/resolution, and registers
// it as an asset you can use in the editor or Auto-edit immediately.
//
// Usage:
//   node scripts/import-asset.js /path/to/big-video.mp4
//   node scripts/import-asset.js /path/to/subtitles.srt      (subtitles work too)
//
// It prints the new asset id. Restart or refresh the app and it appears in the
// Media library.
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, configureRenderBinaries, paths } from "../server/config.js";
import { createAsset } from "../server/store.js";
import { probeMedia } from "../server/media.js";

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node scripts/import-asset.js <path-to-file>");
    process.exit(1);
  }
  const src = path.resolve(input);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    console.error(`Not a file: ${src}`);
    process.exit(1);
  }

  ensureDirs();
  configureRenderBinaries(); // so ffprobe is resolved for the probe below

  const size = fs.statSync(src).size;
  const base = path.basename(src).replace(/[^a-zA-Z0-9._-]/g, "_");
  const linkName = `import-${Date.now()}-${base}`;
  const dest = path.join(paths.assets, linkName);

  // Reference in place (symlink) so a huge file costs no extra disk; fall back
  // to a copy only where symlinks aren't allowed.
  try {
    fs.symlinkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }

  const media = await probeMedia(dest);
  const asset = createAsset({
    originalName: path.basename(src),
    storedPath: dest,
    size,
    mimeType: guessMime(src),
    media,
  });

  console.log("Imported asset:");
  console.log(`  id       : ${asset.id}`);
  console.log(`  name     : ${asset.originalName}`);
  console.log(`  size     : ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  duration : ${asset.duration != null ? asset.duration.toFixed(1) + "s" : "unknown"}`);
  if (asset.width) console.log(`  size(px) : ${asset.width}x${asset.height}`);
  console.log("\nRefresh MovieEdit in the browser — it now appears in the Media library.");
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  return map[ext] || "application/octet-stream";
}

main().catch((e) => {
  console.error("Import failed:", e.message);
  process.exit(1);
});
