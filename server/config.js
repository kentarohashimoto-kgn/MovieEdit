// Central configuration + filesystem layout for MovieEdit.
//
// This module also wires the HyperFrames render engine to portable binaries so
// the renderer works out of the box:
//   - ffmpeg / ffprobe  -> bundled ffmpeg-static / ffprobe-static (unless the
//                          HYPERFRAMES_FFMPEG_PATH / HYPERFRAMES_FFPROBE_PATH
//                          env vars are already set).
//   - Chromium          -> whatever PUPPETEER_EXECUTABLE_PATH points at.
//
// Importing this module for its side effects is enough to configure the engine.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "..");

// On-disk layout. Everything here is gitignored and may grow large.
export const paths = {
  data: path.join(ROOT, "data"),
  projects: path.join(ROOT, "data", "projects"),
  assets: path.join(ROOT, "assets"),
  uploadsTmp: path.join(ROOT, "assets", "tmp"),
  compositions: path.join(ROOT, "compositions"),
  output: path.join(ROOT, "output"),
  publicDir: path.join(ROOT, "public"),
};

export function ensureDirs() {
  for (const dir of [
    paths.data,
    paths.projects,
    paths.assets,
    paths.uploadsTmp,
    paths.compositions,
    paths.output,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024 * 1024),
  uploadChunkBytes: Number(process.env.UPLOAD_CHUNK_BYTES || 8 * 1024 * 1024),
};

// Resolve a bundled binary path from an optional package, tolerating a missing
// or unbuilt install (e.g. the binary download was blocked on this network).
function resolveStaticBinary(getter) {
  try {
    const p = getter();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* package absent or not built for this platform */
  }
  return null;
}

// Find a binary on PATH (so a system ffmpeg/ffprobe is used when the bundled
// static build isn't available).
function resolveOnPath(bin) {
  try {
    return execFileSync("command", ["-v", bin], {
      shell: "/bin/sh",
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

// Point HyperFrames at ffmpeg/ffprobe binaries unless the operator overrode
// them. Resolution order: env override -> bundled static build -> system PATH.
export function configureRenderBinaries() {
  if (!process.env.HYPERFRAMES_FFMPEG_PATH) {
    const ffmpeg =
      resolveStaticBinary(() => require("ffmpeg-static")) || resolveOnPath("ffmpeg");
    if (ffmpeg) process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
  }
  if (!process.env.HYPERFRAMES_FFPROBE_PATH) {
    const ffprobe =
      resolveStaticBinary(() => require("ffprobe-static").path) ||
      resolveOnPath("ffprobe");
    if (ffprobe) process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
  }
  return {
    ffmpeg: process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg (not found)",
    ffprobe: process.env.HYPERFRAMES_FFPROBE_PATH || "ffprobe (not found)",
    chromium: process.env.PUPPETEER_EXECUTABLE_PATH || "puppeteer default",
  };
}
