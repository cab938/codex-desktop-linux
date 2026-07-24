/*
 * SPDX-License-Identifier: MIT
 * Selected from Glyphdown commit
 * faf98d07c1aa939a3ee5b3d29cc600bde12a38e6.
 * Modified for Collaborative Markdown Editor; see UPSTREAM.md.
 */

export {
  DEGENERATE_DELETE_RATIO,
  applyDiffsToYText,
  computeMergedTarget,
  mergePush,
  normalizeEol,
} from './merge.ts'
export type { MergeComputation, MergeOptions, PushResult } from './merge.ts'
