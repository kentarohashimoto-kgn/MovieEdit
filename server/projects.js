// REST API for projects, their timeline elements, preview and render.
import express from "express";
import { randomUUID } from "node:crypto";
import {
  createProject,
  getProject,
  listProjects,
  saveProject,
  deleteProject,
  listAssets,
} from "./store.js";
import { buildComposition } from "./composition.js";
import { startRender, listRenders } from "./render.js";
import { startAutoEdit, getAutoEdit } from "./autoedit.js";
import { plannerBackend } from "./planner.js";
import { asrAvailable } from "./transcript.js";

export const apiRouter = express.Router();
apiRouter.use(express.json());

// ---- Assets (list only; upload lives in upload.js) ----------------------
apiRouter.get("/assets", (_req, res) => {
  res.json({ assets: listAssets() });
});

// ---- Projects -----------------------------------------------------------
apiRouter.get("/projects", (_req, res) => {
  res.json({ projects: listProjects() });
});

apiRouter.post("/projects", (req, res) => {
  const { name, width, height, fps } = req.body || {};
  const project = createProject({ name, width, height, fps });
  res.status(201).json({ project });
});

apiRouter.get("/projects/:id", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json({ project });
});

apiRouter.patch("/projects/:id", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  for (const key of ["name", "width", "height", "fps"]) {
    if (req.body?.[key] !== undefined) project[key] = req.body[key];
  }
  saveProject(project);
  res.json({ project });
});

apiRouter.delete("/projects/:id", (req, res) => {
  deleteProject(req.params.id);
  res.json({ ok: true });
});

// ---- Timeline elements --------------------------------------------------
const ELEMENT_TYPES = new Set(["video", "image", "audio", "text", "decoration"]);

apiRouter.post("/projects/:id/elements", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });

  const body = req.body || {};
  if (!ELEMENT_TYPES.has(body.type)) {
    return res.status(400).json({ error: "invalid element type" });
  }
  const element = {
    id: randomUUID().slice(0, 8),
    type: body.type,
    assetId: body.assetId || null,
    text: body.text || "",
    start: Number(body.start) || 0,
    duration: body.duration != null ? Number(body.duration) : null,
    trackIndex: Number(body.trackIndex) || 0,
    withAudio: body.withAudio ?? true,
    volume: body.volume != null ? Number(body.volume) : 1,
    fontSize: body.fontSize != null ? Number(body.fontSize) : 72,
    color: body.color || "#ffffff",
    align: body.align || "center",
    fit: body.fit || "cover",
    preset: body.preset || null,
  };
  project.elements.push(element);
  saveProject(project);
  res.status(201).json({ project, element });
});

apiRouter.patch("/projects/:id/elements/:elId", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  const el = project.elements.find((e) => e.id === req.params.elId);
  if (!el) return res.status(404).json({ error: "element not found" });

  for (const key of [
    "start",
    "duration",
    "trackIndex",
    "text",
    "withAudio",
    "volume",
    "fontSize",
    "color",
    "align",
    "fit",
  ]) {
    if (req.body?.[key] !== undefined) el[key] = req.body[key];
  }
  saveProject(project);
  res.json({ project, element: el });
});

apiRouter.delete("/projects/:id/elements/:elId", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  project.elements = project.elements.filter((e) => e.id !== req.params.elId);
  saveProject(project);
  res.json({ project });
});

// ---- Preview ------------------------------------------------------------
// Rebuild the composition, then redirect to the static preview page.
apiRouter.get("/projects/:id/preview", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  try {
    buildComposition(project);
    res.redirect(`/compositions/${project.id}/index.html?preview=1`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Render -------------------------------------------------------------
apiRouter.post("/projects/:id/render", (req, res) => {
  try {
    const record = startRender(req.params.id, req.body || {});
    res.status(202).json({ render: record });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get("/projects/:id/renders", (req, res) => {
  res.json({ renders: listRenders(req.params.id) });
});

// ---- Autonomous highlight editing --------------------------------------
// Report which AI capabilities are wired so the UI can set expectations.
apiRouter.get("/autoedit/capabilities", (_req, res) => {
  res.json({
    planner: plannerBackend(), // "anthropic" or "heuristic"
    asr: asrAvailable(), // speech-to-text available for captions?
  });
});

apiRouter.post("/autoedit", (req, res) => {
  try {
    const job = startAutoEdit(req.body || {});
    res.status(202).json({ job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get("/autoedit/:id", (req, res) => {
  const job = getAutoEdit(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ job });
});
