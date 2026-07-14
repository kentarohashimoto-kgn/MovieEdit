// Autonomous highlight editor.
//
// Given a source asset and a single instruction ("cut this into a 5-minute
// highlight, add telops and decorations that fit the context"), this runs the
// whole pipeline end to end:
//
//   1. transcript   — from an attached subtitle asset, or ASR, or none
//   2. plan          — planner.planHighlights (Claude, or heuristic fallback)
//   3. cut           — ffmpeg extracts each chosen segment into a clip asset
//   4. assemble      — build a MovieEdit project: clips in sequence + captions
//                      + decorations laid on the timeline
//   5. render        — hand the project to the HyperFrames render queue
//
// Runs as a background job (one at a time) with polled progress, mirroring
// render.js. The output is a normal project, so the user can still open it in
// the editor and tweak before or after rendering.
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { paths } from "./config.js";
import { getAsset, createAsset, createProject, saveProject } from "./store.js";
import { probeMedia } from "./media.js";
import { cutSegment } from "./ffmpeg.js";
import { parseSubtitleFile, transcribeMedia, asrAvailable } from "./transcript.js";
import { planHighlights, plannerBackend } from "./planner.js";
import { startRender } from "./render.js";

const jobs = new Map();
let active = null;
const queue = [];

function publicJob(j) {
  return {
    id: j.id,
    status: j.status,
    stage: j.stage,
    progress: j.progress,
    message: j.message,
    error: j.error || null,
    projectId: j.projectId || null,
    renderId: j.renderId || null,
    plannerBackend: j.plannerBackend || null,
    transcriptSource: j.transcriptSource || null,
    warnings: j.warnings,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt || null,
  };
}

export function getAutoEdit(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

export function startAutoEdit({ assetId, instruction, targetSeconds, subtitleAssetId }) {
  const asset = getAsset(assetId);
  if (!asset) throw new Error("source asset not found");
  const job = {
    id: randomUUID(),
    assetId,
    subtitleAssetId: subtitleAssetId || null,
    instruction: instruction || "Make a highlight reel.",
    targetSeconds: Number(targetSeconds) || 300,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "queued",
    warnings: [],
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  pump();
  return publicJob(job);
}

function set(job, stage, progress, message) {
  job.stage = stage;
  job.status = stage;
  if (progress != null) job.progress = progress;
  if (message) job.message = message;
}

function pump() {
  if (active || queue.length === 0) return;
  const id = queue.shift();
  const job = jobs.get(id);
  if (!job) return pump();
  active = id;
  run(job)
    .catch((err) => {
      job.status = "failed";
      job.stage = "failed";
      job.error = err?.message || String(err);
      job.finishedAt = new Date().toISOString();
    })
    .finally(() => {
      active = null;
      pump();
    });
}

async function run(job) {
  const asset = getAsset(job.assetId);
  const workDir = path.join(paths.compositions, `autoedit-${job.id}`);
  fs.mkdirSync(workDir, { recursive: true });

  const duration = asset.duration || 0;
  if (!duration) job.warnings.push("source duration unknown; timing may be approximate");

  // 1. Transcript ---------------------------------------------------------
  set(job, "transcribing", 5, "acquiring transcript");
  let segments = [];
  if (job.subtitleAssetId) {
    const sub = getAsset(job.subtitleAssetId);
    if (sub && fs.existsSync(sub.storedPath)) {
      segments = parseSubtitleFile(sub.storedPath);
      job.transcriptSource = "subtitle";
    }
  }
  if (segments.length === 0 && asrAvailable()) {
    try {
      segments = await transcribeMedia(asset.storedPath, workDir, (m) => set(job, "transcribing", 10, m));
      job.transcriptSource = "asr";
    } catch (e) {
      job.warnings.push(`transcription failed: ${e.message}`);
    }
  }
  if (segments.length === 0) {
    job.transcriptSource = job.transcriptSource || "none";
    job.warnings.push("no transcript; using scene/interval-based selection");
  }

  // 2. Plan ---------------------------------------------------------------
  set(job, "planning", 30, `planning highlights (${plannerBackend()})`);
  const { plan, backend, warning } = await planHighlights({
    instruction: job.instruction,
    segments,
    durationSec: duration || estimateDuration(segments),
    targetSec: job.targetSeconds,
  });
  job.plannerBackend = backend;
  if (warning) job.warnings.push(warning);

  const planSegments = sanitizeSegments(plan.segments, duration);
  if (planSegments.length === 0) throw new Error("planner produced no usable segments");

  // 3. Cut + 4. Assemble --------------------------------------------------
  set(job, "cutting", 40, `cutting ${planSegments.length} segments`);
  const project = createProject({
    name: (plan.title || job.instruction).slice(0, 60),
    width: asset.width || 1920,
    height: asset.height || 1080,
    fps: 30,
  });
  const clipsDir = path.join(paths.assets, "clips", project.id);
  fs.mkdirSync(clipsDir, { recursive: true });

  let timeline = 0;
  for (let i = 0; i < planSegments.length; i++) {
    const s = planSegments[i];
    const clipPath = path.join(clipsDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    set(job, "cutting", 40 + Math.round((i / planSegments.length) * 40), `cutting segment ${i + 1}/${planSegments.length}`);
    await cutSegment(asset.storedPath, s.sourceStart, s.sourceEnd, clipPath, {
      width: project.width,
      height: project.height,
      fps: project.fps,
    });
    const media = await probeMedia(clipPath);
    const clipAsset = createAsset({
      originalName: `seg-${i}.mp4`,
      storedPath: clipPath,
      size: fs.statSync(clipPath).size,
      mimeType: "video/mp4",
      media,
    });
    const clipDur = media.duration || s.sourceEnd - s.sourceStart;

    project.elements.push({
      id: randomUUID().slice(0, 8),
      type: "video",
      assetId: clipAsset.id,
      start: timeline,
      duration: clipDur,
      trackIndex: 0,
      withAudio: true,
      volume: 1,
    });
    for (const cap of s.captions || []) {
      project.elements.push({
        id: randomUUID().slice(0, 8),
        type: "text",
        text: cap.text,
        preset: cap.preset || "caption",
        start: timeline + clamp(cap.atOffset, 0, clipDur),
        duration: clamp(cap.duration, 1, clipDur),
        trackIndex: 5,
        fontSize: cap.preset === "title" ? 96 : 52,
        color: "#ffffff",
      });
    }
    for (const dec of s.decorations || []) {
      project.elements.push({
        id: randomUUID().slice(0, 8),
        type: "decoration",
        preset: dec.preset || "corner-label",
        text: dec.text || "",
        start: timeline + clamp(dec.atOffset, 0, clipDur),
        duration: clamp(dec.duration, 1, clipDur),
        trackIndex: 4,
      });
    }
    timeline += clipDur;
  }
  saveProject(project);
  job.projectId = project.id;

  // 5. Render -------------------------------------------------------------
  set(job, "rendering", 85, "rendering highlight reel");
  const render = startRender(project.id, { quality: "standard", format: "mp4" });
  job.renderId = render.id;

  set(job, "complete", 100, `done — ${planSegments.length} segments, ${Math.round(timeline)}s reel`);
  job.status = "complete";
  job.finishedAt = new Date().toISOString();
}

// ---- helpers ------------------------------------------------------------
function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function estimateDuration(segments) {
  return segments.length ? segments[segments.length - 1].end : 0;
}

// Keep only valid, in-bounds, non-trivial segments (defends against a model
// returning overlapping / out-of-range / zero-length ranges).
function sanitizeSegments(segs, duration) {
  if (!Array.isArray(segs)) return [];
  const out = [];
  for (const s of segs) {
    let start = Number(s.sourceStart);
    let end = Number(s.sourceEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (duration > 0) {
      start = Math.max(0, Math.min(start, duration));
      end = Math.max(0, Math.min(end, duration));
    }
    if (end - start < 0.5) continue;
    if (end - start > 120) end = start + 120; // cap any single clip at 2 min
    out.push({ ...s, sourceStart: start, sourceEnd: end });
  }
  return out.sort((a, b) => a.sourceStart - b.sourceStart);
}
