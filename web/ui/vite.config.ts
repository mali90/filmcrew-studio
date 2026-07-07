import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev: Vite on 5173 proxies API + SSE to the Fastify server (npm run web, or the dev/demo.js harness).
// Prod: `vite build` → dist/, served by the Fastify server on one port.
const target = `http://127.0.0.1:${process.env.WEB_PORT ?? 5177}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    exclude: ['e2e/**', 'node_modules/**'], // e2e/ belongs to Playwright, not vitest
  },
});
