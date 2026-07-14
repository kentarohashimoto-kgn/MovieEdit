// MovieEdit server entrypoint.
import express from "express";
import path from "node:path";
import {
  config,
  paths,
  ensureDirs,
  configureRenderBinaries,
} from "./config.js";
import { uploadRouter } from "./upload.js";
import { apiRouter } from "./projects.js";
import { getRender } from "./render.js";

ensureDirs();
const bins = configureRenderBinaries();

const app = express();
app.disable("x-powered-by");

// Uploads (raw streamed bodies) — mounted before any global body parser so
// large chunks are never buffered into memory.
app.use("/api/uploads", uploadRouter);

// JSON API.
app.use("/api", apiRouter);

// Render status/list by render id.
app.get("/api/renders/:id", (req, res) => {
  const record = getRender(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json({ render: record });
});

// Static: editor UI, generated compositions (for preview), rendered output.
app.use(express.static(paths.publicDir));
app.use("/compositions", express.static(paths.compositions));
app.use(
  "/output",
  express.static(paths.output, {
    setHeaders: (res, filePath) => {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(filePath)}"`,
      );
    },
  }),
);

app.get("/healthz", (_req, res) => res.json({ ok: true, bins }));

app.listen(config.port, () => {
  console.log(`\nMovieEdit → http://localhost:${config.port}`);
  console.log("Render binaries:");
  console.log(`  ffmpeg   : ${bins.ffmpeg}`);
  console.log(`  ffprobe  : ${bins.ffprobe}`);
  console.log(`  chromium : ${bins.chromium}`);
  console.log(
    `Max upload: ${(config.maxUploadBytes / 1024 / 1024 / 1024).toFixed(1)} GB, ` +
      `chunk ${(config.uploadChunkBytes / 1024 / 1024).toFixed(0)} MB\n`,
  );
});
