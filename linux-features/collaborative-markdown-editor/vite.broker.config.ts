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
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    ssr: resolve(import.meta.dirname, 'server/broker-main.mjs'),
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        entryFileNames: 'broker.mjs',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})
