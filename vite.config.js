import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ollama/, ''),
      },
      // llamafiler chat instance (port 8081); embed instance runs on 8080 via server.js
      '/api/llamafile': {
        target: `http://localhost:${process.env.LLAMAFILE_CHAT_PORT || 8081}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/llamafile/, ''),
      },
      '/api/storage': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/summaries': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/skill-results': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/rag': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/cases': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/agent': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/caselaw': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/admin': { target: 'http://localhost:3001', changeOrigin: true },
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
