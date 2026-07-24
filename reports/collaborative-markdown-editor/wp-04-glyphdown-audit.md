# WP-04 Glyphdown reuse audit

Date: 2026-07-24

Upstream: <https://github.com/SawyerHood/glyphdown>

Audited revision:
`faf98d07c1aa939a3ee5b3d29cc600bde12a38e6`
(`Add markdown word wrapping shortcuts (#17)`, 2026-06-23).

## Finding

Glyphdown is a suitable MIT-licensed **source donor**, but it is not a stable
library dependency for this feature. The production feature will vendor a
documented extraction of the required editor and merge sources at the pinned
revision. It will not fork or embed Glyphdown's hosted product.

The remote was refreshed during this audit. The pinned revision was still
`origin/main` on 2026-07-24. The repository had 46 commits, all attributed to
one author, beginning 2026-06-09; 50 stars, 8 forks, five CLI releases, and no
open issues or pull requests were visible on GitHub. This is meaningful working
software with unusually strong tests for its age, but it is young, single-
maintainer code with no tagged editor/core API release.

The root and reusable packages are private workspace packages:

| Package | Version | Published/stable seam |
| --- | --- | --- |
| `@glyphdown/editor` | private `0.0.1` | source export only |
| `@glyphdown/core` | private `0.0.1` | source export only |
| `@glyphdown/protocol` | private `0.0.1` | excluded |
| `@glyphdown/sync` | private `0.0.1` | excluded |
| `glyphdown` CLI | public `0.6.0` in the audited tree | excluded |

The upstream root pins pnpm 10.30.1 and overrides Yjs and CodeMirror singleton
packages. The extraction must preserve the singleton constraint; two Yjs or
CodeMirror state/view copies can break identity checks and extension behavior.

## License and attribution

The repository root license is MIT:

```text
Copyright (c) 2026 Sawyer Hood
```

The full Glyphdown MIT text and revision must ship in
`THIRD_PARTY_NOTICES.md`. Every copied source file will retain an SPDX header,
the upstream path, revision, and a local-modification marker.

The selected source contains additional attribution that must survive:

- `packages/editor/src/footnote.ts` says it is adapted from SilverBullet's
  MIT-licensed footnote parser.
- `packages/editor/src/callout.ts` contains static Lucide SVG path data under
  ISC, including Feather-derived portions under MIT.
- `packages/editor/src/markdown.ts` describes delimiter logic structurally
  cloned from `@lezer/markdown`; CodeMirror/Lezer packages are MIT.
- KaTeX is MIT.
- `y-codemirror.next`, Yjs, y-protocols, lib0, and CodeMirror are MIT.
- `@sanity/diff-match-patch`, used by the selected merge primitive, is
  Apache-2.0. Its license and modification-notice obligations must be retained.

The installed production closure for the upstream editor/core packages
reported only permissive families: MIT, Apache-2.0, BSD-2-Clause, ISC, and one
dual `MIT OR Apache-2.0` package. The upstream closure also included
`partyserver`, `y-partyserver`, and Cloudflare types because of Glyphdown's
provider dependency; those are not part of this feature's selected closure.
WP-12 will generate the final bundle-level inventory after the extraction,
rather than treating this upstream-monorepo inventory as the shipped SBOM.

No Glyphdown name, logo, hosted-service copy, or other product identity will be
used. “Derived from Glyphdown” appears only in source and licensing notices.

## Test evidence

The audit installed the exact frozen lockfile and ran only the relevant
packages:

```text
pnpm --filter @glyphdown/editor test
20 files passed; 447 tests passed

pnpm --filter @glyphdown/core test
6 files passed; 33 tests passed

pnpm --filter @glyphdown/editor typecheck
passed

pnpm --filter @glyphdown/core typecheck
passed
```

The editor tests cover live preview, read-only behavior, formatting,
annotations, suggestion mode, tables, math, footnotes, wiki links, themes, and
DOM rendering. JSDOM emitted expected unimplemented canvas warnings; no test
failed. These results establish a donor baseline, not acceptance of all
features or dependencies.

## Exact v1 extraction

The feature will vendor into `web/vendor/glyphdown/`:

- editor language/live-preview sources needed for GFM, YAML frontmatter,
  formatting/autoclose, theme, callouts, footnotes, math, tables, task
  checkboxes, and the one `glyphdownCollab` Yjs binding;
- the corresponding upstream tests, adapted only for the local package seam;
- the pure merge/diff-to-Y.Text functions from `packages/core/src/merge.ts`;
  and
- the source-level attribution comments named above.

The extraction will modify:

- `collab.ts` comments and API so it accepts the feature-owned provider and
  awareness implementation without importing or mentioning `y-partyserver`;
- image rendering so no remote or workspace asset URL is fetched in v1;
- wiki-link routing so it remains source styling only and cannot navigate or
  query a hosted workspace;
- exports so annotations and suggestion mode are not in the v1 bundle; and
- the merge boundary so internal LF normalization is separate from the file
  codec that preserves consistent LF/CRLF style and final-newline state.

The feature will not copy or depend on:

- `apps/web`;
- `packages/sync`, `packages/protocol`, or `packages/cli`;
- `trailer`, deployment workflows, Cloudflare Workers, Durable Objects, D1,
  R2, auth, PostHog, React/TanStack application code, asset routes, account or
  sharing UI;
- `y-partyserver` or `partyserver`;
- comments, review suggestions, annotation persistence, hosted history,
  folders, permissions, or collaboration-service semantics; or
- Tandem code.

## Why vendoring instead of a fork or package publication

A full fork would make the feature responsible for unrelated hosted, auth,
database, deployment, and CLI code and would obscure the shipped dependency
boundary. Publishing new `@glyphdown/*` packages without upstream ownership
would create a misleading maintenance contract. A pinned extraction is
smaller, auditable in the plugin bundle, and allows the host-specific provider
and security changes to be explicit.

The extraction will include `UPSTREAM.md` with:

- upstream URL and commit;
- copied file manifest with hashes;
- local patch descriptions;
- the donor tests retained or intentionally dropped; and
- a repeatable update procedure that imports a candidate into a temporary
  directory, compares it, reruns upstream and local tests, and requires manual
  review before replacing the vendored sources.

This is a maintained source snapshot, not a claim of binary compatibility with
future Glyphdown revisions.
