// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages (sub-path) and Netlify (root).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
});
