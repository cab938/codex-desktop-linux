# Glyphdown source snapshot

This feature contains a maintained source extraction from:

- Repository: <https://github.com/SawyerHood/glyphdown>
- Commit: `faf98d07c1aa939a3ee5b3d29cc600bde12a38e6`
- Commit date: 2026-06-23
- License: MIT, copyright 2026 Sawyer Hood

It is not a fork of the Glyphdown product and does not claim compatibility
with future private `@glyphdown/editor` or `@glyphdown/core` packages.

## Imported source

From `packages/editor/src`:

```text
autoclose.ts
callout.ts
collab.ts
comment.ts
footnote.ts
katex-css.d.ts
live-preview.ts
markdown.ts
math-syntax.ts
math.ts
tab.ts
table-edit.ts
table.ts
theme.ts
```

From `packages/core/src`:

```text
merge.ts
```

The corresponding editor donor tests are retained except upstream annotation,
suggestion-mode, wiki-routing, and provider-specific cases. The selected core
merge test is retained. New local adapter tests cover one-Y.Text ownership,
bidirectional Yjs synchronization, raw/live-preview mode, and Yjs undo.

Pristine upstream source hashes:

| Upstream path | SHA-256 |
| --- | --- |
| `packages/editor/src/autoclose.ts` | `b738e765155630ad4cef4446901c630c909b8b32a4c79912d525b9b548b7a742` |
| `packages/editor/src/callout.ts` | `07285b29c412defe90de3e53358ae97a99828d4b2543e2b8b0d6c590242d34b3` |
| `packages/editor/src/collab.ts` | `b88282c81e6d2ed1de7789d035a88c0344b63d3fadbc59574ed9b9493c8dbb63` |
| `packages/editor/src/comment.ts` | `3b06cfc230e3db152b980808cf8960b08ea1dca9c365482bfa0c5efed689870b` |
| `packages/editor/src/footnote.ts` | `ac441068b84b74f0298b1dbeb1cc103ed0d8e9f06efbabbf070b63cb5e517bd6` |
| `packages/editor/src/katex-css.d.ts` | `1eb8e2024355a43eb447653cbdb3b74c85e5fcc8773ebf74057e8f27c741304a` |
| `packages/editor/src/live-preview.ts` | `ea7af9306dc793febedbca28212a1486629cf5f8cd7ce7d862008d4a3f0d3cb9` |
| `packages/editor/src/markdown.ts` | `a6d48305c2865374ab4bd92e948d5c17a75ba240142cb44be48fd6c1e3cfc6a7` |
| `packages/editor/src/math-syntax.ts` | `dc62609f38f4624ae2cab7b8fec44d8ec02b686822b2d0a49893d4c0e951a7f5` |
| `packages/editor/src/math.ts` | `0881f88f40311b48d07834491a122333d86e3d6f54ccd0f800cf08864131c478` |
| `packages/editor/src/tab.ts` | `eeffbf6a6bc140bfb60071b37b5032e54c0938bbcd4fd360bd90491459d946b4` |
| `packages/editor/src/table-edit.ts` | `1e98d6b3e37c9f678c5484df05edec5fe50fd0786e6acbf19f056a55dab1616c` |
| `packages/editor/src/table.ts` | `bea7143e2128d19b8f06167f94f4ee7b11b1393741a796a85eac546d5be6fa55` |
| `packages/editor/src/theme.ts` | `dc3bbbf17a766e35c064da29ef58adc4585a71bd3b7c16c5887be5820fdb5ec6` |
| `packages/core/src/merge.ts` | `0a4354ef0b57eb27f03f7a71cfcc26c349865daa74b38681f95733dded7a4313` |

## Local modifications

- Every retained TypeScript file has an SPDX/source marker.
- `editor/src/index.ts` exports only the v1 editor seam.
- `core/src/index.ts` exports only the merge/diff-to-Y.Text seam.
- `collab.ts` is provider-neutral and has no `y-partyserver` assumption.
- `live-preview.ts` makes image resolution deny-by-default. Schemes and
  root-relative URLs cannot bypass the application resolver; the v1 editor
  supplies no asset capability, so hostile Markdown produces placeholders
  rather than requests.
- Wiki routing/autocomplete, annotation rendering, suggestion mode, and their
  tests are not imported.
- Suggestion-mode-only blocks were removed from otherwise retained autoclose,
  tab, and table-edit tests.
- `web/src/editor.ts` is the local composition layer. It creates one
  CodeMirror view over a caller-owned `Y.Text`, uses Yjs undo, and switches
  raw/live-preview decorations through a compartment.

The source-level SilverBullet footnote and Lucide/Feather icon attributions
remain in their original files. Full relevant license texts are under
`web/vendor/glyphdown/licenses/` and summarized in
`THIRD_PARTY_NOTICES.md`.

## Deliberately excluded

No source was copied from `apps/web`, `packages/sync`, `packages/protocol`,
`packages/cli`, `trailer`, Glyphdown auth/database/deployment/analytics code,
or Tandem. The feature does not depend on `partyserver` or `y-partyserver`.

## Update procedure

1. Clone Glyphdown into a temporary directory; never overwrite the vendored
   tree directly.
2. Fetch the intended upstream revision and verify its root license.
3. Re-run the upstream editor/core tests and typechecks before copying.
4. Compare the source list and pristine hashes above with the candidate.
5. Copy only the listed sources into a second temporary extraction, retaining
   SPDX/source markers.
6. Reapply each local modification above as an explicit reviewed patch.
7. Review new imports and production licenses. Reject cloud, auth, analytics,
   database, provider, CLI, and deployment dependencies.
8. Run `npm ci`, `npm test`, `npm run build`, and the singleton dependency
   check from this feature directory.
9. Inspect the single-file bundle and update this file, notices, hashes,
   package lock, and work-package evidence in the same commit.

Upstream changes are never pulled automatically into a release.
