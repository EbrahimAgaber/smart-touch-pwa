import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * vite.config.js — Smart Touch POS PWA
 * P0.9: Wire vite-plugin-pwa (was installed but unused).
 * Workbox NetworkFirst caching for Supabase bootstrap + stats endpoints.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'البصمة الذكية - لوحة المالك',
        short_name: 'البصمة',
        description: 'تطبيق الإدارة والرقابة اللحظية لمالك نقاط البيع الذكية',
        theme_color: '#6366f1',
        background_color: '#f1f5f9',
        display: 'standalone',
        orientation: 'portrait',
        dir: 'rtl',
        lang: 'ar-SA',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icons/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icons/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: '/icons/pwa-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          // Google Fonts: CacheFirst, 1 year
          {
            urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          // Supabase bootstrap (owner_licenses, shops, shop_memberships, owner_profiles):
          // NetworkFirst with 3s timeout — serves cached state when offline (P0.9)
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(?:owner_licenses|shops|shop_memberships|owner_profiles).*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-bootstrap-cache',
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 7  // 7 days
              },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          // Supabase daily stats + shift endpoints: NetworkFirst, 3 days stale
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(?:shop_live_stats|shop_shifts|shop_shifts_v2).*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-stats-cache',
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 3  // 3 days
              },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
});
