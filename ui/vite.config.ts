import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Dev server proxies the backend REST surface and the Socket.IO transport to the
// running WhiteBox server, so the SPA talks same-origin. The API lives under /api/*
// so it never collides with the client routes (/analytics, /campaigns, …); the /api
// prefix is stripped on the way through, so the server still serves /analytics/*.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/socket.io': { target: 'http://localhost:3000', changeOrigin: true, ws: true },
    },
  },
})
