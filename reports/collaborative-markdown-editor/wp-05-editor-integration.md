# WP-05: Glyphdown editor/core integration

Date: 2026-07-24

Outcome: **passed**. The optional feature now contains an independently
buildable, tested, provider-neutral one-Y.Text Markdown editor derived from the
audited Glyphdown revision.

## Source boundary

Pinned donor:

```text
https://github.com/SawyerHood/glyphdown
faf98d07c1aa939a3ee5b3d29cc600bde12a38e6
```

The feature vendors only:

- selected `packages/editor/src` language, live-preview, formatting, theme,
  table, math, footnote, callout, collab, and helper files;
- `packages/core/src/merge.ts`; and
- their relevant donor tests.

It does not vendor `apps/web`, sync, protocol, CLI, trailer, auth, database,
analytics, Cloudflare, deployment, annotation, suggestion-mode, wiki-routing,
or Tandem code. Neither source, lockfile, nor bundle contains
`y-partyserver`, `partyserver`, PostHog, Better Auth, Cloudflare, or
`@glyphdown/*` runtime dependencies.

`linux-features/collaborative-markdown-editor/UPSTREAM.md` records the exact
pristine source hashes, local modifications, exclusions, and repeatable update
procedure.

## Local adapter

`web/src/editor.ts` is the application-owned composition seam:

- the caller supplies one attached `Y.Text`;
- CodeMirror initializes from but does not reinsert that text;
- `y-codemirror.next` is the only document synchronization binding;
- a caller-owned or adapter-owned `Y.UndoManager` is the only document undo
  history;
- live preview is a decoration compartment over the same Markdown source;
- raw-source mode only removes that decoration extension;
- provider/awareness wiring is injected by the caller; and
- no network provider, file access, or second rich-document tree exists.

Remote image schemes, root-relative paths, and relative paths all pass through
an explicit application resolver. The default resolver returns no URL, so the
v1 editor renders an inert placeholder and makes no Markdown-triggered fetch.
Wiki routing/autocomplete is absent; ordinary Markdown links are decorations
only until a later trusted application handler is explicitly added.

## Licensing

Every copied TypeScript file carries an SPDX/source marker. The feature ships:

- Glyphdown MIT;
- Lucide ISC plus Feather MIT;
- `@sanity/diff-match-patch` Apache-2.0;
- KaTeX MIT; and
- `y-codemirror.next` MIT

license texts under `web/vendor/glyphdown/licenses/`.
`THIRD_PARTY_NOTICES.md` preserves the source-level SilverBullet footnote and
Lucide/Feather callout-icon attribution. WP-12 remains responsible for the
complete final bundle SBOM and notice reconciliation.

## Verification

Fresh locked installation:

```text
npm ci
159 packages installed
```

Full feature test:

```text
npm test
TypeScript strict typecheck: passed
18 Vitest files: passed
402 unit/component/property tests: passed
4 feature-framework/lifecycle tests: passed
```

The 402 tests retain the applicable donor behavior and add local regressions
for:

- initial text not duplicated;
- local CodeMirror edits landing in the shared Y.Text;
- remote Yjs edits appearing in the existing view;
- one named Y.Text in the Y.Doc;
- selection and content preserved across raw/live-preview toggles;
- Yjs undo/redo; and
- no installed CodeMirror history field.

JSDOM reported its expected unimplemented canvas warnings during math/widget
tests; all tests passed.

Singleton dependency inspection:

```text
npm ls yjs @codemirror/state @codemirror/view --all
yjs 13.6.31: one deduplicated/overridden instance
@codemirror/state 6.6.0: one deduplicated/overridden instance
@codemirror/view 6.43.0: one deduplicated/overridden instance
```

Production dependency audit:

```text
npm audit --omit=dev --audit-level=moderate
found 0 vulnerabilities
```

Independent bundle:

```text
npm run build
208 modules transformed
dist/web/editor-preview.html: 3,423,006 bytes
gzip estimate: 1,618.66 kB
SHA-256: 2a43cc4dbaa00a1c764022ae4551cb0bed19cf2e9218ed7d4c44c0f1c252a920
```

A second build produced the same byte count and SHA-256. The HTML has no
external script or stylesheet tag. Its size is not the final production size:
it deliberately retains Glyphdown's full fenced-code language registry and
KaTeX assets. WP-09 owns final MCP App optimization and accessibility, and
WP-14 will measure actual-app load performance.

The feature remains disabled by default, has no installation resource or
runtime hook, and did not touch a generated or stock Codex application.
