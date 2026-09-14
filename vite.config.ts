import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The released version is the build's version; keep package.json the only authority.
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  server: { proxy: Object.fromEntries(['/api', '/mcp', '/oauth', '/.well-known', '/published'].map(path => [path, 'http://127.0.0.1:8787'])) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 }
});
