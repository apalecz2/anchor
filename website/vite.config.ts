import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Plain static-site build — no Tauri specifics. Outputs to dist/ for any static host.
export default defineConfig({
    plugins: [react(), tailwindcss()],
});
