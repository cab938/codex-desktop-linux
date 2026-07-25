# Third-party notices

This file covers the vendored source seam established in WP-05. The complete
locked production dependency graph and exact staged-bundle hashes are retained
and shipped as `SBOM.cdx.json` in CycloneDX 1.5 format.

## Glyphdown

Selected editor and merge source is derived from Glyphdown commit
`faf98d07c1aa939a3ee5b3d29cc600bde12a38e6`.

Copyright (c) 2026 Sawyer Hood. Licensed under MIT. The complete text is in
`web/vendor/glyphdown/licenses/GLYPHDOWN-MIT.txt`.

## SilverBullet

`web/vendor/glyphdown/editor/src/footnote.ts` retains Glyphdown's notice that
its footnote parser was adapted from SilverBullet's
`client/markdown_parser/footnote.ts`.

SilverBullet is licensed under MIT:
<https://github.com/silverbulletmd/silverbullet>.

## Lucide and Feather

`web/vendor/glyphdown/editor/src/callout.ts` retains Glyphdown's static Lucide
SVG path data and source attribution. Lucide portions are ISC; portions
derived from Feather are MIT. The complete combined notice is in
`web/vendor/glyphdown/licenses/LUCIDE-ISC-AND-FEATHER-MIT.txt`.

## Other directly retained dependencies

- `@sanity/diff-match-patch`: Apache-2.0. Complete text:
  `web/vendor/glyphdown/licenses/SANITY-DIFF-MATCH-PATCH-APACHE-2.0.txt`.
- KaTeX: MIT. Complete text:
  `web/vendor/glyphdown/licenses/KATEX-MIT.txt`.
- `y-codemirror.next`: MIT. Complete text:
  `web/vendor/glyphdown/licenses/Y-CODEMIRROR-NEXT-MIT.txt`.
- CodeMirror, Lezer, Yjs, y-protocols, lib0, and their selected production
  closure use permissive licenses recorded by the locked dependency inventory
  in `SBOM.cdx.json`.

No Glyphdown or other upstream name, logo, or product identity is used for the
feature itself.
