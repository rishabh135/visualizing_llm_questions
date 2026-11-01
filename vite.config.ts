import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the static build works on GitHub Pages sub-paths and file hosts.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
});
