import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.png', 'logo.svg'],

      manifest: {
        name: 'RedPen AI - 作業批改',
        short_name: 'RedPen AI',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2563eb',
        description: 'AI 輔助教師快速批改作業,自動辨識錯誤並提供個人化建議',
        id: '/',
        scope: '/',
        lang: 'zh-TW',
        dir: 'ltr',
        orientation: 'any',
        categories: ['education', 'productivity'],
        prefer_related_applications: false,
        icons: [
          {
            src: '/pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/maskable-icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        screenshots: [
          {
            src: '/screenshot-1-landing.png',
            sizes: '1242x2688',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'RedPen AI - 智慧作業批改系統'
          },
          {
            src: '/screenshot-2-features.png',
            sizes: '1242x2688',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'AI 自動批改與個人化建議'
          },
          {
            src: '/screenshot-3-intro.png',
            sizes: '1242x2688',
            type: 'image/png',
            form_factor: 'narrow',
            label: '功能介紹與使用說明'
          },
          {
            src: '/screenshot-4-demo.png',
            sizes: '1242x2688',
            type: 'image/png',
            form_factor: 'narrow',
            label: '快速批改 釋放教師時間'
          }
        ],
        shortcuts: [
          {
            name: '新增作業',
            short_name: '新增',
            description: '建立新的批改作業',
            url: '/assignment-setup',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }]
          },
          {
            name: '開始批改',
            short_name: '批改',
            description: '查看待批改作業清單',
            url: '/grading-list',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }]
          },
          {
            name: '成績總覽',
            short_name: '成績',
            description: '查看學生成績統計',
            url: '/gradebook',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }]
          }
        ],
        share_target: {
          action: '/assignment-import',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['image/*', 'application/pdf']
              }
            ]
          }
        }
      },

      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        globIgnores: ['**/intro-video.mp4'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        sourcemap: false,

        runtimeCaching: [
          // HTML pages - Network First with offline fallback
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 24 * 60 * 60
              },
              networkTimeoutSeconds: 5
            }
          },
          // Supabase API - Network First
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60
              },
              cacheableResponse: {
                statuses: [0, 200]
              },
              networkTimeoutSeconds: 10
            }
          },
          // Supabase Storage - Cache First
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/v1\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-storage-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          // Google Fonts CSS
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 365 * 24 * 60 * 60
              }
            }
          },
          // Google Fonts Files
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 365 * 24 * 60 * 60
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          // Images
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 30 * 24 * 60 * 60
              }
            }
          },
          // Gemini API - Network Only (不快取 AI 回應)
          {
            urlPattern: /^https:\/\/.*\/api\/proxy$/i,
            handler: 'NetworkOnly'
          }
        ],

        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /\.(?:png|jpg|jpeg|svg|gif|webp|js|css)$/],
        skipWaiting: true,
        clientsClaim: true
      },

      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html'
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
