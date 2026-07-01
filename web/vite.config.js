import { defineConfig } from 'vite';

// Proxy /api to the backend so the frontend can use relative URLs.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
