// Probe media files with ffprobe (bundled via ffprobe-static, or the operator's
// override). Best-effort: if probing fails we fall back to safe defaults so an
// upload is never rejected just because we couldn't read its metadata.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function ffprobeBin() {
  return process.env.HYPERFRAMES_FFPROBE_PATH || "ffprobe";
}

export async function probeMedia(filePath) {
  const bin = ffprobeBin();
  try {
    const { stdout } = await execFileAsync(bin, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    const info = JSON.parse(stdout);
    const streams = info.streams || [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    const duration = Number(
      info.format?.duration || video?.duration || audio?.duration || 0,
    );
    return {
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: video ? Number(video.width) || null : null,
      height: video ? Number(video.height) || null : null,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
    };
  } catch {
    return {
      duration: null,
      width: null,
      height: null,
      hasVideo: null,
      hasAudio: null,
    };
  }
}
