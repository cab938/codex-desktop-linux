/*
 * SPDX-License-Identifier: MIT
 * Derived from Glyphdown commit faf98d07c1aa939a3ee5b3d29cc600bde12a38e6.
 * Modified for Collaborative Markdown Editor; see UPSTREAM.md.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { indentLess } from '@codemirror/commands'
import { EditorSelection, EditorState, Transaction, type Extension, type StateCommand } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { glyphdownMarkdown, markdownTab, markdownTabCommand } from '../src/index.ts'

beforeAll(() => {
  // jsdom lacks layout APIs CodeMirror's measure cycle expects.
  Range.prototype.getClientRects = function () {
    return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame
  }
})

function tabState(doc: string, anchor = 0, head = anchor, extra: Extension = []): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [glyphdownMarkdown(), markdownTab(), extra],
  })
}

/** Run a state command the way the keymap would, returning the next state. */
function press(state: EditorState, command: StateCommand = markdownTabCommand): EditorState {
  let next = state
  const handled = command({
    state,
    dispatch: (tr: Transaction) => {
      next = tr.state
    },
  })
  expect(handled).toBe(true)
  return next
}

function cursor(state: EditorState): number {
  return state.selection.main.head
}

describe('markdown tab: list item lines indent', () => {
  it('indents a bullet line by 2 spaces, then 4, and Shift-Tab undoes it', () => {
    let state = tabState('- item', 6)
    state = press(state)
    expect(state.doc.toString()).toBe('  - item')
    expect(cursor(state)).toBe(8) // cursor mapped along
    state = press(state)
    expect(state.doc.toString()).toBe('    - item')
    state = press(state, indentLess)
    expect(state.doc.toString()).toBe('  - item')
    state = press(state, indentLess)
    expect(state.doc.toString()).toBe('- item')
  })

  it('indents ordered list and task list lines', () => {
    const ordered = press(tabState('1. item', 3))
    expect(ordered.doc.toString()).toBe('  1. item')
    const task = press(tabState('- [ ] task', 10))
    expect(task.doc.toString()).toBe('  - [ ] task')
  })

  it('indents from any cursor position on the list line', () => {
    const state = press(tabState('- item', 0))
    expect(state.doc.toString()).toBe('  - item')
  })
})

describe('markdown tab: selections indent lines', () => {
  it('indents both lines of a selection spanning two lines', () => {
    const state = press(tabState('one\ntwo', 1, 5))
    expect(state.doc.toString()).toBe('  one\n  two')
  })
})

describe('markdown tab: cursor insertion on non-list lines', () => {
  it('inserts 2 spaces at a mid-line cursor in a paragraph (not at line start)', () => {
    const state = press(tabState('hello world', 5))
    expect(state.doc.toString()).toBe('hello   world')
    expect(cursor(state)).toBe(7)
  })

  it('inserts the indent unit at the cursor inside a code fence (decision: cursor insert, not line indent)', () => {
    const state = press(tabState('```\ncode\n```', 4))
    expect(state.doc.toString()).toBe('```\n  code\n```')
    expect(cursor(state)).toBe(6)
  })

  it('tags the insertion as input.type', () => {
    const state = tabState('hello', 5)
    let userEvent: string | undefined
    markdownTabCommand({
      state,
      dispatch: (tr: Transaction) => {
        userEvent = tr.annotation(Transaction.userEvent)
      },
    })
    expect(userEvent).toBe('input.type')
  })
})

describe('markdown tab: keymap wiring (jsdom)', () => {
  function keydown(view: EditorView, shiftKey = false): void {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }))
  }

  it('binds Tab and Shift-Tab in the view', () => {
    const view = new EditorView({
      state: tabState('- item', 6),
      parent: document.body,
    })
    keydown(view)
    expect(view.state.doc.toString()).toBe('  - item')
    keydown(view, true)
    expect(view.state.doc.toString()).toBe('- item')
    view.destroy()
  })
})
