// Render a project to MP4 via the HyperFrames producer.
//
// Flow: build the composition dir -> createRenderJob -> executeRenderJob, while
// mirroring progress into an in-memory registry the HTTP layer polls. Renders
// run one-at-a-time through a small queue: a single headless-Chrome render is
// already CPU/GPU heavy, and serializing keeps an MVP box from thrashing. To
// scale out, HyperFrames ships a distributed render path (plan/renderChunk/
// assemble) that this queue could hand chunks to instead.
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
import { paths } from "./config.js";
import { buildComposition } from "./composition.js";
import { getProject } from "./store.js";

/** renderId -> record */
const renders = new Map();
let active = null; // currently running renderId
const queue = [];

function publicRecord(r) {
  return {
    id: r.id,
    projectId: r.projectId,
    status: r.status,
    progress: r.progress,
    message: r.message,
    error: r.error || null,
    outputFile: r.outputFile ? path.basename(r.outputFile) : null,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt || null,
    finishedAt: r.finishedAt || null,
  };
}

export function getRender(id) {
  const r = renders.get(id);
  return r ? publicRecord(r) : null;
}

export function listRenders(projectId) {
  return [...renders.values()]
    .filter((r) => !projectId || r.projectId === projectId)
    .sort((a, b) => (b.queuedAt || "").localeCompare(a.queuedAt || ""))
    .map(publicRecord);
}

export function startRender(projectId, options = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error("project not found");
  if (!project.elements || project.elements.length === 0) {
    throw new Error("project has no elements to render");
  }

  const record = {
    id: randomUUID(),
    projectId,
    status: "queued",
    progress: 0,
    message: "queued",
    outputFile: null,
    error: null,
    queuedAt: new Date().toISOString(),
    options,
  };
  renders.set(record.id, record);
  queue.push(record.id);
  pump();
  return publicRecord(record);
}

function pump() {
  if (active || queue.length === 0) return;
  const id = queue.shift();
  const record = renders.get(id);
  if (!record) return pump();
  active = id;
  runRender(record)
    .catch((err) => {
      record.status = "failed";
      record.error = err?.message || String(err);
      record.finishedAt = new Date().toISOString();
    })
    .finally(() => {
      active = null;
      pump();
    });
}

async function runRender(record) {
  const project = getProject(record.projectId);
  if (!project) throw new Error("project not found");

  record.status = "preparing";
  record.message = "building composition";
  record.startedAt = new Date().toISOString();

  const { dir, entryFile } = buildComposition(project);

  const format = record.options.format || "mp4";
  const outputName = `${project.id}-${Date.now()}.${format === "png-sequence" ? "png" : format}`;
  const outputPath = path.join(paths.output, outputName);
  fs.mkdirSync(paths.output, { recursive: true });

  const job = createRenderJob({
    fps: Number(project.fps) || 30,
    quality: record.options.quality || "standard",
    format,
    entryFile,
  });

  record.status = "rendering";
  record.message = "rendering frames";

  await executeRenderJob(job, dir, outputPath, (j, message) => {
    record.status = j.status || record.status;
    // Prefer frame counts for an accurate percentage; fall back to parsing the
    // "Capturing frame X/Y" progress messages the producer emits.
    let pct = null;
    if (j.totalFrames > 0 && typeof j.framesRendered === "number") {
      pct = (j.framesRendered / j.totalFrames) * 100;
    } else {
      const m = /frame\s+(\d+)\s*\/\s*(\d+)/i.exec(message || "");
      if (m) pct = (Number(m[1]) / Number(m[2])) * 100;
    }
    if (pct != null) record.progress = Math.round(Math.max(0, Math.min(100, pct)));
    if (message) record.message = message;
  });

  record.status = "complete";
  record.progress = 100;
  record.message = "done";
  record.outputFile = outputPath;
  record.finishedAt = new Date().toISOString();
}
