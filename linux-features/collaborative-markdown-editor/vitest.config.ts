import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    include: [
      'web/vendor/glyphdown/**/test/**/*.test.ts',
      'web/test/**/*.test.ts',
      'web/src/**/*.test.ts',
    ],
  },
})
