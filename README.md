# Local Data Extraction AI

A fully offline, cross-platform application designed to extract structured data (such as CSVs from tables) out of unstructured documents and images. It runs purely locally to ensure strict privacy for sensitive information.

## Tech Stack
- **Frontend**: React with TypeScript (packaged via Vite)
- **Application Framework**: Tauri (Rust) for performance and cross-platform native binaries
- **AI / ML**: Qwen3.5-4b w/ Vision powered locally by `llama.cpp`
- **OCR Engine**: Tesseract OCR

## Repository Structure
- `app/`: Production-ready application source (React + Tauri). See [app/README.md](app/README.md).
- `prototypes/`: Initial designs for testing feasibility.
- `docs/`: Technical specifications, architectural workflows, and user stories.
- `tests/`
- `scripts/`

## Prerequisites
- Node.js (for React frontend)
- Rust and Cargo (for Tauri backend)
- Tesseract OCR (system installation required)

## Quick Start
To build and run the main application:
```bash
cd app
npm install
npm run tauri dev
```