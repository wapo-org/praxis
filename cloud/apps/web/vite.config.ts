import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8797';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.PRAXIS_MOCK_OAUTH': JSON.stringify(
      process.env.VERCEL_ENV === 'preview' ? (process.env.PRAXIS_PREVIEW_MOCK_OAUTH ?? '').split(',').map(name => name.trim()) : [],
    ),
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    proxy: {
      '/v1': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
  },
});
