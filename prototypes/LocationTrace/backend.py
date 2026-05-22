import os
from flask import Flask, jsonify, send_file
from flask_cors import CORS
from PIL import Image
import pytesseract
from pytesseract import Output

app = Flask(__name__)
CORS(app)

# Use the sample invoice from the OCR folder if it exists, otherwise assume it's in the current dir
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OCR_DIR = os.path.join(os.path.dirname(BASE_DIR), "OCR")
loc_image = os.path.join(BASE_DIR, "sample_invoice.png")
ocr_image = os.path.join(OCR_DIR, "sample_invoice.png")

IMAGE_PATH = loc_image if os.path.exists(loc_image) else ocr_image

@app.route('/api/ocr', methods=['GET'])
def get_ocr_data():
    if not os.path.exists(IMAGE_PATH):
        return jsonify({"error": f"Image not found at {IMAGE_PATH}"}), 404
        
    img = Image.open(IMAGE_PATH)
    
    # image_to_data returns a dictionary with spatial data for every recognized word
    ocr_data = pytesseract.image_to_data(img, config='--psm 6', output_type=Output.DICT)
    
    extracted_elements = []
    n_boxes = len(ocr_data['text'])
    
    for i in range(n_boxes):
        text = ocr_data['text'][i].strip()
        # Filter out empty strings and low-confidence reads
        if text and int(ocr_data['conf'][i]) > 10:
            extracted_elements.append({
                "text": text,
                "left": ocr_data['left'][i],
                "top": ocr_data['top'][i],
                "width": ocr_data['width'][i],
                "height": ocr_data['height'][i],
                "conf": ocr_data['conf'][i]
            })
            
    raw_ocr_text = " ".join([elem["text"] for elem in extracted_elements])
    
    return jsonify({
        "raw_ocr_text": raw_ocr_text,
        "elements": extracted_elements
    })

@app.route('/api/image')
def serve_image():
    if not os.path.exists(IMAGE_PATH):
        return "Image not found", 404
    return send_file(IMAGE_PATH)

if __name__ == '__main__':
    print("Starting server on http://127.0.0.1:5000 ...")
    app.run(port=5000, debug=True)
