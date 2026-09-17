"""Quick spike: does RapidOCR give per-word text + box + confidence that could
stand in for Tesseract's OcrWord output (app/src-tauri/src/ocr.rs), and is it
more accurate on pages where Tesseract struggles?

Usage:
    python rapid_ocr_test.py [image_path]

With no argument, runs against ../OCR/sample_invoice.png. See README.md for
output format and what to compare against Tesseract.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Mirrors app/src-tauri/src/ocr.rs exactly: UPSCALE_NARROW_SIDE_THRESHOLD and
# the 2.0 factor in upscale_factor(). Kept in sync by hand -- this is a spike,
# not a shared dependency.
UPSCALE_NARROW_SIDE_THRESHOLD = 1500
UPSCALE_FACTOR = 2.0

OUT_DIR = Path(__file__).parent / "out"


def preprocess(image_path: Path, allow_upscale: bool = True) -> tuple[Image.Image, float]:
    """Grayscale -> Lanczos upscale (if narrow side < threshold) -> (image, scale).

    Bit-for-bit mirror of ocr.rs::preprocess_for_ocr: grayscale happens before
    the resize (not after), so antialiased stroke shoulders fatten up the same
    way the real pipeline's does. No binarization, no rule-line removal, no
    forced DPI -- the real pipeline deliberately dropped those (docs/issues.md
    § OCR/Preprocessing #1); reintroducing them here would bias the comparison.
    """
    img = Image.open(image_path)
    w, h = img.size
    scale = UPSCALE_FACTOR if allow_upscale and min(w, h) < UPSCALE_NARROW_SIDE_THRESHOLD else 1.0

    gray = img.convert("L")
    if scale != 1.0:
        gray = gray.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)

    return gray, scale


def run_rapidocr(preprocessed: Image.Image):
    from rapidocr import RapidOCR
    import numpy as np

    engine = RapidOCR()
    # return_word_box splits each detected LINE down into individual words with
    # their own sub-boxes (result.word_results) -- without it, boxes/txts/scores
    # are line-level, which is coarser than Tesseract's per-word TSV rows and
    # not a fair comparison.
    result = engine(np.array(preprocessed), return_word_box=True)
    total_elapse = sum(result.elapse) if isinstance(result.elapse, (list, tuple)) else result.elapse
    return result, total_elapse


def to_ocr_words(result, scale: float) -> list[dict]:
    """Flatten RapidOCR's word_results (one tuple of (text, score, box_polygon)
    per word, grouped by detected line) into OcrWord's shape: text, confidence
    (0-100, matching Tesseract's scale), box_coords {left, top, width, height}.

    Boxes are divided back by `scale` into the original image's coordinate
    space -- the same invariant ocr.rs's map_coord enforces for Tesseract, and
    the one every consumer of OcrWord (DocumentViewer, provenance.ts) assumes.
    """
    words = []
    if result.word_results is None:
        return words
    for line_words in result.word_results:
        for text, score, box_points in line_words:
            xs = [p[0] for p in box_points]
            ys = [p[1] for p in box_points]
            left, top = min(xs), min(ys)
            width, height = max(xs) - left, max(ys) - top
            words.append({
                "text": text,
                "confidence": round(float(score) * 100, 2),
                "box_coords": {
                    "left": round(left / scale),
                    "top": round(top / scale),
                    "width": round(width / scale),
                    "height": round(height / scale),
                },
            })
    return words


def draw_overlay(original: Image.Image, words: list[dict], out_path: Path) -> None:
    """Boxes drawn on the ORIGINAL (pre-preprocessing) image, since box_coords
    is already back in that coordinate space -- no scaling needed here."""
    overlay = original.convert("RGB").copy()
    draw = ImageDraw.Draw(overlay)
    for w in words:
        b = w["box_coords"]
        x0, y0 = b["left"], b["top"]
        x1, y1 = x0 + b["width"], y0 + b["height"]
        conf = w["confidence"]
        color = "lime" if conf >= 85 else ("orange" if conf >= 60 else "red")
        draw.rectangle([x0, y0, x1, y1], outline=color, width=2)
    overlay.save(out_path)


def main() -> None:
    if len(sys.argv) > 1:
        image_path = Path(sys.argv[1])
    else:
        image_path = Path(__file__).parent.parent / "OCR" / "sample_invoice.png"
        print(f"No image given, using default: {image_path}")

    if not image_path.exists():
        print(f"Image not found: {image_path}")
        print(f"Usage: python {Path(__file__).name} path/to/image.png")
        sys.exit(1)

    OUT_DIR.mkdir(exist_ok=True)
    stem = image_path.stem

    original = Image.open(image_path)
    preprocessed, scale = preprocess(image_path, allow_upscale=True)
    print(f"Preprocessed: {original.size} -> {preprocessed.size} (scale={scale})")

    result, elapse = run_rapidocr(preprocessed)
    n_lines = len(result.txts) if result.txts else 0
    words = to_ocr_words(result, scale)
    print(f"RapidOCR: {n_lines} lines / {len(words)} words detected in {elapse:.2f}s")

    json_path = OUT_DIR / f"{stem}.rapidocr.json"
    json_path.write_text(json.dumps(words, indent=2))
    print(f"Wrote {json_path}")

    overlay_path = OUT_DIR / f"{stem}.rapidocr.overlay.png"
    draw_overlay(original, words, overlay_path)
    print(f"Wrote {overlay_path}")

    confidences = [w["confidence"] for w in words]
    if confidences:
        print(
            f"Confidence: mean={sum(confidences) / len(confidences):.1f} "
            f"min={min(confidences):.1f} max={max(confidences):.1f}"
        )
    else:
        print("No words detected.")


if __name__ == "__main__":
    main()
