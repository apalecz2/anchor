# app/

React + Tauri source for Artifact. See the [root README](../README.md) for a project overview and the [design doc](../docs/design.md) for architecture details.

## AppData layout (after first-run setup)

```
{AppData}/com.aidenpaleczny.app/
├── binaries/
│   └── llama-server[.exe]
├── tesseract/
│   ├── tesseract[.exe]
│   └── tessdata/
│       └── eng.traineddata
└── models/
    ├── Qwen3.5-4B-Q4_K_M.gguf
    └── mmproj-F16.gguf
```

Nothing is bundled in the installer. The in-app wizard downloads everything here on first launch.

## Project structure

- `src/` -- React frontend
- `src-tauri/` -- Rust backend (Tauri commands, OCR, llama sidecar, setup wizard)

## Dev setup

1. Install prerequisites: https://v2.tauri.app/start/prerequisites/
2. For PDF support, the pdfium dynamic library must be available to the Rust backend (`pdfium-render` binds to the system library at runtime) -- download a binary from https://github.com/bblanchon/pdfium-binaries and place it where the executable can find it. PDF processing fails without it; PNG/JPEG uploads work regardless.
3. `npm install`
4. `npm run tauri dev`

The setup wizard runs on first dev launch (same as production) and places files in the same AppData location. This only needs to happen once.

**Caveats (current state):**

- The wizard's download URLs (`R2_BASE`, HuggingFace fallbacks) are placeholders and SHA-256 digests are unpinned, so real downloads do not work yet -- place files manually at the AppData paths above (see `docs/Tesseract.md`).
- After the wizard completes on a true first run, fully restart the app (not just the webview reload the wizard triggers) so the Rust startup hook can wire Tesseract into `PATH` / `TESSDATA_PREFIX`.

## Build

```bash
npm run tauri build
```

Build on the target OS -- the Rust backend is native and the correct platform binaries must be present in AppData.
