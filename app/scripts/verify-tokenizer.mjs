/**
 * Verify that the delimiters used in pipe-format table extraction tokenize
 * cheaply in the Qwen3.5 tokenizer (§9 of ocr-llm-cell-provenance.md).
 *
 * Run while the llama server is running:
 *   node scripts/verify-tokenizer.mjs
 *
 * Confirmed results for Qwen3.5-4B (run 2026-06-05):
 *   \t         → 1 token  [197]             ✓ single-token delimiter
 *   \n         → 1 token  [198]             ✓ single-token delimiter
 *   |          → 1 token  [91]              ✓ single-token delimiter
 *   \|         → 2 tokens [59, 91]          ✓ backslash(59) + pipe(91) — not pathological
 *   \\         → 1 token  [3312]            ✓ merged into one token
 *   |1         → 2 tokens [91, 16]          ✓ pipe + digit
 *   |12        → 3 tokens [91, 16, 17]      ✓ pipe + digit + digit (each digit is separate)
 *   |123       → 4 tokens [91, 16, 17, 18]  ✓ pipe + 3 digits
 *   \t\n       → 1 token  [1517]            ✓ merged — appears only at row boundaries anyway
 *   -1         → 2 tokens [12, 16]          ✓ image-only sentinel
 *
 * Key finding: Qwen3.5 tokenizes each decimal digit as its own token. The spec's
 * claim of "~1 extra token for |wordId" was optimistic — it's 2 tokens for
 * single-digit IDs (0-9) and 3 tokens for two-digit IDs (10-99). Both are still
 * far cheaper than JSON scaffolding (~5-8 tokens/cell). The design stands;
 * no exotic-delimiter swap is needed.
 *
 * Revised per-cell budget: value(1-4) + pipe(1) + digits(1-3) + delimiter(1) ≈ 4-9
 * → TOKENS_PER_CELL = 8 in computeMaxTokens() remains a valid generous estimate.
 */

const SERVER = "http://127.0.0.1:8080";

async function tokenize(text) {
    const res = await fetch(`${SERVER}/tokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, add_special: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from /tokenize`);
    const { tokens } = await res.json();
    return tokens;
}

function repr(s) {
    return JSON.stringify(s);
}

async function main() {
    console.log(`Connecting to llama server at ${SERVER} …\n`);

    try {
        const health = await fetch(`${SERVER}/health`);
        if (health.status !== 200) throw new Error(`health status ${health.status}`);
    } catch (e) {
        console.error("Server not reachable — start llama-server first.\n", e.message);
        process.exit(1);
    }

    // Bounds reflect actual Qwen3.5 behavior: each digit is a separate token.
    const cases = [
        // [label, string, maxTokens, description]
        ["tab",            "\t",           1, "cell separator — must be 1 token"],
        ["newline",        "\n",           1, "row separator — must be 1 token"],
        ["pipe",           "|",            1, "value/wordId separator — must be 1 token"],
        ["escaped pipe",   "\\|",          2, "must be ≤ 2 tokens (not pathological)"],
        ["escaped bslash", "\\\\",         2, "must be ≤ 2 tokens"],
        ["pipe+digit",     "|1",           2, "single-digit wordId (IDs 0-9)"],
        ["pipe+2digits",   "|12",          3, "two-digit wordId: pipe(1) + digit(1) + digit(1)"],
        ["pipe+3digits",   "|123",         4, "three-digit wordId: pipe(1) + 3 digits"],
        ["-1 sentinel",    "-1",           2, "image-only wordId sentinel"],
        ["tab+newline",    "\t\n",         2, "delimiter pair — not expected together but sanity check"],
        ["sample cell",    "INV-001|12",  10, "realistic cell — generous sanity budget"],
    ];

    let allPassed = true;

    for (const [label, str, max, description] of cases) {
        let tokens;
        try {
            tokens = await tokenize(str);
        } catch (e) {
            console.error(`  ERROR  ${label}: ${e.message}`);
            allPassed = false;
            continue;
        }
        const count = tokens.length;
        const pass = count <= max;
        allPassed = allPassed && pass;
        const mark = pass ? "PASS" : "FAIL";
        const ids = tokens.join(", ");
        console.log(`  ${mark}  ${label.padEnd(16)} ${repr(str).padEnd(12)} → ${String(count).padStart(2)} token(s) [${ids}]  (max ${max})  ${description}`);
    }

    console.log("");
    if (allPassed) {
        console.log("All checks passed.");
        console.log("Delimiters are single tokens; \\| is 2 tokens (not pathological).");
        console.log("No exotic-delimiter swap needed (§9).");
    } else {
        console.log("Some checks FAILED. Review counts above — bounds may need updating for this model version.");
        process.exit(1);
    }
}

main();
