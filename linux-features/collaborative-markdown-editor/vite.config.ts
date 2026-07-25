import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'web/editor-preview.html'),
    },
  },
})
