# app/

React + Tauri source for Artifact. See the [root README](../README.md) for a project overview and the [design doc](../docs/design.md) for architecture details.

## AppData layout (after first-run setup)

```
{AppData}/com.aidenpaleczny.artifact/
├── binaries/
│   ├── llama-server[.exe]
│   └── pdfium.dll / libpdfium.dylib   (Windows / macOS; for PDF rendering)
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
2. `npm install`
3. `npm run tauri dev`

The setup wizard runs on first dev launch (same as production) and places files in the same AppData location. This only needs to happen once.

## Build

```bash
npm run tauri build
```

Build on the target OS -- the Rust backend is native and the correct platform binaries must be present in AppData.
