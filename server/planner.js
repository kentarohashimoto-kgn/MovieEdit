// The "brain" of the auto-editor: given an instruction, a timestamped
// transcript, and the source duration, produce an edit plan — which source
// segments to keep, and what captions/decorations to overlay.
//
// Two backends:
//   - anthropic: Claude (claude-opus-4-8) via the official SDK with structured
//     output. Used when credentials are available. This is what makes captions
//     and highlight selection genuinely context-aware.
//   - heuristic: a deterministic salience scorer that needs no API. Keeps the
//     whole pipeline runnable (and testable) offline, and is the graceful
//     fallback when no key is configured or the API call fails.
//
// Plan shape (also the JSON schema the model must return):
//   {
//     title?: string,
//     targetDurationSec: number,
//     segments: [{
//       sourceStart, sourceEnd, reason,
//       captions:    [{ text, preset, atOffset, duration }],
//       decorations: [{ preset, text, atOffset, duration }]
//     }]
//   }
// atOffset/duration on overlays are relative to the segment's position on the
// final (concatenated) timeline.

const CAPTION_PRESETS = ["caption", "title", "lower-third", "pill"];
const DECOR_PRESETS = ["accent-bar", "vignette", "progress", "corner-label"];

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    targetDurationSec: { type: "number" },
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceStart: { type: "number" },
          sourceEnd: { type: "number" },
          reason: { type: "string" },
          captions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                preset: { type: "string", enum: CAPTION_PRESETS },
                atOffset: { type: "number" },
                duration: { type: "number" },
              },
              required: ["text", "preset", "atOffset", "duration"],
            },
          },
          decorations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                preset: { type: "string", enum: DECOR_PRESETS },
                text: { type: "string" },
                atOffset: { type: "number" },
                duration: { type: "number" },
              },
              required: ["preset", "text", "atOffset", "duration"],
            },
          },
        },
        required: ["sourceStart", "sourceEnd", "reason", "captions", "decorations"],
      },
    },
  },
  required: ["title", "targetDurationSec", "segments"],
};

export function plannerBackend() {
  const forced = process.env.PLANNER;
  if (forced === "heuristic" || forced === "anthropic") return forced;
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? "anthropic"
    : "heuristic";
}

// ---- Anthropic (Claude) planner -----------------------------------------
async function planWithAnthropic({ instruction, transcriptText, durationSec, targetSec }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth / base URL from env

  const system =
    "You are an expert video editor. You select the most compelling moments from a " +
    "long recording and turn them into a tight highlight reel, adding on-screen captions " +
    "(telops) and light decorations that fit the context. Work only from the provided " +
    "transcript timestamps. Keep the total kept duration close to the requested target. " +
    "Captions must be short (a few words), in the transcript's language, and placed to match " +
    "what is being said. Use 'title' for section intros, 'caption' for spoken-word telops, " +
    "'lower-third' for names/labels, 'pill' for short tags. Offsets/durations on overlays are " +
    "relative to each segment's own start on the final timeline.";

  const user =
    `Instruction: ${instruction}\n\n` +
    `Source duration: ${Math.round(durationSec)}s. Target highlight duration: ~${targetSec}s.\n\n` +
    `Transcript (timestamps are absolute source time):\n${transcriptText || "(no transcript available)"}\n\n` +
    "Return an edit plan selecting source segments (sourceStart/sourceEnd in seconds) that total " +
    "roughly the target, each with fitting captions and optional decorations.";

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
    system,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("planner returned no text");
  return JSON.parse(textBlock.text);
}

// ---- Heuristic planner (no API) -----------------------------------------
const SALIENT = /(重要|ポイント|結論|まとめ|理由|なぜ|つまり|例えば|first|важн|because|therefore|result|key|important|finally|summary)/i;

function scoreSegment(seg) {
  const text = seg.text || "";
  const words = text.split(/\s+/).filter(Boolean).length + text.length / 12;
  let score = Math.min(words, 30);
  if (/[?？]/.test(text)) score += 4;
  if (/[!！]/.test(text)) score += 3;
  if (/\d/.test(text)) score += 3; // numbers/stats
  if (SALIENT.test(text)) score += 6;
  return score;
}

function planHeuristicFromTranscript(segments, targetSec, instruction) {
  // Rank by salience, then walk in timeline order accumulating until target.
  const ranked = segments
    .map((s, i) => ({ ...s, i, score: scoreSegment(s) }))
    .sort((a, b) => b.score - a.score);

  const chosen = new Set();
  let total = 0;
  for (const s of ranked) {
    if (total >= targetSec) break;
    const dur = Math.max(2, Math.min(12, s.end - s.start || 4));
    chosen.add(s.i);
    total += dur;
  }

  // Emit in chronological order, merging adjacent picks.
  const picks = [...chosen].sort((a, b) => a - b).map((i) => segments[i]);
  const merged = [];
  for (const s of picks) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.sourceEnd < 1.5) {
      last.sourceEnd = s.end;
      last._texts.push(s.text);
    } else {
      merged.push({ sourceStart: s.start, sourceEnd: s.end, _texts: [s.text] });
    }
  }

  let cursor = 0;
  const segsOut = merged.map((m, idx) => {
    const segLen = m.sourceEnd - m.sourceStart;
    const caption = (m._texts.join(" ") || "").slice(0, 60);
    const seg = {
      sourceStart: m.sourceStart,
      sourceEnd: m.sourceEnd,
      reason: "high-salience passage",
      captions: caption
        ? [{ text: caption, preset: "caption", atOffset: 0.3, duration: Math.max(1.5, segLen - 0.6) }]
        : [],
      decorations: [{ preset: "corner-label", text: `${idx + 1}`, atOffset: 0, duration: Math.min(2, segLen) }],
    };
    cursor += segLen;
    return seg;
  });

  return {
    title: (instruction || "Highlights").slice(0, 40),
    targetDurationSec: targetSec,
    segments: segsOut,
  };
}

function planHeuristicFromDuration(durationSec, targetSec, instruction) {
  // No transcript: sample evenly spaced windows to fill the target.
  const clipLen = 5;
  const count = Math.max(1, Math.round(targetSec / clipLen));
  const step = durationSec / (count + 1);
  const segments = [];
  for (let k = 1; k <= count; k++) {
    const start = Math.max(0, step * k - clipLen / 2);
    const end = Math.min(durationSec, start + clipLen);
    segments.push({
      sourceStart: start,
      sourceEnd: end,
      reason: "evenly-sampled window (no transcript)",
      captions: [{ text: `Highlight ${k}`, preset: "pill", atOffset: 0.2, duration: 2 }],
      decorations: [],
    });
  }
  return { title: (instruction || "Highlights").slice(0, 40), targetDurationSec: targetSec, segments };
}

// ---- Public entry -------------------------------------------------------
export async function planHighlights({ instruction, segments, durationSec, targetSec }) {
  const backend = plannerBackend();
  if (backend === "anthropic") {
    try {
      const { transcriptToText } = await import("./transcript.js");
      const transcriptText = segments && segments.length ? transcriptToText(segments) : "";
      const plan = await planWithAnthropic({ instruction, transcriptText, durationSec, targetSec });
      return { plan, backend: "anthropic" };
    } catch (err) {
      // Fall back rather than fail the whole job.
      const plan =
        segments && segments.length
          ? planHeuristicFromTranscript(segments, targetSec, instruction)
          : planHeuristicFromDuration(durationSec, targetSec, instruction);
      return { plan, backend: "heuristic", warning: `anthropic planner failed: ${err.message}` };
    }
  }
  const plan =
    segments && segments.length
      ? planHeuristicFromTranscript(segments, targetSec, instruction)
      : planHeuristicFromDuration(durationSec, targetSec, instruction);
  return { plan, backend: "heuristic" };
}

export { PLAN_SCHEMA };
