import { defineConfig } from 'vite';

// base:'./' → relative asset paths so the built dist/ runs at ANY URL or subpath
// (GitHub Pages project subpath, a SharePoint document library, an iframe host, file
// server, etc.) with no rebuild. This is what keeps the app embeddable.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
