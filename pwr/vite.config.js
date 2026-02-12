import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          if (/[\\/]firebase[\\/]/.test(id)) return 'vendor-firebase'
          if (/[\\/]xlsx[\\/]/.test(id)) return 'vendor-xlsx'
          if (/[\\/]jspdf[\\/]|[\\/]html-to-image[\\/]/.test(id)) return 'vendor-export'
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
