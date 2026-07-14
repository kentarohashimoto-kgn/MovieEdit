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
    const fontSize = num(el.fontSize, 72);
    const color = esc(el.color || "#ffffff");
    const align = esc(el.align || "center");
    const justify =
      align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    // Fade the text in and out via GSAP (visual-only animation).
    const fade = Math.min(0.6, duration / 4);
    animations.push(
      `tl.fromTo("#${domId} .txt", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: ${fade}, ease: "power2.out" }, ${start});`,
    );
    animations.push(
      `tl.to("#${domId} .txt", { opacity: 0, duration: ${fade} }, ${start + duration - fade});`,
    );
    return (
      `<div id="${domId}" class="clip" ${timing} ` +
      `style="display:flex;align-items:center;justify-content:${justify};padding:0 8%;z-index:${10 + track}">` +
      `<div class="txt" style="font-size:${fontSize}px;color:${color};font-weight:700;text-align:${align};` +
      `text-shadow:0 4px 24px rgba(0,0,0,.45);opacity:0">${esc(el.text)}</div></div>`
    );
  }

  return `<!-- unknown element type: ${esc(el.type)} -->`;
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
