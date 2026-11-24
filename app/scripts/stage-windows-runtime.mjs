#!/usr/bin/env node
// Stages the DLLs Anchor.exe needs at load time but that a fresh Windows install
// doesn't have, into src-tauri/windows-runtime/, which tauri.windows.conf.json
// bundles next to Anchor.exe. Runs as Tauri's `beforeBundleCommand` (after the
// cargo build, before the installer is assembled).
//
// Why bundle rather than download in the setup wizard: these DLLs are in
// Anchor.exe's *static* import table, so the Windows loader must resolve them
// before any Anchor code — wizard included — can run. Missing means the app
// never starts. Today that's:
//   - DirectML.dll — ONNX Runtime (oar-ocr) links against it. ort-sys's build
//     script drops a symlink to it next to the exe in target/, which is why dev
//     and `target\release\Anchor.exe` always worked. Windows ships an in-box
//     System32\DirectML.dll, but it's DirectML 1.0, far older than the 1.15 build
//     ORT was compiled against — the app-local copy is what must load.
//   - msvcp140.dll / msvcp140_1.dll (+ their vcruntime140*.dll deps) — ONNX
//     Runtime's C++ code uses the dynamic MSVC C++ runtime. Present only where the
//     Visual C++ Redistributable was installed, so absent on a clean machine.
//     Sourced from Visual Studio's own redist folder (the files Microsoft licenses
//     for app-local redistribution), never from System32.
//
// Rather than hardcoding that list, this walks the import tables (exe, then each
// staged DLL) and classifies every dependency. Anything that is neither Windows
// in-box nor stageable fails the build — so a new native dependency can't
// silently ship an installer that won't launch on a fresh machine.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXE_NAME = 'Anchor.exe'; // [[bin]] name in src-tauri/Cargo.toml
const SRC_TAURI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const STAGE_DIR = path.join(SRC_TAURI, 'windows-runtime');
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

// The MSVC runtime DLLs. Never treated as in-box even when System32 has them
// (that only means *this* machine installed the redistributable).
const VC_RUNTIME = /^(msvcp140(_\d+|_atomic_wait|_codecvt_ids)?|vcruntime140(_1|_threads)?|concrt140|vccorlib140|vcomp140|vcamp140)\.dll$/i;
// API sets resolve virtually inside the loader; they're never real files to ship.
const API_SET = /^(api|ext)-ms-/i;

function fail(msg) {
    console.error(`\n[stage-windows-runtime] ERROR: ${msg}\n`);
    process.exit(1);
}

/** Names of all DLLs in a PE file's import + delay-import tables. */
export function readImports(file) {
    const b = fs.readFileSync(file);
    if (b.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file} is not a PE file`);
    const pe = b.readUInt32LE(0x3c);
    if (b.readUInt32LE(pe) !== 0x4550) throw new Error(`${file} has no PE signature`);
    const nsec = b.readUInt16LE(pe + 6);
    const optSize = b.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const dataDirs = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96); // PE32+ : PE32
    const sections = opt + optSize;
    const rvaToOffset = (rva) => {
        for (let i = 0; i < nsec; i++) {
            const s = sections + 40 * i;
            const virtualSize = b.readUInt32LE(s + 8);
            const va = b.readUInt32LE(s + 12);
            const rawSize = b.readUInt32LE(s + 16);
            if (rva >= va && rva < va + Math.max(virtualSize, rawSize)) return rva - va + b.readUInt32LE(s + 20);
        }
        throw new Error(`${file}: RVA 0x${rva.toString(16)} is outside every section`);
    };
    const cString = (o) => {
        let e = o;
        while (b[e] !== 0) e++;
        return b.toString('ascii', o, e);
    };
    const names = [];
    // [data directory index, descriptor size, offset of the name RVA in a descriptor]
    for (const [dir, size, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
        const rva = b.readUInt32LE(dataDirs + dir * 8);
        if (!rva) continue;
        for (let o = rvaToOffset(rva); ; o += size) {
            const nameRva = b.readUInt32LE(o + nameAt);
            if (!nameRva) break;
            names.push(cString(rvaToOffset(nameRva)));
        }
    }
    return names;
}

/** The cargo output dir holding the Anchor.exe that is about to be bundled. */
function findExeDir() {
    const targetRoot = process.env.CARGO_TARGET_DIR
        ? path.resolve(process.env.CARGO_TARGET_DIR)
        : path.join(SRC_TAURI, 'target');
    const profile = process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release';
    const candidates = [path.join(targetRoot, profile)];
    if (process.env.TAURI_ENV_TARGET_TRIPLE) {
        candidates.unshift(path.join(targetRoot, process.env.TAURI_ENV_TARGET_TRIPLE, profile));
    }
    // With and without --target both leave an exe behind; the one just built is newest.
    const built = candidates
        .map((dir) => ({ dir, exe: path.join(dir, EXE_NAME) }))
        .filter(({ exe }) => fs.existsSync(exe))
        .sort((a, b) => fs.statSync(b.exe).mtimeMs - fs.statSync(a.exe).mtimeMs);
    if (!built.length) fail(`no ${EXE_NAME} found in: ${candidates.join(', ')}`);
    return built[0].dir;
}

/** Visual Studio's x64 CRT redist folder, e.g. …\VC\Redist\MSVC\14.51.36231\x64\Microsoft.VC145.CRT */
function findVcRedistDir() {
    const fromEnv = process.env.ANCHOR_VC_REDIST_DIR;
    if (fromEnv) return fromEnv;

    const roots = [];
    if (process.env.VCToolsRedistDir) roots.push(process.env.VCToolsRedistDir);
    const vswhere = path.join(
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        'Microsoft Visual Studio', 'Installer', 'vswhere.exe',
    );
    if (fs.existsSync(vswhere)) {
        // Deliberately no `-prerelease`: Microsoft's distributable list excludes files from
        // pre-release/preview installs, so only a release-channel Visual Studio may be the source.
        const out = execFileSync(vswhere, [
            '-latest', '-products', '*',
            '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
            '-property', 'installationPath',
        ], { encoding: 'utf8' }).trim();
        const msvc = out && path.join(out.split(/\r?\n/)[0], 'VC', 'Redist', 'MSVC');
        if (msvc && fs.existsSync(msvc)) {
            const versions = fs.readdirSync(msvc)
                .filter((v) => /^\d+(\.\d+)+$/.test(v))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            roots.push(...versions.map((v) => path.join(msvc, v)));
        }
    }
    for (const root of roots) {
        const x64 = path.join(root, 'x64');
        if (!fs.existsSync(x64)) continue;
        const crt = fs.readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/i.test(d));
        if (crt) return path.join(x64, crt);
    }
    return null;
}

function main() {
    if (process.platform !== 'win32') {
        console.log('[stage-windows-runtime] not Windows — nothing to stage');
        return;
    }

    const exeDir = findExeDir();
    const exe = path.join(exeDir, EXE_NAME);
    let vcRedistDir; // resolved lazily — only needed if something imports the C++ runtime

    fs.mkdirSync(STAGE_DIR, { recursive: true });
    for (const f of fs.readdirSync(STAGE_DIR)) fs.rmSync(path.join(STAGE_DIR, f), { recursive: true, force: true });

    const staged = new Map(); // lowercase name -> source path
    const inBox = new Set();
    const queue = [exe];
    const seen = new Set();

    while (queue.length) {
        const file = queue.shift();
        for (const dll of readImports(file)) {
            const key = dll.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            if (API_SET.test(dll)) continue;

            let source = null;
            if (VC_RUNTIME.test(dll)) {
                if (vcRedistDir === undefined) vcRedistDir = findVcRedistDir();
                if (!vcRedistDir) {
                    fail(`${dll} (MSVC C++ runtime) is required but no Visual Studio redist folder was found. ` +
                        'Install the MSVC build tools, or set ANCHOR_VC_REDIST_DIR to a ' +
                        '...\\VC\\Redist\\MSVC\\<ver>\\x64\\Microsoft.VC14x.CRT folder.');
                }
                source = path.join(vcRedistDir, dll);
                if (!fs.existsSync(source)) fail(`${dll} is required but missing from ${vcRedistDir}`);
            } else if (fs.existsSync(path.join(exeDir, dll))) {
                // Placed beside the exe by a build script (ort-sys puts DirectML.dll here).
                // Checked before System32 on purpose: the in-box DirectML.dll is too old.
                source = fs.realpathSync(path.join(exeDir, dll));
            } else if (fs.existsSync(path.join(SYSTEM32, dll))) {
                inBox.add(dll);
                continue;
            } else {
                fail(`${path.basename(file)} imports ${dll}, which is not part of Windows, not an MSVC runtime ` +
                    `DLL, and not present in ${exeDir}. The installed app would fail to launch.`);
            }

            const dest = path.join(STAGE_DIR, path.basename(source).toLowerCase() === key ? path.basename(source) : dll);
            fs.copyFileSync(source, dest);
            staged.set(key, source);
            queue.push(dest);
        }
    }

    console.log(`[stage-windows-runtime] ${EXE_NAME}: ${exe}`);
    if (!staged.size) {
        console.log('[stage-windows-runtime] no non-Windows DLLs required');
    }
    for (const [name, source] of staged) console.log(`  staged ${name.padEnd(20)} <- ${source}`);
    console.log(`  in-box (not bundled): ${[...inBox].sort().join(', ')}`);
}

// Only run when executed directly, so readImports can be imported (e.g. for checks).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
