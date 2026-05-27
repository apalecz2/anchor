# Notes on handling extraction of different types

1. Flat PDF with multi-page tables:
    - Use an agentic workflow / loop to tool call for OCR of the next page
    - Analyze if the page is a continuation of a table from the previous page