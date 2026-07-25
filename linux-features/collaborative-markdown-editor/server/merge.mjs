/*
 * SPDX-License-Identifier: MIT
 * Derived from Glyphdown commit faf98d07c1aa939a3ee5b3d29cc600bde12a38e6.
 * Kept as runtime ESM because the broker cannot import the TypeScript donor
 * source directly. See UPSTREAM.md.
 */
import {
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  applyPatches,
  cleanupSemantic,
  makeDiff,
  makePatches,
  stringifyPatch,
} from '@sanity/diff-match-patch'

export const DEGENERATE_DELETE_RATIO = 0.6

export function computeMergedTarget(current, baseText, newText) {
  const drifted = current !== baseText
  if (baseText === newText) {
    return {
      target: current,
      failedHunks: [],
      deletedRatio: 0,
      drifted,
    }
  }
  const diffs = cleanupSemantic(makeDiff(baseText, newText))
  const deleted = diffs.reduce(
    (total, [operation, chunk]) =>
      operation === DIFF_DELETE ? total + chunk.length : total,
    0,
  )
  const deletedRatio = deleted / Math.max(baseText.length, 1)
  if (!drifted) {
    return { target: newText, failedHunks: [], deletedRatio, drifted }
  }
  const patches = makePatches(diffs)
  const [target, results] = applyPatches(patches, current)
  const failedHunks = patches
    .filter((_patch, index) => !results[index])
    .map((patch) => stringifyPatch(patch))
  return { target, failedHunks, deletedRatio, drifted }
}

export function applyTextTarget(ytext, target, origin) {
  const current = ytext.toString()
  if (current === target) return 0
  const diffs = cleanupSemantic(makeDiff(current, target))
  const doc = ytext.doc
  if (!doc) throw new Error('Y.Text must be attached to a Y.Doc')
  let changes = 0
  doc.transact(() => {
    let index = 0
    for (const [operation, chunk] of diffs) {
      if (operation === DIFF_EQUAL) {
        index += chunk.length
      } else if (operation === DIFF_DELETE) {
        ytext.delete(index, chunk.length)
        changes += 1
      } else if (operation === DIFF_INSERT) {
        ytext.insert(index, chunk)
        index += chunk.length
        changes += 1
      }
    }
  }, origin)
  return changes
}
