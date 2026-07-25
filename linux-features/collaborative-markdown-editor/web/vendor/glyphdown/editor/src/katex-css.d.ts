/*
 * SPDX-License-Identifier: MIT
 * Derived from Glyphdown commit faf98d07c1aa939a3ee5b3d29cc600bde12a38e6.
 * Modified for Collaborative Markdown Editor; see UPSTREAM.md.
 */
/**
 * The KaTeX stylesheet is imported dynamically inside math.ts so it rides
 * the lazy katex chunk (vite extracts and injects it, fonts included). This
 * ambient declaration keeps tsc happy about the CSS specifier.
 */
declare module 'katex/dist/katex.min.css' {
  const css: undefined
  export default css
}
