import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3308,
    proxy: {
      '/api': { target: process.env.SERPENT_API || 'http://localhost:8008', changeOrigin: true },
      '/mcp': { target: process.env.SERPENT_API || 'http://localhost:8008', changeOrigin: true },
      '/socket.io': { target: process.env.SERPENT_API || 'http://localhost:8008', ws: true, changeOrigin: true },
    },
  },
});
