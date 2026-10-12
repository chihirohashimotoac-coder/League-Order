import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Non-production preview build (`npm run build:preview` → `dist-preview/`).
 *
 * Two pages: `preview.html` (the throw-order / underdog scenarios on synthetic data) and
 * `index.html` (the app itself, usable with its sample team). No service worker and no PWA
 * manifest — a preview must never install itself or cache over the real app — and no secret of
 * any kind. It is published only as a private preview, never to GitHub Pages (docs/THROW_ORDER_MODEL.md §10).
 */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __PREVIEW_COMMIT__: JSON.stringify(process.env.PREVIEW_COMMIT ?? commit()),
    // `PREVIEW_APP_LINK=0` leaves out the link to the app page, for hosts that publish only the
    // scenarios page (the app itself needs its own page, storage and worker).
    __PREVIEW_APP_LINK__: JSON.stringify(process.env.PREVIEW_APP_LINK !== '0'),
  },
  resolve: {
    // The app registers its service worker through vite-plugin-pwa's virtual module; the preview
    // has none, so the registration is the inert stub the unit tests use.
    alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/test/pwaRegisterStub.ts', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    outDir: 'dist-preview',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        preview: fileURLToPath(new URL('./preview.html', import.meta.url)),
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
});
