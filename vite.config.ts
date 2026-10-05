import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Build configuration.
 *
 * The app is a PWA with no backend: the service worker pre-caches the whole bundle so
 * that a venue with no signal still gets data entry, order generation and editing
 * (spec §2). The optimizer runs in a module worker, which Vite bundles automatically
 * from the `new Worker(new URL(...))` call in `src/optimizer/runner.ts`.
 */
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Darts League Order Optimizer',
        short_name: 'Darts Order',
        description:
          'ダーツリーグのオーダーを、メンバー・Rating・適性・出場条件・公平性を考慮して自動生成・調整できるアプリ',
        lang: 'ja',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b1119',
        theme_color: '#0b1119',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The app is self-contained, so any unknown route falls back to the shell.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
