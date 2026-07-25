# WP-07 — Crash-safe Markdown persistence and external-change import

Status: complete on Linux on 2026-07-24.

## Implemented durability path

`server/file-persistence.mjs` extends the broker's recovery-log guarantee to
the workspace Markdown file.

1. Every accepted Yjs mutation remains synchronized to `updates.log` before
   acknowledgement.
2. Ordinary writes debounce for 150 ms. An explicit flush cancels the timer,
   enters the same serialized document queue as mutations and watcher events,
   rechecks the expected revision, and does not return until the file barrier
   is complete.
3. The writer encodes the internal LF-only Unicode text with the file's
   retained UTF-8 BOM and LF/CRLF style. The text itself retains its exact
   final-newline state.
4. It revalidates the target content identity, creates an exclusive temporary
   regular file in the target directory, writes it, reapplies the POSIX mode,
   synchronizes it, checks the target identity again, atomically renames it,
   and synchronizes the parent directory where supported.
5. Only after replacement does the state store advance
   `fileDurableRevision`, file identity/codec metadata, and the normalized
   `file-baseline.utf8`. A crash after replacement but before this checkpoint
   is recognized on restart because the file text equals the replayed Yjs
   state.

The writer never removes the target as a precondition. A racing external
write fails with `EXTERNAL_CHANGED`; the external bytes remain in place and
are reconciled before a caller can retry.

## External-change path

The broker watches the parent directory, which covers direct writes and
rename-based editor/Git safe-writes. Events are debounced and serialized with
agent/UI mutations.

- A self-generated content identity is suppressed without adding a revision.
- A true external change is decoded through the same UTF-8/EOL/size contract
  and compared with the persisted file baseline.
- If the live Yjs text still equals that baseline, the base-to-file diff lands
  as one minimal attributed Yjs transaction and is immediately file-durable.
- If in-memory edits also exist, the pinned Glyphdown merge computation applies
  disjoint file hunks to the live text. The merged revision is recovery-log
  durable and then flushed over the now-known external baseline.
- Failed hunks or a drifted rewrite deleting more than the frozen 60 percent
  guard enter a read-only conflict. `current.md`, `baseline.md`,
  `external.md` when decodable, and `conflict.json` are retained under
  `documents-v1/<id>/conflict/<conflict-id>/`.
- Invalid UTF-8, mixed EOLs, oversize files, symlink/type replacement, delete,
  and rename-away cannot trigger an overwrite. Delete and rename are
  distinguished by the prior inode when available; a same-directory new name
  is recorded in the conflict metadata.
- A permission-only change updates the retained mode. The next accepted flush
  preserves it.

The runtime copy of the audited Glyphdown merge primitive is
`server/merge.mjs`; its SPDX header and pinned donor commit retain provenance.

## Crash and recovery behavior

Temporary files include the document ID and broker generation. A real process
exit before rename leaves the project file untouched; the next owner moves
the orphan temp into the document recovery directory before proceeding. A
real process exit immediately after rename replays the acknowledged Yjs
revision, recognizes the already-written file, and advances the durable
checkpoint without adding or dropping text. An exit after the completed
checkpoint reopens at the same revision and bytes.

Snapshot/log compaction failure cannot turn a recovery-log-durable accepted
mutation into a rejected one. File-checkpoint or conflict-checkpoint failure
instead fences the live session as `RECOVERY_REQUIRED`.

## Verification

The full suite passed on the minimum supported Node.js 20.19.0:

```text
TypeScript typecheck: passed
Glyphdown/editor test files: 18 passed
Glyphdown/editor tests: 402 passed
Feature/lifecycle tests: 4 passed
Broker/file tests: 25 passed
```

The 25 server tests include byte-level BOM/CRLF/mode assertions, debounced and
explicit flushes, real `fs.watch` import, rename-based safe-write import, one
revision per external edit, disjoint agent/file merge, preserved ambiguous
conflicts, invalid-byte fencing, permission change, delete, rename-away, a
racing writer, recovery-log restart, and schema failure. Fast-check runs 200
codec cases and 100 disjoint merge cases.

Fault tests spawn an actual Node process and exit it:

| Exit point | Verified result |
| --- | --- |
| after synchronized temp, before rename | old project file intact; orphan temp quarantined; accepted Yjs edit later flushed once |
| immediately after rename | new project bytes present; revision replays once and is recognized file-durable |
| after state checkpoint | new bytes and durable revision reopen unchanged |

No broker or crash-worker process remained after the suite. The stock/default
Codex app was not built, modified, installed, or launched.

## Platform boundary

These results verify Linux behavior. The code is Node.js 20+ ESM and avoids a
native dependency, but Windows replacement semantics and macOS/Windows watcher
behavior are not claimed until WP-13 runs their native matrices. The v1
metadata contract preserves the codec fields and POSIX permission mode frozen
in WP-04; platform-specific ACL/xattr preservation is outside that contract
unless WP-13 establishes an additional supported requirement.
