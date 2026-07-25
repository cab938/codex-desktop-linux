# WP-01 baseline: Collaborative Markdown Editor

Captured on 2026-07-24 in
`/home/brooksch/sandboxes/codex-desktop-linux-dev`.

## Starting checkout

- Starting branch: `dev/combined`
- Starting commit:
  `8d71a32541bed62194c4b1a785fef4a05f496009`
  (`Merge realistic headless UI testing guidance`)
- Starting tracked and untracked status: clean
- Tracking state after remote refresh:
  `dev/combined` is 73 commits ahead of and 13 commits behind
  `upstream/main`; it is 64 commits ahead of `origin/dev/combined`.
- The ignored project-work document and local feature configuration were
  preserved.

Switching away from `dev/combined` leaves the environment-provided `.agents/`
skill mount visible as untracked because those files exist only on that
integration branch. They are read-only infrastructure, not feature work, and
must not be staged or deleted.

## Refreshed base and owning branch

- Refreshed upstream base:
  `upstream/main` at
  `66c780a6939b1f35aa3d90c5ad07ff2b35f1f644`
  (`Fix enabled feature drift on the current DMG (#1148)`).
- Local `main` previously carried one repository workflow documentation
  commit and was 13 upstream commits behind.
- `upstream/main` was merged into local `main`, preserving both histories.
- Refreshed local base:
  `278823823c94941f040c7bf063415e6ea077afd7`
  (`Merge remote-tracking branch 'upstream/main'`).
- Owning branch:
  `feature/collaborative-markdown-editor`, created from that refreshed base.
- No remote branch was pushed or published.

## Upstream DMG and existing development app

- Current `Codex.dmg` size: 593,891,632 bytes.
- Current `Codex.dmg` SHA-256:
  `ff6e8ac9985aec44caa305787552e4ea517a7c745aef283bd4cbcab992de64b7`.
- Current upstream app version, from the matching side-by-side build metadata:
  `26.721.31836`.
- Electron version in that build: `42.3.0`.
- Existing side-by-side app identity:
  `codex-desktop-linux-dev` / `Codex Desktop Linux Dev`.
- Existing side-by-side build source:
  `dev/combined` at `8d71a32541bed62194c4b1a785fef4a05f496009`,
  generated 2026-07-24T22:10:44.149Z.
- The build metadata DMG hash matches the current file hash.
- The stock `codex-app/` build is older and was inspected only as existing
  metadata. It was not rebuilt, launched, promoted, or modified.

## Local enabled feature set

The ignored `linux-features/features.json` currently enables:

1. `dev-colorize`
2. `dev-inverse-icon`
3. `teaching-sidebar-filter`
4. `project-work`
5. `quick-launcher`

The new `collaborative-markdown-editor` feature is not enabled. The committed
`linux-features/features.example.json` remains `{ "enabled": [] }`.

## Feature-shell contract

- Stable ID: `collaborative-markdown-editor`
- Default enabled: false
- Required features: none
- Conflicting features: none
- Premature integration hooks: none
- Deterministic local lifecycle:
  `npm run build`, `npm run stage`, `npm test`, and `npm run clean`
- Generated shell artifacts stay under the ignored feature-local `dist/`
  directory and do not patch or stage into a generated app.

## Known external and operator gates

No external gate blocks the inert WP-01 shell. Later packages must resolve:

1. **Codex host gate:** prove local plugin installation, lifecycle, MCP App
   rendering, and acceptable persistent right-side placement in the exact
   side-by-side Codex Desktop build.
2. **Realtime transport gate:** prove that the sandboxed UI can securely reach
   a local Yjs broker without exposing credentials to model context.
3. **Single-writer gate:** prove that multiple tasks, windows, and MCP
   connections attach to one authority for a canonical Markdown path.
4. **Durability gate:** prove atomic persistence, watcher import, restart, and
   crash recovery without content loss or duplication.
5. **Cross-platform gate:** obtain actual macOS and Windows Codex Desktop
   runtime evidence before claiming support on those platforms. This may
   require an external operator if those hosts are unavailable locally.
6. **Integration gate:** after owning-branch verification, merge the actual
   feature branch into `dev/combined`, rebuild the side-by-side identity, and
   inspect it through the private Xvfb harness.

No remote publication, pull request, marketplace submission, or
package-managed installation is authorized by the project goal.

## Verification evidence

The following checks were run and inspected on the owning branch:

- `npm test` in the feature directory: 4 tests passed, 0 failed.
- `node --test scripts/lib/linux-features.test.js
  linux-features/collaborative-markdown-editor/test.js`: 15 tests passed,
  0 failed.
- `npm run build` followed by `npm run stage`: the build and staged artifacts
  both had SHA-256
  `815e289a3447df91c69078333e6554b8dfd7068caccd2b77ca72488a949b4268`.
- `npm run clean`: removed the feature-local `dist/` tree and left an
  unrelated sentinel intact.
- `node scripts/lib/linux-features.js --features-json`: discovered the feature
  as a repository feature with no requirements, conflicts, setup, cleanup, or
  default enablement.
- `node scripts/lib/linux-features.js --enabled`: confirmed the new feature is
  absent from the ignored local enabled set.
- `git diff -- linux-features/features.example.json`: empty.
- `git diff --cached --check`: clean.
