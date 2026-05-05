# Tesseract OCR Table-to-Markdown Prototype

## Overview
This prototype tests a hybrid pipeline for extracting complex tables (like scanned invoices) into structured formats.
Because raw Optical Character Recognition (OCR) engines like Tesseract struggle significantly with table layouts and bounding box grids, this workflow couples Tesseract OCR with an LLM (Gemini Flash). 

**The Workflow Pipeline:**
1. **Tesseract Extraction:** Run the raw image through Tesseract OCR using `--psm 6` (assume a single uniform block of text) to grab the raw unstructured strings. 
2. **LLM Reconstruction:** Pass the raw textual chaos to the Gemini API, instructing it to logically infer the column/row relationships and format the output strictly as a clean Markdown table. 
3. **Parseable Output:** A valid Markdown table provides standard structured data that can trivially be parsed downstream into CSVs or DataFrames.

## Setup Instructions

### 1. Install System Dependencies
Tesseract requires the system binary to be installed on your OS alongside the Python wrapper.
**On macOS (Homebrew):**
```bash
brew install tesseract
```

*(On Ubuntu you would run `sudo apt install tesseract-ocr`, on Windows download the installer from UB-Mannheim).*

### 2. Install Python Packages
```bash
pip install pytesseract Pillow google-genai python-dotenv
```

### 3. Provide an Image
Grab an image of a complex table (e.g., a screenshot of a PDF invoice or bank statement) and save it in this directory as `sample_invoice.png`.
*(Alternatively, you can pass the path to your image directly when invoking the script).*

### 4. Run the Script
**For Gemini (Cloud):**
```bash
python prototypes/OCR/tesseract_table_ocr.py
```

**For Ollama + Gemma 4 (Local/Offline):**
Ensure the Ollama application is running on your machine and you have pulled a `gemma` model:
```bash
ollama pull gemma
python prototypes/OCR/tesseract_table_ocr_ollama.py
```

*(You can run a specific image by passing its path natively as an argument to either script: `python <script> /path/to/img.png`)*

## Time Complexity Analysis
* **Tesseract OCR (Local):** Dependent on image resolution and engine mode. Tesseract typically runs in `O(P)` where `P` is the number of pixels. Processing a standard 1080p screenshot usually takes `~0.5s to 2s` locally.
* **LLM Reconstruction (Cloud):** Dependent on API latency. For `gemini-1.5-flash-latest`, generating a small Markdown table out of raw text generally takes `~1s to 3s`.
* **Overall Time:** Generating the Markdown table from an image runs between **`1.5 seconds` and `5 seconds`**.