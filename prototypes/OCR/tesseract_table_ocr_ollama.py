import os
import sys
import json
import urllib.request
from PIL import Image
import pytesseract

# Point this to the gemma model you have locally pulled in Ollama
# e.g., "gemma:4b", "gemma", or "gemma-4-31b-it"
MODEL_NAME = "gemma" 
OLLAMA_URL = "http://localhost:11434/api/generate"

def ocr_and_convert_to_markdown_ollama(image_path: str) -> str:
    """
    Reads an image using Tesseract OCR, then passes the raw text to a local
    Ollama model (Gemma) to intelligently reconstruct it into a Markdown table format.
    """
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image not found at {image_path}. Please provide a valid screenshot of a table.")

    print(f"1. Loading image '{image_path}'...")
    img = Image.open(image_path)

    print("2. Running Tesseract OCR to extract raw text...")
    # Using psm 6: Assume a single uniform block of text to capture spatial lines reasonably well
    custom_config = r'--psm 6'
    try:
        raw_ocr_text = pytesseract.image_to_string(img, config=custom_config)
    except Exception as e:
        print(f"Tesseract Error: {e}")
        print("Note: Ensure you have the Tesseract-OCR system binary installed on your OS (e.g., `brew install tesseract`).")
        sys.exit(1)

    print("-" * 40)
    print("RAW OCR OUTPUT:")
    print(raw_ocr_text.strip() if raw_ocr_text.strip() else "[No text detected]")
    print("-" * 40)
    
    if not raw_ocr_text.strip():
        return "Failed to extract any text from the image."

    print(f"3. Sending raw OCR text to local Ollama ({MODEL_NAME}) to reconstruct into a Markdown Table...")
    prompt = f"""You are a precise data reconstruction AI.
You have been provided with the raw text output from Tesseract OCR run on a screenshot of a complex table (e.g., an invoice or financial statement). 
Because OCR lacks structural grid awareness, the columns and rows might be visually misaligned or wrapped incorrectly.

Your task is to infer the logical table structure and output a clean, perfectly structured Markdown table.
Do NOT output anything other than the Markdown table. No explanation.

Raw OCR Text:
{raw_ocr_text}
"""

    payload = {
        "model": MODEL_NAME,
        "prompt": prompt,
        "stream": False
    }

    try:
        req = urllib.request.Request(
            OLLAMA_URL, 
            data=json.dumps(payload).encode('utf-8'), 
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result.get("response", "[Empty Response]").strip()
            
    except urllib.error.URLError as e:
        print(f"Ollama Connection Error: {e}")
        print("Make sure the Ollama app is running locally on port 11434.")
        return ""
    except Exception as e:
        print(f"Ollama API Error: {e}")
        return ""

if __name__ == "__main__":
    # Point this to a sample image of a table/invoice in the OCR directory
    sample_image = os.path.join(os.path.dirname(__file__), "sample_invoice.png")
    
    # Check if user provided an image as an argument, otherwise use default
    if len(sys.argv) > 1:
        sample_image = sys.argv[1]

    if not os.path.exists(sample_image):
        print(f"⚠️ Please place an image named 'sample_invoice.png' in the {os.path.dirname(__file__)} folder, or pass the image path as an argument:")
        print(f"Usage: python {os.path.basename(__file__)} path/to/your/image.png")
        sys.exit(1)

    final_markdown = ocr_and_convert_to_markdown_ollama(sample_image)
    
    print("\n" + "=" * 40)
    print("FINAL RECONSTRUCTED MARKDOWN TABLE:")
    print("=" * 40)
    print(final_markdown)
    print("=" * 40)
