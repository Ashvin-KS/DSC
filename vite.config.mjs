import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  return {
    base: './',
    server: {
      port: 5180,
      host: '0.0.0.0',
      strictPort: true,
    },
    plugins: [react()],
    define: {
      // Security: never bake API keys into the frontend bundle.
      // Keys are fetched from the Rust backend (OS keyring / SQLite) at runtime.
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});

