import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 开发时把 /api 转发到 Spring Boot，前端无需处理跨域
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
