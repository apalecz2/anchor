#!/usr/bin/env node
//
// Surya OCR 2 — logprobs spike.
//
// Answers the one open question that gates using Surya as a second extraction
// engine: does llama-server return *usable per-token logprobs* for Surya the same
// way it does for Qwen, so the app's confidence heatmap can keep working?
//
// The app's confidence scoring (app/src/features/extraction/confidence.ts) is fed
// by the streamed shape `choices[0].logprobs.content[]`, where each entry carries a
// numeric `logprob`. This script reproduces that exact request + parse against
// Surya and reports whether the contract holds — token count, how many tokens came
// back with a real (non-null) logprob, the value distribution, and whether
// top_logprobs alternatives are present.
//
// It does NOT duplicate the server lifecycle: it spawns `surya.mjs serve` on a
// fixed port (reusing all of that script's binary resolution + health wait), or
// connects to a server you already started with `--connect --port <n>`.
//
// Usage:
//   node logprobs-test.mjs [image.png] [--top-logprobs 5] [--mode ocr]
//   node logprobs-test.mjs ../OCR/sample_invoice.png
//   node logprobs-test.mjs --connect --port 8099 image.png   # use a running server
//
// Passthrough to `surya.mjs serve` when spawning: --models-dir, --llama-server.
//
// Requires: Node 18+ (global fetch). Same llama-server prereqs as surya.mjs.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SURYA = path.join(HERE, "surya.mjs");

// The verbatim training-time prompts, kept in sync with surya.mjs. Default is
// full-page OCR — the mode the app would actually use.
const PROMPTS = {
  ocr: "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).",
  layout:
    'Output the layout of this image as JSON. Each entry is a dict with "label", "bbox", and "count" fields. Bbox is x0 y0 x1 y1, normalized 0-1000.',
  table:
    'Output the table rows then columns as JSON. Each entry is a dict with "label" ("Row" or "Col") and "bbox" (x0 y0 x1 y1, normalized 0-1000).',
};

const SURYA_MAX_TOKENS_FULL_PAGE = 12288; // surya/settings.py default

const log = (...a) => console.error("[logprobs-test]", ...a);
const die = (msg) => {
  console.error("[logprobs-test] ERROR:", msg);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

// First non-flag argument after the script path is the image. Default to the
// README's sample invoice so `node logprobs-test.mjs` just works after a download.
function resolveImage() {
  const args = process.argv.slice(2);
  let img = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Skip the value of value-taking flags so it isn't mistaken for the image.
      if (["top-logprobs", "mode", "port", "models-dir", "llama-server", "max-tokens"].includes(args[i].slice(2))) {
        i++;
      }
      continue;
    }
    img = args[i];
    break;
  }
  return img ?? path.join(HERE, "..", "OCR", "sample_invoice.png");
}

function imageDataUrl(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const b64 = readFileSync(imagePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function waitForHealth(port, child, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`surya.mjs serve exited early (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.status === "ok") return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("server did not become healthy in time");
}

// Spawn `surya.mjs serve --port <port>` so we reuse its binary resolution and
// health-wait logic verbatim, then poll health ourselves before sending the request.
function spawnServer(port) {
  const args = ["serve", "--port", String(port)];
  // Pass through the two flags that affect which binary/models surya.mjs uses.
  for (const f of ["models-dir", "llama-server"]) {
    const v = flag(f, null);
    if (v) args.push(`--${f}`, v);
  }
  log(`spawning: node surya.mjs ${args.join(" ")}`);
  const child = spawn(process.execPath, [SURYA, ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (e) => die(`failed to spawn surya.mjs serve: ${e.message}`));
  return child;
}

// Stream a chat completion with logprobs on, parsing the SAME shape the app reads
// in app/src/features/llama/llamaClient.ts (choices[0].logprobs.content[]).
async function streamWithLogprobs(port, imagePath, mode, topLogprobs, maxTokens) {
  const prompt = PROMPTS[mode] ?? PROMPTS.ocr;
  const body = {
    model: "surya-ocr-2",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl(imagePath) } },
          { type: "text", text: prompt },
        ],
      },
    ],
    temperature: 0.0,
    top_p: 0.1,
    max_tokens: maxTokens,
    stream: true,
    // The contract under test: the app sets these for the Qwen path and relies on
    // choices[].logprobs.content[].logprob being a number for every token.
    logprobs: true,
    top_logprobs: topLogprobs,
  };

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("streaming response body unavailable");

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let finishReason = null;
  /** @type {{token:string, logprob:number|null, top:number}[]} */
  const tokens = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        console.error("stream parse error:", e, data);
        continue;
      }
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const contentLogprobs = choice?.logprobs?.content;
      if (Array.isArray(contentLogprobs) && contentLogprobs.length > 0) {
        for (const entry of contentLogprobs) {
          const tok = entry?.token ?? "";
          if (!tok) continue;
          const logprob = typeof entry?.logprob === "number" ? entry.logprob : null;
          const top = Array.isArray(entry?.top_logprobs) ? entry.top_logprobs.length : 0;
          tokens.push({ token: tok, logprob, top });
          content += tok;
        }
      } else {
        // No logprobs object on this delta — record the visible token with a null
        // logprob so the "missing logprobs" case is visible in the summary.
        const tok = choice?.delta?.content ?? "";
        if (tok) {
          tokens.push({ token: tok, logprob: null, top: 0 });
          content += tok;
        }
      }
    }
  }

  return { content, finishReason, tokens };
}

function summarize({ content, finishReason, tokens }) {
  const withLp = tokens.filter((t) => t.logprob !== null);
  const nullLp = tokens.length - withLp.length;
  const withTop = tokens.filter((t) => t.top > 0).length;
  const values = withLp.map((t) => t.logprob);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;

  // The verdict the spike exists to deliver.
  let verdict;
  if (tokens.length === 0) {
    verdict = "NO OUTPUT — the model returned no tokens (check the image / server).";
  } else if (withLp.length === 0) {
    verdict =
      "FAIL — tokens streamed but NOT ONE carried a numeric logprob. The app's " +
      "confidence heatmap (confidence.ts) would be entirely degraded for Surya.";
  } else if (withLp.length < tokens.length) {
    verdict =
      `PARTIAL — ${withLp.length}/${tokens.length} tokens had a logprob. confidence.ts ` +
      "tolerates null logprobs per token, so this still works but some cells score weaker.";
  } else {
    verdict =
      "PASS — every streamed token carried a numeric logprob in the exact shape the " +
      "app consumes (choices[].logprobs.content[].logprob). Surya is heatmap-compatible.";
  }

  return { withLp: withLp.length, nullLp, withTop, mean, min, max, verdict };
}

async function main() {
  const imagePath = resolveImage();
  if (!existsSync(imagePath)) {
    die(
      `image not found: ${imagePath}\n` +
        "Pass an image path, or download the sample referenced in README " +
        "(../OCR/sample_invoice.png).",
    );
  }

  const mode = flag("mode", "ocr");
  const topLogprobs = Number(flag("top-logprobs", "5"));
  const maxTokens = Number(flag("max-tokens", String(SURYA_MAX_TOKENS_FULL_PAGE)));
  const connect = hasFlag("connect");
  const port = Number(flag("port", connect ? null : "8099"));
  if (!Number.isFinite(port)) die("--connect requires --port <n> of a running server");

  let child = null;
  if (!connect) {
    child = spawnServer(port);
    process.on("exit", () => child && child.exitCode === null && child.kill("SIGTERM"));
    process.on("SIGINT", () => {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      process.exit(130);
    });
  }

  try {
    log(connect ? `connecting to server on :${port}` : "waiting for server health…");
    await waitForHealth(port, child);
    log(`server ready on :${port}`);

    log(`requesting Surya OCR (mode=${mode}) with logprobs=true top_logprobs=${topLogprobs}`);
    const t0 = Date.now();
    const result = await streamWithLogprobs(port, imagePath, mode, topLogprobs, maxTokens);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const s = summarize(result);

    console.error("");
    log(`finished in ${secs}s (finish_reason=${result.finishReason})`);
    log(`total tokens streamed:        ${result.tokens.length}`);
    log(`tokens with numeric logprob:  ${s.withLp}`);
    log(`tokens with null logprob:     ${s.nullLp}`);
    log(`tokens with top_logprobs[]:   ${s.withTop} (requested ${topLogprobs})`);
    if (s.mean !== null) {
      log(`logprob  mean=${s.mean.toFixed(4)}  min=${s.min.toFixed(4)}  max=${s.max.toFixed(4)}`);
    }
    console.error("");
    log("first 15 tokens (token → logprob | #alternatives):");
    for (const t of result.tokens.slice(0, 15)) {
      const shown = JSON.stringify(t.token);
      const lp = t.logprob === null ? "null" : t.logprob.toFixed(4);
      log(`  ${shown.padEnd(14)} → ${lp.padStart(9)} | ${t.top}`);
    }
    console.error("");
    log("VERDICT: " + s.verdict);

    // Persist the full token stream + summary for inspection / regression.
    const outDir = path.join(HERE, "out");
    mkdirSync(outDir, { recursive: true });
    const base = path.basename(imagePath).replace(/\.[^.]+$/, "");
    const outPath = path.join(outDir, `${base}.logprobs.json`);
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          image: imagePath,
          mode,
          topLogprobs,
          maxTokens,
          finishReason: result.finishReason,
          summary: s,
          contentPreview: result.content.slice(0, 1000),
          tokens: result.tokens,
        },
        null,
        2,
      ),
    );
    log(`full token stream written to ${outPath}`);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}

main().catch((e) => die(e.message));
