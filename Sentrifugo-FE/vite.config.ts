import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['recharts'],
  },
  server: {
    // Dev only: PMS calls go same-origin through this proxy, so the PMS
    // backend (pms-app on 8080) doesn't need CORS for the Vite origin.
    proxy: {
      '/api/v1/pms': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
