// MovieEdit editor — vanilla JS SPA talking to the MovieEdit API.
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const state = { projectId: null, project: null };
const pollers = new Map(); // renderId -> interval

// ---- API helpers --------------------------------------------------------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${method} ${url} → ${res.status}`);
  }
  return res.json();
}

function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => (t.className = "toast"), 3200);
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
function fmtDur(s) {
  if (!s && s !== 0) return "?";
  return `${Number(s).toFixed(1)}s`;
}

// ---- Projects -----------------------------------------------------------
async function loadProjects(selectId) {
  const { projects } = await api("GET", "/api/projects");
  const sel = $("#projectSelect");
  sel.innerHTML = "";
  if (projects.length === 0) {
    sel.appendChild(el("option", null, "No projects yet"));
  }
  for (const p of projects) {
    const o = el("option", null, `${p.name} (${p.width}×${p.height}, ${p.fps}fps)`);
    o.value = p.id;
    sel.appendChild(o);
  }
  const target = selectId || (projects[0] && projects[0].id);
  if (target) {
    sel.value = target;
    await selectProject(target);
  } else {
    state.projectId = null;
    state.project = null;
    renderElements();
    renderRenders([]);
  }
}

async function selectProject(id) {
  state.projectId = id;
  const { project } = await api("GET", `/api/projects/${id}`);
  state.project = project;
  $("#projectMeta").textContent =
    `${project.elements.length} element(s) · canvas ${project.width}×${project.height} · ${project.fps} fps`;
  renderElements();
  await loadRenders();
}

async function createProject() {
  const name = prompt("Project name?", "My video");
  if (name === null) return;
  const { project } = await api("POST", "/api/projects", {
    name: name || "Untitled",
    width: 1920,
    height: 1080,
    fps: 30,
  });
  await loadProjects(project.id);
  toast("Project created");
}

// ---- Assets + upload ----------------------------------------------------
async function loadAssets() {
  const { assets } = await api("GET", "/api/assets");
  const list = $("#assetList");
  list.innerHTML = "";
  if (assets.length === 0) {
    list.appendChild(el("li", "empty", "No media yet — upload a video."));
    return;
  }
  for (const a of assets) {
    const li = el("li", "asset");
    const info = el(
      "div",
      null,
      `<div class="name">${a.originalName}</div>
       <div class="meta">${fmtBytes(a.size)} · ${a.width && a.height ? `${a.width}×${a.height} · ` : ""}${fmtDur(a.duration)}</div>`,
    );
    const actions = el("div", "row");
    const btn = el("button", "btn", "+ Timeline");
    btn.onclick = () => addVideoElement(a);
    const ai = el("button", "btn", "🤖 Auto-edit");
    ai.onclick = () => autoEdit(a);
    actions.append(btn, ai);
    li.append(info, actions);
    list.appendChild(li);
  }
}

// ---- Autonomous highlight editing ---------------------------------------
async function loadCapabilities() {
  try {
    const c = await api("GET", "/api/autoedit/capabilities");
    const cap = $("#aiCaps");
    const planner = c.planner === "anthropic" ? "Claude" : "heuristic";
    cap.textContent = `AI: highlight planner = ${planner} · auto-captions (ASR) = ${c.asr ? "on" : "off"}`;
  } catch {
    /* non-fatal */
  }
}

async function autoEdit(asset) {
  const instruction = prompt(
    "編集指示（例: 5分のハイライトにして。テロップや装飾も文脈にあわせてつけて）",
    "5分のハイライトにして。テロップや装飾も文脈にあわせてつけて。",
  );
  if (instruction === null) return;
  const mins = prompt("目標の長さ（分）", "5");
  if (mins === null) return;
  const subs = document.querySelector(`#assetList`);
  // Optional: let the user pick an uploaded subtitle (.srt/.vtt) asset id.
  const subtitleAssetId = prompt(
    "字幕アセットID（任意・SRT/VTTをアップロード済みなら。無ければ空でOK）",
    "",
  ) || null;

  try {
    const { job } = await api("POST", "/api/autoedit", {
      assetId: asset.id,
      instruction,
      targetSeconds: Math.round(Number(mins) * 60) || 300,
      subtitleAssetId,
    });
    toast("Auto-edit started");
    pollAutoEdit(job.id);
  } catch (e) {
    toast(e.message, true);
  }
}

const autoeditJobs = new Map(); // id -> latest job

function autoeditRowHtml(j) {
  const pct = j.progress || 0;
  let extra = "";
  if (j.projectId && j.status === "complete") {
    extra = `<button class="link-btn" data-open="${j.projectId}" style="color:var(--accent)">open project ▸</button>`;
  }
  const warn = (j.warnings || []).length
    ? `<div class="meta" style="color:var(--muted)">${j.warnings.join(" · ")}</div>`
    : "";
  return `
    <div><span class="status ${j.status}">${j.status}</span> · ${j.message || ""}</div>
    <div class="progressbar"><span style="width:${pct}%"></span></div>
    <div class="meta">planner: ${j.plannerBackend || "?"} · transcript: ${j.transcriptSource || "?"} ${extra}${j.error ? `<span style="color:var(--err)">${j.error}</span>` : ""}</div>
    ${warn}`;
}

function renderAutoedit() {
  const list = $("#autoeditList");
  list.innerHTML = "";
  if (autoeditJobs.size === 0) {
    list.appendChild(el("li", "empty", "No auto-edit jobs. Hit 🤖 Auto-edit on a clip."));
    return;
  }
  for (const j of [...autoeditJobs.values()].reverse()) {
    const li = el("li", "render");
    li.id = `autoedit-${j.id}`;
    li.innerHTML = autoeditRowHtml(j);
    const open = li.querySelector("[data-open]");
    if (open) {
      open.onclick = async () => {
        await loadProjects(open.getAttribute("data-open"));
        toast("Opened generated project");
      };
    }
    list.appendChild(li);
  }
}

function pollAutoEdit(id) {
  const tick = async () => {
    try {
      const { job } = await api("GET", `/api/autoedit/${id}`);
      autoeditJobs.set(id, job);
      renderAutoedit();
      if (job.status === "complete") {
        toast("Auto-edit complete — rendering the reel");
        if (job.projectId) await loadProjects(job.projectId);
        return;
      }
      if (job.status === "failed") {
        toast(`Auto-edit failed: ${job.error}`, true);
        return;
      }
      setTimeout(tick, 1500);
    } catch {
      /* stop polling on error */
    }
  };
  tick();
}

async function uploadFile(file) {
  const list = $("#uploadList");
  const row = el("li", "upload", `<div>${file.name} · ${fmtBytes(file.size)}</div>`);
  const bar = el("div", "progressbar");
  const fill = el("span");
  bar.appendChild(fill);
  row.appendChild(bar);
  list.prepend(row);

  const start = await api("POST", "/api/uploads", {
    filename: file.name,
    size: file.size,
    mimeType: file.type,
  });
  const id = start.uploadId;
  const chunk = start.chunkBytes;
  let received = start.received;

  while (received < file.size) {
    const end = Math.min(received + chunk, file.size);
    const blob = file.slice(received, end);
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      try {
        const res = await fetch(`/api/uploads/${id}?offset=${received}`, {
          method: "PUT",
          body: blob,
        });
        if (res.status === 409) {
          // Offset drifted — resync to server's durable cursor and retry.
          const j = await res.json();
          received = j.received;
          break;
        }
        if (!res.ok) throw new Error(`chunk ${received} → ${res.status}`);
        const j = await res.json();
        received = j.received;
        ok = true;
      } catch (e) {
        if (attempt === 4) {
          row.appendChild(el("div", "hint", `⚠ ${e.message}`));
          toast(`Upload failed: ${e.message}`, true);
          return;
        }
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      }
    }
    fill.style.width = `${Math.round((received / file.size) * 100)}%`;
  }

  await api("POST", `/api/uploads/${id}/complete`);
  row.appendChild(el("div", "hint", "✓ uploaded"));
  toast("Upload complete");
  await loadAssets();
}

// ---- Elements -----------------------------------------------------------
async function addVideoElement(asset) {
  if (!state.projectId) return toast("Create/select a project first", true);
  await api("POST", `/api/projects/${state.projectId}/elements`, {
    type: "video",
    assetId: asset.id,
    start: 0,
    duration: asset.duration || null,
    trackIndex: 0,
    withAudio: true,
  });
  await selectProject(state.projectId);
  toast("Clip added");
}

async function addTextElement() {
  if (!state.projectId) return toast("Create/select a project first", true);
  const text = prompt("Text to overlay?", "Hello, HyperFrames");
  if (!text) return;
  await api("POST", `/api/projects/${state.projectId}/elements`, {
    type: "text",
    text,
    start: 0,
    duration: 3,
    trackIndex: 5,
    fontSize: 96,
    color: "#ffffff",
  });
  await selectProject(state.projectId);
  toast("Text added");
}

function numberField(label, value, onChange, step) {
  const wrap = el("label", null, `${label}`);
  const input = el("input");
  input.type = "number";
  input.value = value;
  if (step) input.step = step;
  input.onchange = () => onChange(Number(input.value));
  wrap.appendChild(input);
  return wrap;
}
function textField(label, value, onChange) {
  const wrap = el("label", null, `${label}`);
  const input = el("input");
  input.type = "text";
  input.value = value;
  input.onchange = () => onChange(input.value);
  wrap.appendChild(input);
  return wrap;
}

async function patchElement(elId, patch) {
  await api("PATCH", `/api/projects/${state.projectId}/elements/${elId}`, patch);
  await selectProject(state.projectId);
}
async function deleteElement(elId) {
  await api("DELETE", `/api/projects/${state.projectId}/elements/${elId}`);
  await selectProject(state.projectId);
}

function renderElements() {
  const list = $("#elementList");
  list.innerHTML = "";
  const project = state.project;
  if (!project) {
    list.appendChild(el("li", "empty", "Select or create a project."));
    return;
  }
  if (project.elements.length === 0) {
    list.appendChild(el("li", "empty", "Add media or text to build your video."));
    return;
  }
  for (const e of project.elements) {
    const li = el("li", "element");
    const label = e.type === "text" ? `“${e.text}”` : e.type;
    li.appendChild(
      el(
        "div",
        "el-head",
        `<span class="tag">${e.type}</span><span>${label}</span>`,
      ),
    );
    const head = li.querySelector(".el-head");
    const del = el("button", "link-btn", "✕ remove");
    del.onclick = () => deleteElement(e.id);
    head.appendChild(del);

    const fields = el("div", "fields");
    fields.append(
      numberField("start (s)", e.start, (v) => patchElement(e.id, { start: v }), "0.1"),
      numberField(
        "duration (s)",
        e.duration ?? "",
        (v) => patchElement(e.id, { duration: v }),
        "0.1",
      ),
      numberField("track", e.trackIndex, (v) => patchElement(e.id, { trackIndex: v })),
    );
    if (e.type === "text") {
      fields.append(
        textField("text", e.text, (v) => patchElement(e.id, { text: v })),
        numberField("font px", e.fontSize, (v) => patchElement(e.id, { fontSize: v })),
        textField("color", e.color, (v) => patchElement(e.id, { color: v })),
      );
    }
    li.appendChild(fields);
    list.appendChild(li);
  }
}

// ---- Preview + render ---------------------------------------------------
function preview() {
  if (!state.projectId) return toast("Nothing to preview", true);
  window.open(`/api/projects/${state.projectId}/preview`, "_blank");
}

async function startRender() {
  if (!state.projectId) return toast("Nothing to render", true);
  try {
    const { render } = await api("POST", `/api/projects/${state.projectId}/render`, {
      quality: "standard",
      format: "mp4",
    });
    toast("Render queued");
    await loadRenders();
    pollRender(render.id);
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadRenders() {
  if (!state.projectId) return renderRenders([]);
  const { renders } = await api("GET", `/api/projects/${state.projectId}/renders`);
  renderRenders(renders);
  for (const r of renders) {
    if (r.status !== "complete" && r.status !== "failed") pollRender(r.id);
  }
}

function pollRender(id) {
  if (pollers.has(id)) return;
  const iv = setInterval(async () => {
    try {
      const { render } = await api("GET", `/api/renders/${id}`);
      updateRenderRow(render);
      if (render.status === "complete" || render.status === "failed") {
        clearInterval(iv);
        pollers.delete(id);
        if (render.status === "complete") toast("Render complete ✓");
        if (render.status === "failed") toast(`Render failed: ${render.error}`, true);
      }
    } catch {
      clearInterval(iv);
      pollers.delete(id);
    }
  }, 1000);
  pollers.set(id, iv);
}

function renderRowHtml(r) {
  const pct = r.progress || 0;
  let action = "";
  if (r.status === "complete" && r.outputFile) {
    action = `<a href="/output/${r.outputFile}" download>⬇ download MP4</a>`;
  }
  return `
    <div><span class="status ${r.status}">${r.status}</span> · ${r.message || ""}</div>
    <div class="progressbar"><span style="width:${pct}%"></span></div>
    <div class="meta">${action}${r.error ? `<span style="color:var(--err)">${r.error}</span>` : ""}</div>`;
}

function updateRenderRow(r) {
  const row = document.getElementById(`render-${r.id}`);
  if (row) row.innerHTML = renderRowHtml(r);
  else loadRenders();
}

function renderRenders(renders) {
  const list = $("#renderList");
  list.innerHTML = "";
  if (!renders || renders.length === 0) {
    list.appendChild(el("li", "empty", "No renders yet."));
    return;
  }
  for (const r of renders) {
    const li = el("li", "render");
    li.id = `render-${r.id}`;
    li.innerHTML = renderRowHtml(r);
    list.appendChild(li);
  }
}

// ---- Wire up ------------------------------------------------------------
$("#newProjectBtn").onclick = createProject;
$("#projectSelect").onchange = (e) => selectProject(e.target.value);
$("#addTextBtn").onclick = addTextElement;
$("#previewBtn").onclick = preview;
$("#renderBtn").onclick = startRender;

$("#fileInput").onchange = (e) => {
  const f = e.target.files[0];
  if (f) uploadFile(f).catch((err) => toast(err.message, true));
  e.target.value = "";
};

const dz = $("#dropzone");
["dragover", "dragenter"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
  }),
);
dz.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f).catch((err) => toast(err.message, true));
});

// Boot.
(async function boot() {
  try {
    await loadCapabilities();
    await loadAssets();
    await loadProjects();
    renderAutoedit();
  } catch (e) {
    toast(e.message, true);
  }
})();
