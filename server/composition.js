// Turn a MovieEdit project (a JSON timeline) into a HyperFrames composition:
// a self-contained directory with an index.html the HyperFrames producer can
// render deterministically to MP4.
//
// HyperFrames contract (see HeyGen HyperFrames docs):
//   - A root element carries data-composition-id / data-width / data-height.
//   - Every timed element has class="clip" (so the framework owns its
//     visibility) plus data-start / data-duration / data-track-index.
//   - <video> is muted + playsinline; audio comes from separate <audio> tags.
//   - A paused GSAP timeline is registered on window.__timelines[compositionId].
//     Scripts animate visual props only (opacity/transform) — never visibility,
//     never video.play()/currentTime; the framework drives those.
//
// The same file doubles as an in-browser preview when loaded with ?preview=1:
// a small driver (inert during rendering) walks the timeline on a wall clock so
// the editor can show a rough playback without a full render.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { paths } from "./config.js";
import { getAsset } from "./store.js";

const require = createRequire(import.meta.url);
const COMPOSITION_ID = "main";

// Copy GSAP into the composition so rendering is deterministic and offline —
// no CDN fetch inside headless Chrome at render time.
function vendorGsap(dir) {
  const dest = path.join(dir, "gsap.min.js");
  try {
    const src = require.resolve("gsap/dist/gsap.min.js");
    fs.copyFileSync(src, dest);
    return "gsap.min.js";
  } catch {
    // Fall back to the CDN if the local package isn't present.
    return "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js";
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Link an asset into the composition's media/ dir and return the relative src.
// Symlink first (free for huge files); fall back to copy where symlinks aren't
// allowed.
function linkAsset(mediaDir, asset) {
  const ext = path.extname(asset.storedPath) || "";
  const linkName = `${asset.id}${ext}`;
  const dest = path.join(mediaDir, linkName);
  if (!fs.existsSync(dest)) {
    try {
      fs.symlinkSync(asset.storedPath, dest);
    } catch {
      fs.copyFileSync(asset.storedPath, dest);
    }
  }
  return `media/${linkName}`;
}

function elementDuration(el, asset) {
  const explicit = num(el.duration, 0);
  if (explicit > 0) return explicit;
  if (asset?.duration > 0) return asset.duration;
  return 5;
}

// Build the DOM + GSAP animation lines for one element.
function renderElement(el, asset, src, animations) {
  const start = num(el.start, 0);
  const duration = elementDuration(el, asset);
  const track = num(el.trackIndex, 0);
  const timing = `data-start="${start}" data-duration="${duration}" data-track-index="${track}"`;
  const domId = `el-${el.id}`;

  if (el.type === "video") {
    const nodes = [
      `<video id="${domId}" class="clip" ${timing} src="${esc(src)}" muted playsinline ` +
        `style="width:100%;height:100%;object-fit:${esc(el.fit || "cover")}"></video>`,
    ];
    // A muted <video> plays no sound; add a synced <audio> when the clip keeps audio.
    if (el.withAudio && asset?.hasAudio !== false) {
      nodes.push(
        `<audio id="${domId}-audio" ${timing} data-volume="${num(el.volume, 1)}" src="${esc(src)}"></audio>`,
      );
    }
    return nodes.join("\n      ");
  }

  if (el.type === "image") {
    return `<img id="${domId}" class="clip" ${timing} src="${esc(src)}" style="width:100%;height:100%;object-fit:${esc(el.fit || "cover")}" />`;
  }

  if (el.type === "audio") {
    return `<audio id="${domId}" ${timing} data-volume="${num(el.volume, 1)}" src="${esc(src)}"></audio>`;
  }

  if (el.type === "text") {
    return renderText(el, domId, timing, start, duration, track, animations);
  }

  if (el.type === "decoration") {
    return renderDecoration(el, domId, timing, start, duration, track, animations);
  }

  return `<!-- unknown element type: ${esc(el.type)} -->`;
}

// Text overlays (telops) with named presets. Each returns positioned,
// GSAP-animated HTML; the framework toggles the clip's visibility by timing.
function renderText(el, domId, timing, start, duration, track, animations) {
  const preset = el.preset || "caption";
  const text = esc(el.text);
  const fade = Math.min(0.5, duration / 4);
  const z = 20 + track;

  // Per-preset container layout + inner text styling.
  const presets = {
    title: {
      wrap: `display:flex;align-items:center;justify-content:center;padding:0 8%`,
      inner: `font-size:${num(el.fontSize, 96)}px;font-weight:800;color:${esc(el.color || "#fff")};text-align:center;text-shadow:0 6px 30px rgba(0,0,0,.5)`,
      anim: "y",
    },
    caption: {
      wrap: `display:flex;align-items:flex-end;justify-content:center;padding-bottom:7%`,
      inner: `font-size:${num(el.fontSize, 52)}px;font-weight:700;color:#fff;background:rgba(0,0,0,.6);padding:.35em .7em;border-radius:10px;line-height:1.3;max-width:82%;text-align:center`,
      anim: "yUp",
    },
    "lower-third": {
      wrap: `display:flex;align-items:flex-end;justify-content:flex-start;padding:0 0 8% 6%`,
      inner: `font-size:${num(el.fontSize, 44)}px;font-weight:700;color:#fff;background:linear-gradient(90deg,rgba(91,140,255,.95),rgba(124,91,255,.85));padding:.3em .8em;border-left:6px solid #fff`,
      anim: "xLeft",
    },
    pill: {
      wrap: `display:flex;align-items:flex-start;justify-content:center;padding-top:6%`,
      inner: `font-size:${num(el.fontSize, 40)}px;font-weight:700;color:#111;background:#ffd34e;padding:.25em .9em;border-radius:999px`,
      anim: "scale",
    },
  };
  const p = presets[preset] || presets.caption;

  const from =
    p.anim === "scale"
      ? "{ opacity: 0, scale: 0.8 }"
      : p.anim === "xLeft"
        ? "{ opacity: 0, x: -60 }"
        : p.anim === "yUp"
          ? "{ opacity: 0, y: 30 }"
          : "{ opacity: 0, y: 40 }";
  const to =
    p.anim === "scale"
      ? `{ opacity: 1, scale: 1, duration: ${fade}, ease: "back.out(1.7)" }`
      : `{ opacity: 1, x: 0, y: 0, duration: ${fade}, ease: "power2.out" }`;
  animations.push(`tl.fromTo("#${domId} .txt", ${from}, ${to}, ${start});`);
  animations.push(`tl.to("#${domId} .txt", { opacity: 0, duration: ${fade} }, ${start + duration - fade});`);

  return (
    `<div id="${domId}" class="clip" ${timing} style="${p.wrap};z-index:${z}">` +
    `<div class="txt" style="${p.inner};opacity:0">${text}</div></div>`
  );
}

// Non-text decorations: accent bars, vignettes, progress bars, corner labels.
function renderDecoration(el, domId, timing, start, duration, track, animations) {
  const preset = el.preset || "accent-bar";
  const z = 15 + track;
  const fade = Math.min(0.4, duration / 4);

  if (preset === "vignette") {
    return `<div id="${domId}" class="clip" ${timing} style="z-index:${z};background:radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.5) 100%);pointer-events:none"></div>`;
  }
  if (preset === "accent-bar") {
    animations.push(`tl.fromTo("#${domId} .bar", { scaleX: 0 }, { scaleX: 1, duration: ${fade}, ease: "power2.out" }, ${start});`);
    return `<div id="${domId}" class="clip" ${timing} style="z-index:${z};display:flex;align-items:flex-end"><div class="bar" style="transform-origin:left;height:8px;width:100%;background:linear-gradient(90deg,#5b8cff,#7c5bff)"></div></div>`;
  }
  if (preset === "progress") {
    animations.push(`tl.fromTo("#${domId} .bar", { scaleX: 0 }, { scaleX: 1, duration: ${duration}, ease: "none" }, ${start});`);
    return `<div id="${domId}" class="clip" ${timing} style="z-index:${z};display:flex;align-items:flex-end"><div class="bar" style="transform-origin:left;height:6px;width:100%;background:#ffd34e"></div></div>`;
  }
  // corner-label
  animations.push(`tl.fromTo("#${domId} .lbl", { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: ${fade} }, ${start});`);
  return (
    `<div id="${domId}" class="clip" ${timing} style="z-index:${z};display:flex;align-items:flex-start;justify-content:flex-end;padding:4% 4% 0 0">` +
    `<div class="lbl" style="opacity:0;font-size:32px;font-weight:800;color:#fff;background:rgba(0,0,0,.45);padding:.15em .6em;border-radius:8px">${esc(el.text)}</div></div>`
  );
}

export function compositionDuration(project) {
  let end = 0;
  for (const el of project.elements || []) {
    const asset = el.assetId ? getAsset(el.assetId) : null;
    end = Math.max(end, num(el.start, 0) + elementDuration(el, asset));
  }
  return end > 0 ? end : 5;
}

// Write compositions/<projectId>/index.html (+ linked media) and return where.
export function buildComposition(project) {
  const dir = path.join(paths.compositions, project.id);
  const mediaDir = path.join(dir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const width = num(project.width, 1920);
  const height = num(project.height, 1080);
  const total = compositionDuration(project);
  const gsapSrc = vendorGsap(dir);

  const animations = [];
  const body = (project.elements || [])
    .slice()
    .sort((a, b) => num(a.trackIndex) - num(b.trackIndex))
    .map((el) => {
      const asset = el.assetId ? getAsset(el.assetId) : null;
      const src = asset ? linkAsset(mediaDir, asset) : "";
      return "      " + renderElement(el, asset, src, animations);
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${esc(project.name)}</title>
    <script src="${gsapSrc}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      body { font-family: "Inter", system-ui, sans-serif; }
      #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; }
      /* HyperFrames toggles .clip visibility from data-start/data-duration. */
      .clip { position: absolute; top: 0; left: 0; width: 100%; height: 100%; visibility: hidden; }
    </style>
  </head>
  <body>
    <div
      id="stage"
      data-composition-id="${COMPOSITION_ID}"
      data-start="0"
      data-duration="${total}"
      data-width="${width}"
      data-height="${height}"
    >
${body || "      <!-- empty timeline -->"}
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
${animations.map((a) => "      " + a).join("\n")}
      window.__timelines["${COMPOSITION_ID}"] = tl;
    </script>

    <!-- Browser-only preview driver. Inert during HyperFrames rendering
         (renderer loads index.html without ?preview=1). -->
    <script>
      (function () {
        if (!/[?&]preview=1(&|$)/.test(location.search)) return;
        var TOTAL = ${total};
        var timeline = window.__timelines["${COMPOSITION_ID}"];
        var clips = Array.prototype.slice.call(document.querySelectorAll(".clip[data-start]"));
        var media = Array.prototype.slice.call(document.querySelectorAll("video, audio"));
        media.forEach(function (m) { m.muted = m.tagName === "VIDEO"; });
        var startedAt = null;
        function frame(now) {
          if (startedAt === null) startedAt = now;
          var t = ((now - startedAt) / 1000) % TOTAL;
          clips.forEach(function (c) {
            var s = parseFloat(c.getAttribute("data-start")) || 0;
            var d = parseFloat(c.getAttribute("data-duration")) || 0;
            c.style.visibility = t >= s && t < s + d ? "visible" : "hidden";
          });
          media.forEach(function (m) {
            var s = parseFloat(m.getAttribute("data-start")) || 0;
            var d = parseFloat(m.getAttribute("data-duration")) || 0;
            if (t >= s && t < s + d) {
              var local = t - s;
              if (Math.abs((m.currentTime || 0) - local) > 0.3) {
                try { m.currentTime = local; } catch (e) {}
              }
              if (m.paused) m.play().catch(function () {});
            } else if (!m.paused) {
              m.pause();
            }
          });
          if (timeline) timeline.time(t);
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      })();
    </script>
  </body>
</html>
`;

  fs.writeFileSync(path.join(dir, "index.html"), html);
  return { dir, entryFile: "index.html", duration: total };
}
