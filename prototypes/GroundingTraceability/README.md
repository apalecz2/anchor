# Grounding & Traceability Prototype

## Overview
This prototype demonstrates the critical **"Grounding & Traceability"** mechanism for an AI-powered data extraction tool. The system allows users to input unstructured text and uses a large language model (Gemini) to extract specific tabular data points (like financial metrics). 

Crucially, it maps the extracted values back to their **exact character intervals** in the original source document. When a user clicks on an extracted data row in the UI, the exact substring that the LLM pulled the information from is highlighted in yellow. This visual feedback loop serves as the foundational "trust and verify" mechanism, ensuring users can quickly trace where the AI got its answers without breaking DOM rendering or encountering off-by-one errors from tokenization.

## Directory of Files
* **`grounding-traceability.html`**: The frontend interface. It contains a mutable text area for adjusting the source document, a trigger button, and UI logic for safely tracking text indices utilizing `document.createTextNode` and `<mark>` tags to prevent DOM injection vulnerabilities.
* **`backend.py`**: A localized Flask REST API (`http://127.0.0.1:5000/extract`). It interfaces between the HTML frontend and the Gemini API. It handles the prompt engineering, enforces the JSON schema, and applies a post-processing heuristic that searches the text natively to correct any index miscounts caused by the LLM's tokenization logic.

## Getting Started

### 1. Initial Setup
The backend requires Python and a few specific libraries to interface with the new Google GenAI SDK and handle the web traffic.

1. Ensure you are running Python 3 (3.10+ recommended).
2. Install the required dependencies:
   ```bash
   pip install flask flask-cors google-genai python-dotenv
   ```
3. In the root of your project directory, create a new file named `.env` and add your active Gemini API key:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

### 2. Running the Prototype

1. **Start the Backend:** In a terminal, run the following command to boot the Flask API.
   ```bash
   python prototypes/GroundingTraceability/backend.py
   ```
   *(You should see it listening on port 5000)*
2. **Open the Frontend:** Open the `prototypes/grounding-traceability.html` file natively in any web browser (Chrome, Firefox, Safari). You do not need a frontend server for this; opening the raw file works perfectly.
3. **Extract Data:** Modify the text in the left panel, and click **"Run Server Extraction"**.
4. **Trace the Data:** Once the items populate on the right, click them to view the live highlight traceability bounding box jump across the text!

## Time Complexity Analysis
*Excluding the network latency of the Gemini API call.*

### Backend Process Time Complexity
1. **JSON Decoding:** `O(R)` where `R` is the character length of the LLM JSON response. 
2. **Exact Indexing Correction Loop:** `O(E * N)` where `E` is the number of extracted entities successfully outputted by the model, and `N` is the total character length of the `source_text`. Python's `string.find()` evaluates in linear time `O(N)` across the document, evaluated once for every parsed entity `E`.
   * *Overall Backend Time Complexity:* **`O(R + (E * N))`**

### Frontend Highlight Rendering Time Complexity
1. **List Rendering (`renderDataList`):** `O(E)` where `E` is the length of the extracted metrics array. Iterates through the data payload exactly once to construct the DOM nodes.
2. **Text Highlighting (`highlightText`):** `O(N)` where `N` is the character length of the `sourceText`. Slicing the string (`slice(0, start)` and `slice(end)`) requires copying character arrays proportional to the total length of the sequence. Then, injecting those text slices sequentially into Text Nodes via the DOM APIs operates in `O(N)` time to traverse and paint the node blocks.
   * *Overall Frontend Trigger Time Complexity:* **`O(N)`** per click interact.