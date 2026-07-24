/*
 * SPDX-License-Identifier: MIT
 * Derived from Glyphdown commit faf98d07c1aa939a3ee5b3d29cc600bde12a38e6.
 * Modified for Collaborative Markdown Editor; see UPSTREAM.md.
 */
import * as Y from 'yjs'
import * as fc from 'fast-check'

export function docWith(text: string): Y.Text {
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  ytext.insert(0, text)
  return ytext
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

export const wordArb = fc
  .array(fc.constantFrom(...LETTERS), { minLength: 3, maxLength: 8 })
  .map((cs) => cs.join(''))

/** Paragraphs made unique by an index marker so fuzzy matching can't legitimately confuse them. */
export const paragraphsArb = fc
  .array(fc.array(wordArb, { minLength: 4, maxLength: 8 }), { minLength: 4, maxLength: 8 })
  .map((ps) => ps.map((ws, i) => `para${i}: ${ws.join(' ')}`))

export function joinParas(paragraphs: string[]): string {
  return paragraphs.join('\n\n')
}
