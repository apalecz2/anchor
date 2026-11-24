#!/usr/bin/env node
//
// Diagnostic: what does MinerU2.5's raw GGUF actually say back when sent
// EXACTLY the request the app sends (same system prompt, same user prompt
// wording, same sampling params), via the same llama-server the app uses?
//
// The app reported "The model did not return a parseable table" for the new
// `oar-ocr-mineru2.5-1.2b` preset. Before touching catalog.rs's prompt/parsing
// assumptions a second time, this prints the model's RAW, unprocessed output so
// we can see what format it actually answered in -- exactly the same diagnostic
// posture prototypes/Surya used to recover Surya's real training-time contract,
// rather than guessing again blind.
//
// Usage:
//   node diagnose.mjs [image.png] [--port 8098]

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error("[mineru-diagnose]", ...a);
const die = (msg) => { console.error("[mineru-diagnose] ERROR:", msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ---- exact wire contract the app sends (catalog.rs + client.rs) ----
//
// System prompt: catalog::QWEN_EXTRACT_SYSTEM (reused for MinerU too, see
// PromptId::MinerUExtractSystem -- it's plain English, not Qwen-specific).
const SYSTEM_PROMPT =
  "You are a structured data extractor. " +
  "Begin your response with the very first line of the requested format — no introduction, " +
  "no analysis, no reasoning, no explanation before the data. " +
  "Output only the data itself.";

// User prompt: catalog::QWEN_TSV_EXTRACT (reused as PromptId::MinerUTsvExtract),
// with the trailing "OCR text:\n" marker load-bearing -- spatial OCR text is
// appended directly after it with no separator in the real app. Left blank here
// since the question is whether the model follows the TSV instruction at all,
// not whether specific OCR text confuses it.
const USER_PROMPT =
  "Return only TSV (tab-separated values).\n" +
  "First row must be the column headers.\n" +
  "No reasoning, no explanation, no code fences, no markdown.\n" +
  "Separate each column with a tab character. Do not use commas as delimiters.\n" +
  "If two adjacent values belong to the same visual column (e.g. a department code and a course number), output them as one field joined by a space.\n" +
  "Use the attached image as the primary reference and the OCR text below as a guide.\n" +
  "\n" +
  "OCR text:\n";

// Variant B: show the format instead of describing an invisible character.
// "\t" written literally so the model sees an actual tab byte in the example.
const USER_PROMPT_WITH_EXAMPLE =
  "Extract this table as TSV (tab-separated values). Follow this exact format, " +
  "shown here with a real table of 3 columns and 2 rows (the tab character between " +
  "fields is a real \\t, not the letters t-a-b):\n" +
  "Header1\tHeader2\tHeader3\n" +
  "Value1\tValue2\tValue3\n" +
  "Value4\tValue5\tValue6\n" +
  "\n" +
  "Now do the same for the table in the attached image. Use a real tab character " +
  "between every column, on every row including the header. No markdown, no code " +
  "fences, no explanation before or after the table.";

// Variant C: pipe-delimited -- a visible ASCII character, often followed more
// reliably by small models than an invisible tab byte.
const USER_PROMPT_PIPE =
  "Extract the table in this image as pipe-delimited text: one row per line, " +
  "columns separated by a single \" | \" (space, pipe, space). First line is the " +
  "column headers. No markdown table syntax (no leading/trailing pipes, no --- " +
  "separator row), no code fences, no explanation -- just the delimited rows.\n" +
  "Example of the exact format for a 3-column, 2-row table:\n" +
  "Header1 | Header2 | Header3\n" +
  "Value1 | Value2 | Value3\n" +
  "Value4 | Value5 | Value6";

// Sampling: catalog::MINERU_2_5.request (temperature 0, top_p 1.0, top_k 1,
// presence_penalty 0.0) -- matches what build_request_body actually sends.

function appDataModelsDir() {
  const base =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || path.join(homedir(), "AppData", "Roaming")
        : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "com.aidenpaleczny.anchor", "models", "miner");
}

function appDataLlamaServer() {
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const base =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || path.join(homedir(), "AppData", "Roaming")
        : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "com.aidenpaleczny.anchor", "binaries", exe);
}

function resolveLlamaServer() {
  const override = arg("llama-server", process.env.LLAMA_SERVER);
  if (override) return override;
  const appBin = appDataLlamaServer();
  if (existsSync(appBin)) return appBin;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["llama-server"]);
  if (which.status === 0) return which.stdout.toString().split(/\r?\n/)[0].trim();
  die("No llama-server found. Pass --llama-server <path>.");
}

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
    if (child.exitCode !== null) throw new Error(`llama-server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok && (await res.json().catch(() => null))?.status === "ok") return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("llama-server did not become healthy in time");
}

async function startServer(port) {
  const dir = appDataModelsDir();
  const model = path.join(dir, "MinerU2.5-2509-1.2B.Q8_0.gguf");
  const mmproj = path.join(dir, "MinerU2.5-2509-1.2B.mmproj-f16.gguf");
  if (!existsSync(model) || !existsSync(mmproj)) die(`model files missing in ${dir}`);

  const bin = resolveLlamaServer();
  // Mirrors catalog::MINERU_2_5.launch exactly: ctx 8192, jinja (embedded
  // template, no external chat_template_file), parallel 1, full GPU offload.
  const args = [
    "-m", model,
    "--mmproj", mmproj,
    "-ngl", "99",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", "8192",
    "--parallel", "1",
    "--jinja",
  ];
  log(`spawning: ${bin} ${args.join(" ")}`);
  const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (e) => die(`failed to spawn llama-server: ${e.message}`));
  const cleanup = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  log("waiting for server health…");
  await waitForHealth(port, child);
  log(`server ready on http://127.0.0.1:${port}`);
  return { port, cleanup };
}

function imageDataUrl(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${readFileSync(imagePath).toString("base64")}`;
}

async function askMinerU(port, imagePath, userPrompt) {
  const body = {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl(imagePath) } },
          { type: "text", text: userPrompt },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.0,
    top_p: 1.0,
    top_k: 1,
    presence_penalty: 0.0,
    stream: false,
    logprobs: true,
    top_logprobs: 0,
  };

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    finish: json.choices?.[0]?.finish_reason ?? null,
    usage: json.usage ?? null,
  };
}

async function main() {
  const imagePath =
    process.argv[2] && !process.argv[2].startsWith("--")
      ? process.argv[2]
      : path.join(HERE, "..", "OCR", "sample_invoice.png");
  if (!existsSync(imagePath)) die(`image not found: ${imagePath}`);

  const variant = arg("variant", "app");
  const userPrompt =
    variant === "example" ? USER_PROMPT_WITH_EXAMPLE : variant === "pipe" ? USER_PROMPT_PIPE : USER_PROMPT;

  const port = Number(arg("port", await pickFreePort()));
  const { cleanup } = await startServer(port);
  try {
    log(`asking MinerU about ${imagePath} (variant=${variant})...`);
    const t0 = Date.now();
    const { content, finish, usage } = await askMinerU(port, imagePath, userPrompt);
    log(`returned in ${((Date.now() - t0) / 1000).toFixed(1)}s (finish=${finish}, tokens=${usage?.completion_tokens ?? "?"})`);

    mkdirSync(path.join(HERE, "out"), { recursive: true });
    const outPath = path.join(HERE, "out", "raw_output.txt");
    writeFileSync(outPath, content);
    log(`wrote raw output to ${outPath}`);
    console.log("\n--- RAW MODEL OUTPUT (verbatim, unprocessed) ---\n");
    console.log(content);
    console.log("\n--- END RAW OUTPUT ---\n");
  } finally {
    cleanup();
  }
}

main().catch((e) => die(e.message));
