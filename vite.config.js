import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ollama/, ''),
      },
      '/api/storage': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/summaries': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/skill-results': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/rag': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/blobs': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // allow large PDF uploads through the proxy
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('content-length')
          })
        },
      },
    },
  },
})
