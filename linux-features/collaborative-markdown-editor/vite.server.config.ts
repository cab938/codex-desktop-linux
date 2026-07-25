import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]

export default defineConfig({
  build: {
    target: 'node20',
    outDir: resolve(import.meta.dirname, 'dist/plugin'),
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    ssr: resolve(import.meta.dirname, 'mcp/main.mjs'),
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        entryFileNames: 'server.mjs',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})
