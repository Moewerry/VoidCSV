import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 允许局域网机器访问前端
    host: true,
    // 开发期固定端口更好排查与说明
    port: 5173,
    proxy: {
      // 开发期把 /api/* 转发给本地引擎
      '/api': 'http://127.0.0.1:8787'
    }
  }
})

