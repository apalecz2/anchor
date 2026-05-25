# Local Data Extraction App

This folder contains the main application for the Local Data Extraction AI project. Built using React, TypeScript, and Tauri, it is designed for private, offline data extraction from documents and images.

## Structure

*   `src/`: React frontend UI.
*   `src-tauri/`: Rust backend, handling system threads, OCR integrations, and local LLM execution.

## Getting Started

1.  Make sure you have Node.js and Rust installed globally.
2.  Install frontend dependencies:
    ```bash
    npm install
    ```
3.  Run the application in development mode:
    ```bash
    npm run tauri dev
    ```

## Development Commands

*   `npm run build`: Build the React frontend.
*   `npm run tauri build`: Compile the full release application (frontend + Rust backend) into native installers.
