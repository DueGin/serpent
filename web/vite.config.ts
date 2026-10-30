import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3308,
    proxy: {
      '/api': { target: 'http://localhost:8008', changeOrigin: true },
      '/a2a': { target: 'http://localhost:8008', changeOrigin: true },
      '/.well-known': { target: 'http://localhost:8008', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:8008', ws: true, changeOrigin: true },
    },
  },
});
