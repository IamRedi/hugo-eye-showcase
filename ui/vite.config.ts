import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = process.env.EYE_UI_API_TARGET ?? 'http://127.0.0.1:8764'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/media': apiTarget,
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
