// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { undoDepth as codeMirrorUndoDepth } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import * as Y from 'yjs'
import { createMarkdownEditor } from '../src/editor.ts'

beforeAll(() => {
  Range.prototype.getClientRects = function () {
    return {
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    } as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0)) as typeof requestAnimationFrame
  }
})

function mount(text: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const editor = createMarkdownEditor({ parent, ytext })
  return { ydoc, ytext, parent, editor }
}

describe('one-Y.Text editor adapter', () => {
  it('does not duplicate initial Markdown', () => {
    const { ydoc, ytext, editor } = mount('# Title\n\nBody')
    expect(editor.view.state.doc.toString()).toBe('# Title\n\nBody')
    expect(ytext.toString()).toBe('# Title\n\nBody')
    expect([...ydoc.share.keys()]).toEqual(['content'])
    editor.destroy()
  })

  it('lands local CodeMirror edits in the shared Y.Text', () => {
    const { ytext, editor } = mount('hello')
    editor.view.dispatch({
      changes: { from: 5, insert: ' human' },
      selection: EditorSelection.cursor(11),
      userEvent: 'input.type',
    })
    expect(ytext.toString()).toBe('hello human')
    expect(editor.view.state.doc.toString()).toBe('hello human')
    editor.destroy()
  })

  it('renders remote Yjs transactions without a second view model', () => {
    const { ydoc, ytext, editor } = mount('hello')
    ydoc.transact(() => ytext.insert(0, 'agent: '), 'test-agent')
    expect(editor.view.state.doc.toString()).toBe('agent: hello')
    expect([...ydoc.share.keys()]).toEqual(['content'])
    editor.destroy()
  })

  it('uses Yjs undo and preserves selection/document through source-mode toggles', () => {
    const { ytext, editor } = mount('hello')
    editor.view.dispatch({
      changes: { from: 5, insert: '!' },
      selection: EditorSelection.cursor(6),
      userEvent: 'input.type',
    })
    expect(ytext.toString()).toBe('hello!')
    editor.setLivePreview(false)
    expect(editor.isLivePreview()).toBe(false)
    expect(editor.view.state.doc.toString()).toBe('hello!')
    expect(editor.view.state.selection.main.head).toBe(6)
    expect(editor.undo()).toBe(true)
    expect(ytext.toString()).toBe('hello')
    expect(editor.view.state.doc.toString()).toBe('hello')
    expect(editor.redo()).toBe(true)
    expect(ytext.toString()).toBe('hello!')
    editor.destroy()
  })

  it('does not install a parallel CodeMirror history field', () => {
    const { editor } = mount('hello')
    editor.view.dispatch({
      changes: { from: 5, insert: '!' },
      userEvent: 'input.type',
    })
    expect(codeMirrorUndoDepth(editor.view.state)).toBe(0)
    expect(editor.undoManager.undoStack).toHaveLength(1)
    editor.destroy()
  })

  it('rejects a detached Y.Text', () => {
    expect(() =>
      createMarkdownEditor({
        parent: document.createElement('div'),
        ytext: new Y.Text(),
      }),
    ).toThrow(/attached to a Y\.Doc/)
  })
})
