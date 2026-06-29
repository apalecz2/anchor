#!/usr/bin/env node
//
// Surya OCR 2 — Python-free MVP prototype.
//
// Proves that we can run Datalab's Surya OCR 2 entirely through the same
// `llama-server` (llama.cpp) the main app already installs into AppData — no
// Python, no torch, no vllm, no `surya-ocr` package.
//
// Surya 2 is a single ~650M VLM. Full-page OCR is ONE chat-completion call per
// page (layout + reading order + OCR + tables all in the model output), so the
// only piece that needs Python in the upstream project — the orchestration
// library and the torch text-line detector — is for "block mode", which we don't
// use here. Everything we need is: serve the GGUF with llama-server, POST an
// image + the model's trained prompt to the OpenAI-compatible endpoint, parse the
// returned HTML.
//
// Verbatim contract recovered from the surya source (do not paraphrase the
// prompt — it's a training-time contract):
//   prompt:    "OCR this image to HTML. Each block is a div with data-label and
//               data-bbox (x0 y0 x1 y1, normalized 0-1000)."
//   message:   single user turn, content = [ {image_url: data:image/png;base64},
//               {text: prompt} ]  (no system prompt)
//   sampling:  temperature 0.0, top_p 0.1
//   output:    <div data-label=… data-bbox="x0 y0 x1 y1">…</div> blocks,
//              coords normalized 0–1000; tables as <table>, math as <math>.
//
// Usage:
//   node surya.mjs download                 # fetch the two GGUFs (+ template)
//   node surya.mjs run <image.png|jpg>      # OCR one page, write out/ artifacts
//   node surya.mjs serve                    # just start the server and idle
//
// Requires: Node 18+ (global fetch), curl, and a recent llama-server build with
// multimodal (--mmproj) support.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants — the Surya 2 GGUF contract
// ---------------------------------------------------------------------------

const HF_REPO = "datalab-to/surya-ocr-2-gguf";
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;
const ASSETS = ["surya-2.gguf", "surya-2-mmproj.gguf", "chat_template.jinja"];
const MODEL_FILE = "surya-2.gguf";
const MMPROJ_FILE = "surya-2-mmproj.gguf";

// The four documented prompt modes. Default is full-page OCR (high-accuracy bbox).
const PROMPTS = {
  ocr: "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).",
  layout:
    'Output the layout of this image as JSON. Each entry is a dict with "label", "bbox", and "count" fields. Bbox is x0 y0 x1 y1, normalized 0-1000.',
  block: "OCR this block image to HTML.",
  table:
    'Output the table rows then columns as JSON. Each entry is a dict with "label" ("Row" or "Col") and "bbox" (x0 y0 x1 y1, normalized 0-1000).',
};

const SURYA_MAX_TOKENS_FULL_PAGE = 12288; // surya/settings.py default

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...a) => console.error("[surya]", ...a);
const die = (msg) => {
  console.error("[surya] ERROR:", msg);
  process.exit(1);
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where the GGUFs live. Defaults to ./models next to this script; override with
// --models-dir (e.g. point it at the app's AppData models folder to share).
const modelsDir = () => path.resolve(arg("models-dir", path.join(HERE, "models")));

// ---------------------------------------------------------------------------
// Resolve the llama-server binary
// ---------------------------------------------------------------------------
//
// Reuse, in order of preference:
//   1. --llama-server <path> / $LLAMA_SERVER  (explicit override)
//   2. the binary the main app installed into AppData (the whole point: reuse it)
//   3. `llama-server` on PATH                  (e.g. Homebrew — so this runs today)

function appDataLlamaServer() {
  // Mirrors app/src-tauri/src/paths.rs: identifier com.aidenpaleczny.anchor,
  // binaries/llama-server[.exe].
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  let base;
  if (process.platform === "darwin") {
    base = path.join(homedir(), "Library", "Application Support");
  } else if (process.platform === "win32") {
    base = process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  } else {
    base = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  }
  return path.join(base, "com.aidenpaleczny.anchor", "binaries", exe);
}

function resolveLlamaServer() {
  const override = arg("llama-server", process.env.LLAMA_SERVER);
  if (override) {
    if (!existsSync(override)) die(`llama-server not found at ${override}`);
    return override;
  }
  const appBin = appDataLlamaServer();
  if (existsSync(appBin)) {
    log(`using app-installed llama-server: ${appBin}`);
    return appBin;
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [
    "llama-server",
  ]);
  if (which.status === 0) {
    const p = which.stdout.toString().split(/\r?\n/)[0].trim();
    log(`app binary not found; falling back to PATH llama-server: ${p}`);
    return p;
  }
  die(
    "No llama-server found. Run the app's setup wizard, install llama.cpp " +
      "(brew install llama.cpp), or pass --llama-server <path>.",
  );
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

function download() {
  const dir = modelsDir();
  mkdirSync(dir, { recursive: true });
  for (const name of ASSETS) {
    const dest = path.join(dir, name);
    if (existsSync(dest)) {
      log(`✓ ${name} already present`);
      continue;
    }
    const url = `${HF_BASE}/${name}`;
    log(`downloading ${name} → ${dest}`);
    // curl with resume (-C -) so a dropped connection on the 1.27 GB file resumes.
    const r = spawnSync("curl", ["-L", "-C", "-", "-o", dest, url], {
      stdio: "inherit",
    });
    if (r.status !== 0) die(`download failed for ${name}`);
  }
  log(`done. models in ${dir}`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, child, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited early (code ${child.exitCode})`);
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
  throw new Error("llama-server did not become healthy in time");
}

async function startServer() {
  const dir = modelsDir();
  const model = path.join(dir, MODEL_FILE);
  const mmproj = path.join(dir, MMPROJ_FILE);
  if (!existsSync(model) || !existsSync(mmproj)) {
    die(`model files missing in ${dir}. Run: node surya.mjs download`);
  }

  const bin = resolveLlamaServer();
  const port = Number(arg("port", await pickFreePort()));
  const ngl = arg("ngl", "99"); // tiny model — full GPU offload (Metal/CUDA)
  const ctx = arg("ctx", "32768"); // cheap KV for 650M; room for image + 12k out
  const parallel = arg("parallel", "1");

  // --jinja makes llama-server apply the model's embedded chat template (the one
  // Surya was trained with). The GGUF from datalab embeds it; we still ship
  // chat_template.jinja and pass --chat-template-file as a belt-and-braces fallback.
  const args = [
    "-m", model,
    "--mmproj", mmproj,
    "-ngl", ngl,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", ctx,
    "--parallel", parallel,
    "--alias", "surya-ocr-2",
    "--jinja",
  ];
  const template = path.join(dir, "chat_template.jinja");
  if (existsSync(template)) args.push("--chat-template-file", template);

  log(`spawning: ${bin} ${args.join(" ")}`);
  const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (e) => die(`failed to spawn llama-server: ${e.message}`));

  const cleanup = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  log("waiting for server health…");
  await waitForHealth(port, child);
  log(`server ready on http://127.0.0.1:${port}`);
  return { port, child, cleanup };
}

// ---------------------------------------------------------------------------
// OCR one image
// ---------------------------------------------------------------------------

function imageDataUrl(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const b64 = readFileSync(imagePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function ocrImage(port, imagePath, mode) {
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
    max_tokens: SURYA_MAX_TOKENS_FULL_PAGE,
    stream: false,
  };

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "";
  const finish = json.choices?.[0]?.finish_reason ?? null;
  return { content, finish, usage: json.usage ?? null };
}

// ---------------------------------------------------------------------------
// Parse the HTML block output
// ---------------------------------------------------------------------------
//
// Depth-aware scan over <div>/</div> so a block whose inner content nests a div
// (e.g. a list group) isn't split. Each top-level div is one Surya block. Tables
// (<table>) and math (<math>) live INSIDE a block and aren't divs, so they ride
// along in the block's inner HTML untouched.

function parseBlocks(html) {
  const blocks = [];
  const tagRe = /<div\b([^>]*)>|<\/div>/gi;
  let depth = 0;
  let openAttrs = "";
  let openContentStart = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const isOpen = m[0][1] !== "/";
    if (isOpen) {
      if (depth === 0) {
        openAttrs = m[1];
        openContentStart = tagRe.lastIndex;
      }
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        const inner = html.slice(openContentStart, m.index);
        blocks.push(makeBlock(openAttrs, inner));
      }
      if (depth < 0) depth = 0; // tolerate stray close tags
    }
  }
  return blocks;
}

function makeBlock(attrs, inner) {
  const label = (attrs.match(/data-label\s*=\s*"([^"]*)"/i) || [])[1] ?? "";
  const bboxStr = (attrs.match(/data-bbox\s*=\s*"([^"]*)"/i) || [])[1] ?? "";
  const bbox = bboxStr.trim().split(/\s+/).map(Number);
  const text = inner
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    label,
    bbox: bbox.length === 4 && bbox.every((n) => Number.isFinite(n)) ? bbox : null,
    text,
    html: inner.trim(),
  };
}

// ---------------------------------------------------------------------------
// Outputs: raw HTML, structured JSON, and a visual overlay
// ---------------------------------------------------------------------------

const LABEL_COLORS = {
  Text: "#2563eb",
  SectionHeader: "#dc2626",
  Table: "#16a34a",
  Picture: "#9333ea",
  Figure: "#9333ea",
  PageHeader: "#ea580c",
  PageFooter: "#ea580c",
  ListGroup: "#0891b2",
  Equation: "#db2777",
  Form: "#ca8a04",
  Caption: "#65a30d",
};

function overlayHtml(imagePath, blocks) {
  // bbox is normalized 0–1000 on each axis independently, so positioning boxes by
  // percentage over the <img> is exact regardless of the image's pixel size — no
  // need to decode image dimensions.
  const dataUrl = imageDataUrl(imagePath);
  const boxes = blocks
    .filter((b) => b.bbox)
    .map((b, i) => {
      const [x0, y0, x1, y1] = b.bbox;
      const color = LABEL_COLORS[b.label] || "#475569";
      const style = [
        `left:${x0 / 10}%`,
        `top:${y0 / 10}%`,
        `width:${(x1 - x0) / 10}%`,
        `height:${(y1 - y0) / 10}%`,
        `outline:2px solid ${color}`,
      ].join(";");
      const tip = `${i}: ${b.label}`.replace(/"/g, "&quot;");
      return `<div class="box" style="${style}" title="${tip}"><span style="background:${color}">${tip}</span></div>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Surya overlay</title>
<style>
  body{margin:0;background:#0b0f17;color:#cbd5e1;font:13px/1.4 system-ui}
  .wrap{position:relative;display:inline-block}
  img{display:block;max-width:100%;height:auto}
  .box{position:absolute;box-sizing:border-box}
  .box span{position:absolute;top:-1.3em;left:0;font-size:10px;color:#fff;padding:0 3px;white-space:nowrap;border-radius:2px}
  header{padding:8px 12px}
</style>
<header>Surya OCR 2 — ${blocks.length} blocks. Hover a box for its label.</header>
<div class="wrap"><img src="${dataUrl}">${boxes}</div>`;
}

async function runOcr() {
  const imagePath = process.argv[3];
  if (!imagePath || imagePath.startsWith("--")) {
    die("usage: node surya.mjs run <image.png|jpg> [--mode ocr|layout|table] [--out dir]");
  }
  if (!existsSync(imagePath)) die(`image not found: ${imagePath}`);
  const mode = arg("mode", "ocr");
  const outDir = path.resolve(arg("out", path.join(HERE, "out")));
  mkdirSync(outDir, { recursive: true });

  const { port, cleanup } = await startServer();
  try {
    log(`OCR (${mode}) → ${imagePath}`);
    const t0 = Date.now();
    const { content, finish, usage } = await ocrImage(port, imagePath, mode);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(`model returned in ${secs}s (finish=${finish}, tokens=${usage?.completion_tokens ?? "?"})`);
    if (finish === "length") {
      log("WARNING: hit max_tokens — output likely truncated. Raise --ctx / max_tokens.");
    }

    const base = path.basename(imagePath).replace(/\.[^.]+$/, "");
    const rawPath = path.join(outDir, `${base}.raw.html`);
    writeFileSync(rawPath, content);

    let blocks = [];
    if (mode === "ocr" || mode === "block") {
      blocks = parseBlocks(content);
      writeFileSync(
        path.join(outDir, `${base}.blocks.json`),
        JSON.stringify({ image: imagePath, mode, finish, usage, blocks }, null, 2),
      );
      writeFileSync(path.join(outDir, `${base}.overlay.html`), overlayHtml(imagePath, blocks));
      log(`parsed ${blocks.length} blocks`);
      for (const b of blocks.slice(0, 12)) {
        log(`  [${b.label}] ${b.text.slice(0, 70)}${b.text.length > 70 ? "…" : ""}`);
      }
      if (blocks.length > 12) log(`  …(${blocks.length - 12} more)`);
    } else {
      // layout/table modes return JSON, not div-HTML — just dump it raw.
      log(content.slice(0, 800));
    }

    log("");
    log(`outputs in ${outDir}:`);
    log(`  ${base}.raw.html      (verbatim model output)`);
    if (blocks.length) {
      log(`  ${base}.blocks.json   (structured blocks: label + bbox + text + html)`);
      log(`  ${base}.overlay.html  (open in a browser to see boxes over the page)`);
    }
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const cmd = process.argv[2];
if (cmd === "download") {
  download();
} else if (cmd === "run") {
  runOcr();
} else if (cmd === "serve") {
  startServer().then(({ port }) => {
    log(`idling. POST images to http://127.0.0.1:${port}/v1/chat/completions . Ctrl-C to stop.`);
  });
} else {
  console.error(`Surya OCR 2 — Python-free MVP

Commands:
  node surya.mjs download                       fetch GGUFs into ./models
  node surya.mjs run <image> [--mode ocr|layout|table] [--out dir]
  node surya.mjs serve                          start server and idle

Options:
  --models-dir <dir>     where GGUFs live (default ./models)
  --llama-server <path>  override the binary ($LLAMA_SERVER also works)
  --ngl <n>              GPU layers (default 99)   --ctx <n>  context (default 32768)
  --port <n>             fixed port (default: auto)

Reuses the app-installed llama-server at:
  ${appDataLlamaServer()}
…falling back to PATH if absent.`);
  process.exit(cmd ? 1 : 0);
}
