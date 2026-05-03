import os
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise RuntimeError("GEMINI_API_KEY not set in environment or .env file")

# Initialize the global client
client = genai.Client(api_key=api_key)
MODEL_NAME = "gemini-2.5-flash"

app = Flask(__name__)
# Enable CORS so the local HTML file can communicate with this backend
CORS(app)

def extract_financial_data(source_text: str) -> list[dict]:
    """
    Extracts financial metrics from a given text using Gemini.
    """
    prompt = f"""You are an absolute precision data extraction tool. Extract financial data points from the provided text.
Return ONLY a valid JSON array of objects with the following schema:
[ {{ "id": "1", "entity": "Metric Name", "value": "Extracted string", "char_start": number, "char_end": number }} ]

Extract specifically: "Company Revenue", "Services Revenue", and "Operating Expenses".

CRITICAL: The `char_start` and `char_end` MUST be the exact 0-indexed character positions of the `value` string strictly exactly as it appears in the source text. No explanation, just the raw JSON.

Source text:
{source_text}"""

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                # Enforce JSON output natively
                response_mime_type="application/json",
            )
        )
        
        # Parse and return the JSON
        if response.text:
            data = json.loads(response.text.strip())
            # LLMs struggle with exact character counting. Post-process to guarantee exact indices.
            for item in data:
                val = item.get("value", "")
                if val:
                    exact_start = source_text.find(val)
                    if exact_start != -1:
                        item["char_start"] = exact_start
                        item["char_end"] = exact_start + len(val)
            return data
        return []
        
    except Exception as e:
        print(f"Extraction failed: {e}")
        return []

@app.route('/extract', methods=['POST'])
def extract_endpoint():
    data = request.json
    if not data or 'text' not in data:
        return jsonify({"error": "No text provided in request payload"}), 400
    
    source_text = data['text']
    extracted_data = extract_financial_data(source_text)
    return jsonify(extracted_data)

if __name__ == "__main__":
    print("Starting Gemini Extraction Backend on http://127.0.0.1:5000 ...")
    app.run(host="127.0.0.1", port=5000, debug=True)
