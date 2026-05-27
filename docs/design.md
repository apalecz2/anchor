# System Design Document — Local-First AI Data Extraction Tool

## 1. Executive Summary

This project aims to build a desktop application that acts as a "Cursor for local data extraction." It streamlines the transformation of non‑machine‑readable data (e.g., written notes, image‑based tables, flat PDFs) into structured, machine‑readable formats.

By prioritizing a local‑first architecture, the application guarantees strict data privacy for sensitive information, eliminates recurring API costs, and enables unlimited offline processing. The system relies on human verification instead of tedious manual data entry, using an intelligent split‑screen interface to highlight uncertainties and cross‑reference extracted data.

## 2. Technical Stack

| Component   | Technology                             | Rationale                                                                 |
|-------------|----------------------------------------|---------------------------------------------------------------------------|
| Front-End   | React with TypeScript                  | Robust, type‑safe, highly interactive UI (essential for split‑screen/heatmap features).
| Framework   | Tauri                                  | Lightweight cross‑platform desktop framework with lower overhead than Electron.
| AI Model(s) | Qwen3.5‑4b (w/ Vision), Gemma4:e4b     | Run via llama.cpp; handles vision tasks and OCR validation/cleanup locally.
| OCR Engine  | Tesseract                              | Fallback/baseline text extraction, useful for low‑end systems and verification.

## 3. Core Features & Capabilities

### 3.1 Privacy and Cost Efficiency

- 100% local processing — no data leaves the user’s machine.
- Zero‑cost scaling — unlimited document processing without API bills.

### 3.2 Intelligent Processing & Background Queuing

- Smart routing: detect machine‑readable documents and bypass OCR when possible.
- Background queue: process large batches offline to avoid blocking the UI.
- User‑supplied context: allow users to inject instructions (expected columns, formats) before extraction.

### 3.3 Advanced Verification & UI

- Split‑screen interface: source document on the left, extracted data on the right; interactive highlighting links the two views.
- Confidence heatmap: visually flag low‑confidence regions; support an accept/reject review loop.
- Mathematical confidence mapping: combine LLM token log‑probabilities (llama.cpp) with Tesseract OCR confidences.
- Coordinate transfer: fuzzy sequence matching aligns LLM output to OCR blocks, preserving spatial coordinates for UI highlighting.

## 4. User Stories

| User Persona        | Story                                                                    | Goal / Value                                                          |
|---------------------|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| Non‑Technical User  | "I want to attach large PDFs containing a mix of text and tables."       | Quickly receive clean CSVs for each table without manual entry.       |
| Non‑Technical User  | "I want to upload pictures of my handwritten notes."                    | Effortlessly digitize and use the text.                                |
| Any User           | "I want to click on extracted data and see exactly where it came from."  | Establish trust and simplify verification.                             |
| Any User           | "I want the app to visually flag areas it is unsure about."             | Quickly spot and fix errors without full manual proofreading.           |

## 5. System Requirements & Hardware Adaptability

- Cross‑platform: macOS, Windows, Linux.
- Minimum spec: 8 GB RAM.

Adaptive hardware modes:

- Low‑End Mode: disable vision models; rely on Tesseract + a lightweight ~2B LLM for formatting.
- High‑End Mode: enable full vision models and larger context windows when hardware permits.

- Resource management: dynamically cap/prioritize threads; keep UI thread smooth and leave headroom for OS and other apps.
- Input formats: PDF, PNG, JPEG, and common image/document formats.
- Output formats: CSV, Excel (XLSX), Markdown (MD), plain text (TXT).
- Extensible AI architecture: model‑agnostic interface to support future or user‑supplied models.

## 6. Processing Extraction Pipeline

1. Ingestion & validation
   - User uploads a file; the system validates format and checks for extractable content (filters out irrelevant photos).

2. Smart OCR
   - If non‑machine‑readable: run Tesseract to obtain baseline text and bounding boxes.
   - If machine‑readable: skip OCR and proceed to AI formatting.

3. Context assembly
   - Load the AI model into RAM and construct prompts using the document (vision when available), Tesseract output, and user guidelines.

4. Stateful extraction
   - Process the document; for multi‑page files carry forward context (e.g., column names).

5. Memory unloading
   - Unload the AI model from RAM after processing to free resources (unless queued jobs remain).

6. Human verification
   - Show dual‑pane UI, map fuzzy matches and confidences to render the heatmap, and allow edits.

7. Export
   - Save the verified output in the user’s chosen format.

## 7. Future Roadmap & Optional Features

- Generative edits: prompt‑to‑edit workflow (e.g., "Change all dates to MM/DD/YYYY") with accept/decline diffs.
- Mobile companion app: scan on the go and sync to the desktop queue.
- PDF text overlay: inject an invisible machine‑readable text layer over scanned PDFs to make them searchable.
