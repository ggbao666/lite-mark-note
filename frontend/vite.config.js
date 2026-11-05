import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  server: {
    strictPort: true,
  },
  build: {
    target: 'es2021',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
})
