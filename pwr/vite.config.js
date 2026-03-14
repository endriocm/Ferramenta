import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'chrome120',        // Electron 33 = Chromium 130; avoid unnecessary polyfills
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          if (/[\\/]firebase[\\/]/.test(id)) return 'vendor-firebase'
          if (/[\\/]xlsx[\\/]/.test(id)) return 'vendor-xlsx'
          if (/[\\/]jspdf[\\/]/.test(id)) return 'vendor-jspdf'
          if (/[\\/]html-to-image[\\/]/.test(id)) return 'vendor-html2img'
          if (/[\\/]html2canvas[\\/]/.test(id)) return 'vendor-html2canvas'
          if (/[\\/]dompurify[\\/]/.test(id)) return 'vendor-dompurify'
          if (/[\\/]pdfjs-dist[\\/]/.test(id)) return 'vendor-pdfjs'
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4170',
    },
  },
}))
