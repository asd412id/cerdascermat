import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Cerdas Cermat — Rebutan',
        short_name: 'Cerdas Cermat',
        description: 'Tombol rebutan cerdas cermat dengan wasit waktu terukur.',
        lang: 'id',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#1A1714',
        theme_color: '#1A1714',
        icons: [
          { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-1024.png', sizes: '1024x1024', type: 'image/png' },
        ],
      },
      workbox: {
        // Service worker hanya mengurus aset SPA di origin Firebase.
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // ExcelJS (±930 kB) hanya diunduh saat operator mengekspor laporan; jangan
        // ikut diprecache saat service worker dipasang. Runtime cache /assets/ di
        // bawah tetap menyimpannya setelah pemakaian pertama.
        globIgnores: ['**/exceljs*.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'spa-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173 },
});
