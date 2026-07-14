// Tiny JSON-on-disk store for assets and projects.
//
// For an MVP this keeps the moving parts minimal: each asset / project is one
// JSON file. The media itself lives on disk under assets/ and is only referenced
// by path — metadata files stay small no matter how large the videos are.
//
// Swapping this for Postgres/Supabase later means reimplementing these ~10
// functions; nothing else in the app touches the filesystem for metadata.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./config.js";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, obj) {
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f)));
}

// ---- Assets -------------------------------------------------------------
const assetsDir = path.join(paths.data, "assets");

function assetFile(id) {
  return path.join(assetsDir, `${id}.json`);
}

export function createAsset({ originalName, storedPath, size, mimeType, media }) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const asset = {
    id: randomUUID(),
    originalName,
    storedPath,
    size,
    mimeType: mimeType || "application/octet-stream",
    duration: media?.duration ?? null,
    width: media?.width ?? null,
    height: media?.height ?? null,
    hasVideo: media?.hasVideo ?? null,
    hasAudio: media?.hasAudio ?? null,
    createdAt: new Date().toISOString(),
  };
  writeJson(assetFile(asset.id), asset);
  return asset;
}

export function getAsset(id) {
  const file = assetFile(id);
  return fs.existsSync(file) ? readJson(file) : null;
}

export function listAssets() {
  return listJson(assetsDir).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- Projects -----------------------------------------------------------
function projectFile(id) {
  return path.join(paths.projects, `${id}.json`);
}

export function createProject({ name, width = 1920, height = 1080, fps = 30 }) {
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(),
    name: name || "Untitled",
    width,
    height,
    fps,
    elements: [],
    createdAt: now,
    updatedAt: now,
  };
  writeJson(projectFile(project.id), project);
  return project;
}

export function getProject(id) {
  const file = projectFile(id);
  return fs.existsSync(file) ? readJson(file) : null;
}

export function listProjects() {
  return listJson(paths.projects).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  writeJson(projectFile(project.id), project);
  return project;
}

export function deleteProject(id) {
  const file = projectFile(id);
  if (fs.existsSync(file)) fs.rmSync(file);
}
