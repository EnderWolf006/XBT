import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import yaml from '@rollup/plugin-yaml'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    yaml(),
  ],
  server: {
    proxy: {
      // 代理 API 请求
      '/api': {
        target: 'http://localhost:3030',
        changeOrigin: true,
      },
    },
  },
})
