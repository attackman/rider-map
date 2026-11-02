import { defineConfig } from 'vite';

// Relative paths so the same build works on its own web address and inside the Even Hub package
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' }
});
