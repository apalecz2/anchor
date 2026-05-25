# Location Traceability Prototype

## Overview
This prototype demonstrates spatial traceability for data extraction using Optical Character Recognition (OCR). When extracting text from images or scanned documents (like invoices), it is critical for users to be able to trace where a specific piece of text was extracted from physically on the page.

The prototype uses **Tesseract OCR** to process an image and extract not only the text, but the `(x, y, width, height)` bounding box coordinates for every recognized word. In the frontend, users can click on any extracted word to highlight its exact spatial location over the original document image. It uses fuzzy matching (Levenshtein distance) and sequence ordering to map the clicked text block back to its most likely bounding box on the rendered image canvas.

## Directory of Files
* **`frontend.html`**: The frontend interface. It displays the original image on the left and the extracted text items on the right. Clicking a text item triggers a fuzzy search against the backend's spatial payload, rendering an absolute-positioned highlight box over the source image.
* **`backend.py`**: A Flask REST API (`http://127.0.0.1:5000/api/ocr`). It processes the local `sample_invoice.png` image using `pytesseract.image_to_data`, extracting text strings alongside their coordinate positions and confidence scores. It serves both the original image and the coordinate metadata payload to the frontend.

## Getting Started

### 1. Initial Setup
The backend requires Python and Tesseract OCR installed on your system.

1. **Install Tesseract System Binary:**
   * **macOS:** `brew install tesseract`
   * **Ubuntu:** `sudo apt install tesseract-ocr`
   * **Windows:** Download the UB-Mannheim installer.

2. **Install Python Dependencies:**
   Ensure you are using Python 3, then install the required libraries:
   ```bash
   pip install flask flask-cors Pillow pytesseract
   ```

### 2. Running the Prototype

1. **Start the Backend:** In a terminal, navigate to this directory (or the project root) and run the Flask API:
   ```bash
   python prototypes/LocationTrace/backend.py
   ```
   *(The server will start on port 5000 and perform OCR on the image. This may take a moment.)*

2. **Open the Frontend:** Open the `prototypes/LocationTrace/frontend.html` file natively in any web browser (Chrome, Firefox, Safari). The frontend will automatically query `localhost:5000` to load the image and the text payload.

3. **Trace Locations:** In the right panel ("Output Verification"), click on any text block. You will see a yellow bounding box appear on the left panel, pinpointing exactly where the engine recognized that text on the original image!

## Time Complexity Analysis

### Backend Processing (Tesseract OCR)
* **OCR Execution:** `O(P)` where `P` is the number of pixels in the source image. Tesseract runtime roughly scales linearly with image resolution.

### Frontend Interaction
* **Fuzzy Matching (`findBestMatch`):** `O(E * L^2)` where `E` is the total number of extracted word elements and `L` is the average character length of a word. When a word is clicked, the script iterates through all OCR elements to compute the Levenshtein distance, mapping character matrices of size `L x L`.
* **Bounding Box Rendering:** `O(E)` where `E` is the number of elements. Re-rendering or scaling the DOM overlay elements on window resize runs in linear time based on total word count.
