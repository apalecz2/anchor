#!/usr/bin/env node
//
// Surya OCR 2 — table-grid spike (plan P0).
//
// Answers the question the manifest-driven pipeline refactor branches on: can
// Surya supply the table's ROW and COLUMN BANDS directly, so provenance matching
// can stop *inferring* them from word geometry?
//
// Why this matters. app/src/features/extraction/provenance.ts already thinks in
// row bands × column bands — gridMatchPass and verifyEmptyCellsPass both call
// unclaimedWordsInRegion(words, claimed, rowBand, colBand). Today those bands are
// inferred by detectColumnSeparators (a whitespace-channel sweep over word boxes)
// and alignRowsToLines (a Needleman-Wunsch DP). That inference is the subject of
// all six Provenance/Matching post-mortems in docs/issues.md. Surya's `table`
// mode is prompted to return exactly those bands as {label:"Row"|"Col", bbox}.
// If it does, a model-supplied grid replaces the hardest inference step in the
// app with ground truth.
//
// surya.mjs has `--mode table` wired (the prompt is there) but only dumps the raw
// JSON — no parser, and no recorded run. This script is that parser plus a verdict.
//
// What it does, in one server session:
//   1. `table` mode → parse the Row/Col JSON → sorted bands
//   2. `ocr`   mode → parse blocks → pull the <table> HTML's cell text
//   3. intersect Row × Col → cell rectangles
//   4. cross-check the derived grid against the HTML table's real shape
//   5. write an overlay so "do the cells land on the right place" is answerable by eye
//
// Usage:
//   node table-grid-test.mjs [image.png] [--out dir]
//   node table-grid-test.mjs ../OCR/sample_invoice.png
//   node table-grid-test.mjs --connect --port 8099 image.png   # use a running server
//
// Passthrough when spawning: --models-dir, --llama-server.
//
// Requires: Node 18+ (global fetch). Same llama-server prereqs as surya.mjs.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SURYA = path.join(HERE, "surya.mjs");

// Verbatim training-time prompts, kept in sync with surya.mjs. Do not paraphrase.
const PROMPTS = {
  ocr: "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).",
  table:
    'Output the table rows then columns as JSON. Each entry is a dict with "label" ("Row" or "Col") and "bbox" (x0 y0 x1 y1, normalized 0-1000).',
};

const SURYA_MAX_TOKENS_FULL_PAGE = 12288; // surya/settings.py default

const log = (...a) => console.error("[table-grid]", ...a);
const die = (msg) => {
  console.error("[table-grid] ERROR:", msg);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const VALUE_FLAGS = ["port", "models-dir", "llama-server", "out", "max-tokens"];

function resolveImage() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (VALUE_FLAGS.includes(args[i].slice(2))) i++;
      continue;
    }
    return args[i];
  }
  return path.join(HERE, "..", "OCR", "sample_invoice.png");
}

function imageDataUrl(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const b64 = readFileSync(imagePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

// ---------------------------------------------------------------------------
// Server lifecycle — reuse surya.mjs rather than duplicating binary resolution
// ---------------------------------------------------------------------------

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

function spawnServer(port) {
  const args = ["serve", "--port", String(port)];
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

async function ask(port, imagePath, mode, maxTokens) {
  const body = {
    model: "surya-ocr-2",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl(imagePath) } },
          { type: "text", text: PROMPTS[mode] },
        ],
      },
    ],
    temperature: 0.0,
    top_p: 0.1,
    max_tokens: maxTokens,
    stream: false,
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

// ---------------------------------------------------------------------------
// Parse `table` mode — tolerant, because the exact envelope is unverified
// ---------------------------------------------------------------------------
//
// The prompt asks for a list of {label, bbox} dicts, but the model may wrap it in
// a markdown fence or an object. Be liberal: strip fences, take the outermost
// array, and accept a single array-valued property of an object.

function extractJsonArray(raw) {
  let s = raw.trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();

  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(s);
  if (parsed === undefined) {
    // Fall back to the first balanced [...] span in the text.
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start !== -1 && end > start) parsed = tryParse(s.slice(start, end + 1));
  }
  if (parsed === undefined) return { entries: null, shape: "unparseable" };

  if (Array.isArray(parsed)) return { entries: parsed, shape: "array" };
  if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) return { entries: v, shape: `object.${k}` };
    }
  }
  return { entries: null, shape: typeof parsed };
}

const toBbox = (b) => {
  const nums = Array.isArray(b)
    ? b.map(Number)
    : typeof b === "string"
      ? b.trim().split(/[\s,]+/).map(Number)
      : [];
  return nums.length === 4 && nums.every((n) => Number.isFinite(n)) ? nums : null;
};

function parseBands(raw) {
  const { entries, shape } = extractJsonArray(raw);
  const rows = [];
  const cols = [];
  const rejected = [];

  for (const e of entries ?? []) {
    const label = String(e?.label ?? e?.type ?? "").trim().toLowerCase();
    const bbox = toBbox(e?.bbox ?? e?.box);
    if (!bbox) {
      rejected.push(e);
      continue;
    }
    if (label.startsWith("row")) rows.push(bbox);
    else if (label.startsWith("col")) cols.push(bbox);
    else rejected.push(e);
  }

  // Reading order: rows top-to-bottom by y0, columns left-to-right by x0.
  rows.sort((a, b) => a[1] - b[1]);
  cols.sort((a, b) => a[0] - b[0]);
  return { rows, cols, rejected, shape, entryCount: entries?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Parse `ocr` mode — blocks (verbatim from surya.mjs) + the <table> HTML shape
// ---------------------------------------------------------------------------

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
      if (depth === 0) blocks.push(makeBlock(openAttrs, html.slice(openContentStart, m.index)));
      if (depth < 0) depth = 0;
    }
  }
  return blocks;
}

function makeBlock(attrs, inner) {
  const label = (attrs.match(/data-label\s*=\s*"([^"]*)"/i) || [])[1] ?? "";
  const bboxStr = (attrs.match(/data-bbox\s*=\s*"([^"]*)"/i) || [])[1] ?? "";
  const text = inner
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { label, bbox: toBbox(bboxStr), text, html: inner.trim() };
}

const stripTags = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// The real shape of the table as the model itself reported it, used to judge
// whether the Row/Col band counts actually describe this table.
function parseHtmlTable(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length === 0) return null;
  const rows = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) =>
    [...tr[1].matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((td) => stripTags(td[2])),
  );
  const widths = rows.map((r) => r.length);
  return {
    tableCount: tables.length,
    rowCount: rows.length,
    maxCols: widths.length ? Math.max(...widths) : 0,
    modeCols: widths.length
      ? [...widths.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map())].sort(
          (a, b) => b[1] - a[1],
        )[0][0]
      : 0,
    cellCount: widths.reduce((a, b) => a + b, 0),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Derive cells: a Row band gives the vertical extent, a Col band the horizontal.
// ---------------------------------------------------------------------------

function deriveCells(rows, cols) {
  const cells = [];
  rows.forEach((r, ri) =>
    cols.forEach((c, ci) => {
      cells.push({ rowIndex: ri, colIndex: ci, bbox: [c[0], r[1], c[2], r[3]] });
    }),
  );
  return cells;
}

const overlaps = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

// Bands that overlap their neighbours heavily aren't a clean partition, which
// would make cell rectangles ambiguous. Report it rather than assume it away.
function bandHealth(bands, axis) {
  const lo = axis === "row" ? 1 : 0;
  const hi = axis === "row" ? 3 : 2;
  let overlapping = 0;
  let degenerate = 0;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i][hi] - bands[i][lo] <= 0) degenerate++;
    if (i > 0 && overlaps(bands[i - 1][lo], bands[i - 1][hi], bands[i][lo], bands[i][hi]) > 0) {
      overlapping++;
    }
  }
  const outOfRange = bands.filter((b) => b.some((n) => n < 0 || n > 1000)).length;
  return { count: bands.length, overlapping, degenerate, outOfRange };
}

// ---------------------------------------------------------------------------
// Overlay — answers "do the intersections land on the right cells" by eye
// ---------------------------------------------------------------------------

function overlayHtml(imagePath, rows, cols, cells, htmlTable) {
  const dataUrl = imageDataUrl(imagePath);
  const box = (b, style, tip) =>
    `<div class="box" style="left:${b[0] / 10}%;top:${b[1] / 10}%;width:${(b[2] - b[0]) / 10}%;height:${
      (b[3] - b[1]) / 10
    }%;${style}" title="${String(tip).replace(/"/g, "&quot;")}"></div>`;

  const cellBoxes = cells
    .map((c) => box(c.bbox, "outline:1px solid #16a34a;background:rgba(22,163,74,.08)", `r${c.rowIndex} c${c.colIndex}`))
    .join("\n");
  const rowBoxes = rows.map((b, i) => box(b, "outline:1.5px dashed #2563eb", `Row ${i}`)).join("\n");
  const colBoxes = cols.map((b, i) => box(b, "outline:1.5px dashed #db2777", `Col ${i}`)).join("\n");

  return `<!doctype html><meta charset="utf-8"><title>Surya table grid</title>
<style>
  body{margin:0;background:#0b0f17;color:#cbd5e1;font:13px/1.5 system-ui}
  header{padding:10px 14px}
  header b{color:#f1f5f9}
  .legend span{display:inline-block;margin-right:14px}
  .swatch{display:inline-block;width:10px;height:10px;vertical-align:middle;margin-right:4px}
  .wrap{position:relative;display:inline-block}
  img{display:block;max-width:100%;height:auto}
  .box{position:absolute;box-sizing:border-box;pointer-events:auto}
  label{cursor:pointer;margin-right:12px}
</style>
<header>
  <b>Surya table-mode grid</b> — ${rows.length} Row bands × ${cols.length} Col bands = ${cells.length} derived cells.
  ${htmlTable ? `OCR-mode &lt;table&gt; reports ${htmlTable.rowCount} rows × ${htmlTable.modeCols} cols (${htmlTable.cellCount} cells).` : "No &lt;table&gt; found in OCR mode."}
  <div class="legend" style="margin-top:6px">
    <span><i class="swatch" style="background:#16a34a"></i>derived cell</span>
    <span><i class="swatch" style="background:#2563eb"></i>Row band</span>
    <span><i class="swatch" style="background:#db2777"></i>Col band</span>
  </div>
  <div style="margin-top:6px">
    <label><input type="checkbox" checked onchange="document.querySelectorAll('.cell').forEach(e=>e.hidden=!this.checked)"> cells</label>
    <label><input type="checkbox" checked onchange="document.querySelectorAll('.row').forEach(e=>e.hidden=!this.checked)"> rows</label>
    <label><input type="checkbox" checked onchange="document.querySelectorAll('.col').forEach(e=>e.hidden=!this.checked)"> cols</label>
  </div>
</header>
<div class="wrap"><img src="${dataUrl}">
${cellBoxes.replace(/class="box"/g, 'class="box cell"')}
${rowBoxes.replace(/class="box"/g, 'class="box row"')}
${colBoxes.replace(/class="box"/g, 'class="box col"')}
</div>`;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function verdict(bands, htmlTable, rowHealth, colHealth) {
  const { rows, cols } = bands;
  if (rows.length === 0 && cols.length === 0) {
    return {
      outcome: "B",
      text:
        "OUTCOME B — table mode returned no usable Row/Col bands. Surya can ground at block level only; Tesseract stays the grounding default on more hardware tiers.",
    };
  }
  if (rows.length < 2 || cols.length < 2) {
    return {
      outcome: "B",
      text: `OUTCOME B — too few bands to form a grid (${rows.length} Row, ${cols.length} Col). Need at least 2×2. Fall back to block grounding.`,
    };
  }
  if (rowHealth.degenerate || colHealth.degenerate || rowHealth.outOfRange || colHealth.outOfRange) {
    return {
      outcome: "B",
      text: `OUTCOME B — bands are malformed (degenerate rows ${rowHealth.degenerate}, cols ${colHealth.degenerate}; out-of-range rows ${rowHealth.outOfRange}, cols ${colHealth.outOfRange}). Not a usable partition.`,
    };
  }

  if (!htmlTable) {
    return {
      outcome: "A?",
      text: `OUTCOME A (unconfirmed) — ${rows.length}×${cols.length} well-formed bands, but OCR mode returned no <table> to cross-check the shape against. Confirm against the overlay by eye.`,
    };
  }

  const rowDelta = Math.abs(rows.length - htmlTable.rowCount);
  const colDelta = Math.abs(cols.length - htmlTable.modeCols);
  const rowTol = Math.max(1, Math.round(htmlTable.rowCount * 0.1));

  if (rowDelta <= rowTol && colDelta <= 1) {
    return {
      outcome: "A",
      text: `OUTCOME A — ${rows.length}×${cols.length} bands match the model's own <table> shape (${htmlTable.rowCount}×${htmlTable.modeCols}; Δrows ${rowDelta}, Δcols ${colDelta}). Grounding tier "cell" is real: provenance can take the grid from the model instead of inferring it.`,
    };
  }
  return {
    outcome: "A-",
    text: `OUTCOME A- — bands are well-formed (${rows.length}×${cols.length}) but disagree with the model's own <table> shape (${htmlTable.rowCount}×${htmlTable.modeCols}; Δrows ${rowDelta}, Δcols ${colDelta}). Usable as a grid hint, not as ground truth — check the overlay before relying on it.`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const imagePath = resolveImage();
  if (!existsSync(imagePath)) die(`image not found: ${imagePath}`);

  const outDir = path.resolve(flag("out", path.join(HERE, "out")));
  mkdirSync(outDir, { recursive: true });
  const maxTokens = Number(flag("max-tokens", SURYA_MAX_TOKENS_FULL_PAGE));
  const connect = hasFlag("connect");
  const port = Number(flag("port", connect ? 8099 : 8110));

  let child = null;
  if (!connect) child = spawnServer(port);

  try {
    log(`waiting for health on :${port} …`);
    await waitForHealth(port, child);
    log(`server ready. image: ${imagePath}`);

    log("① table mode — asking for Row/Col bands …");
    const t0 = Date.now();
    const tableRes = await ask(port, imagePath, "table", maxTokens);
    log(`   returned in ${((Date.now() - t0) / 1000).toFixed(1)}s (finish=${tableRes.finish}, tokens=${tableRes.usage?.completion_tokens ?? "?"})`);

    log("② ocr mode — asking for blocks + <table> …");
    const t1 = Date.now();
    const ocrRes = await ask(port, imagePath, "ocr", maxTokens);
    log(`   returned in ${((Date.now() - t1) / 1000).toFixed(1)}s (finish=${ocrRes.finish}, tokens=${ocrRes.usage?.completion_tokens ?? "?"})`);

    const bands = parseBands(tableRes.content);
    const blocks = parseBlocks(ocrRes.content);
    const htmlTable = parseHtmlTable(ocrRes.content);
    const cells = deriveCells(bands.rows, bands.cols);
    const rowHealth = bandHealth(bands.rows, "row");
    const colHealth = bandHealth(bands.cols, "col");
    const v = verdict(bands, htmlTable, rowHealth, colHealth);

    const base = path.basename(imagePath).replace(/\.[^.]+$/, "");
    writeFileSync(path.join(outDir, `${base}.table.raw.txt`), tableRes.content);
    writeFileSync(path.join(outDir, `${base}.grid.overlay.html`), overlayHtml(imagePath, bands.rows, bands.cols, cells, htmlTable));
    writeFileSync(
      path.join(outDir, `${base}.grid.json`),
      JSON.stringify(
        {
          image: imagePath,
          verdict: v,
          tableMode: {
            finish: tableRes.finish,
            usage: tableRes.usage,
            parsedShape: bands.shape,
            entryCount: bands.entryCount,
            rowBands: bands.rows,
            colBands: bands.cols,
            rejectedEntries: bands.rejected,
            rowHealth,
            colHealth,
          },
          ocrMode: {
            finish: ocrRes.finish,
            usage: ocrRes.usage,
            blockCount: blocks.length,
            blockLabels: blocks.map((b) => b.label),
            htmlTable,
          },
          derivedCells: cells,
        },
        null,
        2,
      ),
    );

    // ---- report ----
    console.error("");
    log("── table mode ────────────────────────────────");
    log(`   parsed shape      : ${bands.shape} (${bands.entryCount} entries)`);
    log(`   Row bands         : ${rowHealth.count}  (overlapping ${rowHealth.overlapping}, degenerate ${rowHealth.degenerate}, out-of-range ${rowHealth.outOfRange})`);
    log(`   Col bands         : ${colHealth.count}  (overlapping ${colHealth.overlapping}, degenerate ${colHealth.degenerate}, out-of-range ${colHealth.outOfRange})`);
    if (bands.rejected.length) log(`   rejected entries  : ${bands.rejected.length}`);
    log(`   derived cells     : ${cells.length}`);
    log("── ocr mode ──────────────────────────────────");
    log(`   blocks            : ${blocks.length}  [${[...new Set(blocks.map((b) => b.label))].join(", ")}]`);
    if (htmlTable) {
      log(`   <table> shape     : ${htmlTable.rowCount} rows × ${htmlTable.modeCols} cols (${htmlTable.cellCount} cells, ${htmlTable.tableCount} table(s))`);
    } else {
      log("   <table> shape     : none found");
    }
    log(`   whole page = 1 block? ${blocks.length === 1 ? "YES — coarse; block grounding would be very coarse here" : "no"}`);
    console.error("");
    log(`VERDICT: ${v.text}`);
    console.error("");
    log(`outputs in ${outDir}:`);
    log(`  ${base}.table.raw.txt     (verbatim table-mode output)`);
    log(`  ${base}.grid.json         (bands, health, derived cells, verdict)`);
    log(`  ${base}.grid.overlay.html (open in a browser — cells over the page)`);
  } finally {
    if (child) {
      log("stopping server …");
      child.kill();
    }
  }
}

main().catch((e) => die(e.message));
