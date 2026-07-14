// Transcript acquisition for the auto-edit pipeline.
//
// The transcript is the "context" the planner reasons over — timestamped speech
// is what lets an LLM pick meaningful highlights and write captions that match.
// Sources, in priority order:
//   1. An uploaded subtitle file (SRT / VTT) attached to the asset — zero cost,
//      exact.
//   2. An ASR provider (OpenAI-compatible Whisper endpoint) when
//      OPENAI_API_KEY is set — audio is chunked (see ffmpeg.extractAudioChunks)
//      and each chunk's timestamps are offset back to absolute source time.
//   3. None — the pipeline still runs (scene/interval-based highlights) but
//      without spoken-word captions.
import fs from "node:fs";
import path from "node:path";
import { extractAudioChunks } from "./ffmpeg.js";

// ---- Subtitle parsing ---------------------------------------------------
function tsToSeconds(ts) {
  // Accept "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" / "MM:SS.mmm" (VTT).
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":").map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}

export function parseSubtitles(text) {
  const segments = [];
  // Split into cue blocks on blank lines; tolerant of SRT and VTT.
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const timing = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "" && l.trim() !== "WEBVTT");
    const timeLineIdx = lines.findIndex((l) => timing.test(l));
    if (timeLineIdx === -1) continue;
    const m = timing.exec(lines[timeLineIdx]);
    const start = tsToSeconds(m[1]);
    const end = tsToSeconds(m[2]);
    const textLines = lines.slice(timeLineIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (textLines) segments.push({ start, end, text: textLines });
  }
  return segments;
}

export function parseSubtitleFile(filePath) {
  return parseSubtitles(fs.readFileSync(filePath, "utf8"));
}

// ---- ASR provider (OpenAI-compatible Whisper) ---------------------------
export function asrAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function transcribeChunk(filePath, apiKey, baseUrl, model) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([buf]), path.basename(filePath));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`ASR request failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

// Transcribe a media file via ASR, chunking the audio and stitching absolute
// timestamps. Returns [{ start, end, text }].
export async function transcribeMedia(inputPath, workDir, onProgress = () => {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ASR_MODEL || "whisper-1";

  onProgress("extracting audio");
  const chunks = await extractAudioChunks(inputPath, path.join(workDir, "audio"));
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`transcribing chunk ${i + 1}/${chunks.length}`);
    const result = await transcribeChunk(chunks[i].path, apiKey, baseUrl, model);
    const offset = chunks[i].offset;
    for (const s of result.segments || []) {
      segments.push({
        start: offset + Number(s.start || 0),
        end: offset + Number(s.end || 0),
        text: String(s.text || "").trim(),
      });
    }
  }
  return segments;
}

// Render segments as a compact timestamped transcript for an LLM prompt.
// Each line: "[mm:ss] text". Trims to maxChars from the front if huge.
export function transcriptToText(segments, maxChars = 120000) {
  const fmt = (sec) => {
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const mm = `${m}`.padStart(2, "0");
    const ss = `${s}`.padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const lines = segments.map((s) => `[${fmt(s.start)}] ${s.text}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}
