import os
import sys
from PIL import Image
import pytesseract
from google import genai
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise RuntimeError("GEMINI_API_KEY not set. Please add it to your .env file.")

# Initialize Gemini Client
client = genai.Client(api_key=api_key)
MODEL_NAME = "gemini-2.5-flash"

def ocr_and_convert_to_markdown(image_path: str) -> str:
    """
    Reads an image using Tesseract OCR, then passes the raw text to Gemini
    to intelligently reconstruct it into a Markdown table format.
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

    print("3. Sending raw OCR text to Gemini to reconstruct into a Markdown Table...")
    prompt = f"""You are a precise data reconstruction AI.
You have been provided with the raw text output from Tesseract OCR run on a screenshot of a complex table (e.g., an invoice or financial statement). 
Because OCR lacks structural grid awareness, the columns and rows might be visually misaligned or wrapped incorrectly.

Your task is to infer the logical table structure and output a clean, perfectly structured Markdown table.
Do NOT output anything other than the Markdown table.

Raw OCR Text:
{raw_ocr_text}
"""

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
        )
        return response.text.strip() if response.text else "[Empty Response]"
    except Exception as e:
        print(f"Gemini API Error: {e}")
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

    final_markdown = ocr_and_convert_to_markdown(sample_image)
    
    print("\n" + "=" * 40)
    print("FINAL RECONSTRUCTED MARKDOWN TABLE:")
    print("=" * 40)
    print(final_markdown)
    print("=" * 40)
