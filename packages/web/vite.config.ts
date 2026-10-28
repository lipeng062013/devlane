import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    // 开发时把接口转发到本地服务端
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
