import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Workspace packages ship TypeScript sources, so they must be bundled, not externalised.
const bundled = ['@dali-scout/core', '@dali-scout/transports'];

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: bundled })] },
  preload: { plugins: [externalizeDepsPlugin({ exclude: bundled })] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()]
  }
});
