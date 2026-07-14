// Heavy ffmpeg operations for the auto-edit pipeline: extracting audio for
// transcription, cutting selected segments, and (optional) scene detection.
//
// The binaries come from config.configureRenderBinaries() (env override ->
// bundled static -> system PATH), exposed via HYPERFRAMES_FFMPEG_PATH /
// HYPERFRAMES_FFPROBE_PATH.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export function ffmpegBin() {
  return process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg";
}

// Run ffmpeg with a generous buffer; ffmpeg logs to stderr.
async function runFfmpeg(args, timeoutMs = 30 * 60 * 1000) {
  return execFileAsync(ffmpegBin(), args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

// Extract audio as mono 16 kHz for ASR, split into fixed-length chunks so a
// 5-hour source doesn't produce one enormous file (many ASR APIs cap at ~25 MB
// / 10-min uploads). Returns [{ path, offset }] where offset is the chunk's
// start time in the source, in seconds.
export async function extractAudioChunks(inputPath, outDir, chunkSeconds = 600) {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, "chunk-%05d.mp3");
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    "-f",
    "segment",
    "-segment_time",
    String(chunkSeconds),
    pattern,
  ]);
  return fs
    .readdirSync(outDir)
    .filter((f) => /^chunk-\d+\.mp3$/.test(f))
    .sort()
    .map((f, i) => ({ path: path.join(outDir, f), offset: i * chunkSeconds }));
}

// Cut [start, end) from the source and re-encode to a normalized, seekable clip
// (H.264 / AAC, scaled to the target canvas, fixed fps). Re-encoding — rather
// than stream-copy — guarantees frame-accurate cuts and clips that compose and
// render cleanly regardless of the source's keyframe layout.
export async function cutSegment(inputPath, start, end, outPath, opts = {}) {
  const { width = 1920, height = 1080, fps = 30 } = opts;
  const duration = Math.max(0.1, end - start);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Fit-inside scale + pad to exactly WxH so mixed-aspect sources stay centered.
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
  await runFfmpeg([
    "-y",
    "-ss",
    String(start),
    "-i",
    inputPath,
    "-t",
    String(duration),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ]);
  return outPath;
}

// Detect scene-change timestamps (seconds). Optional and O(decode whole file),
// so callers should use it only on shorter sources or when transcript-based
// boundaries aren't available. threshold 0..1 (higher = fewer cuts).
export async function detectScenes(inputPath, threshold = 0.4) {
  let stderr = "";
  try {
    const res = await runFfmpeg([
      "-i",
      inputPath,
      "-filter:v",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ]);
    stderr = res.stderr || "";
  } catch (e) {
    stderr = e.stderr || "";
  }
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr))) times.push(Number(m[1]));
  return times;
}
