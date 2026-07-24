import { defaultKeymap } from '@codemirror/commands'
import {
  Compartment,
  EditorState,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  keymap,
} from '@codemirror/view'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  glyphdownCollab,
  glyphdownHighlighting,
  glyphdownMarkdown,
  glyphdownTheme,
  livePreview,
  markdownAutoClose,
  markdownTab,
} from '../vendor/glyphdown/editor/src/index.ts'

export interface MarkdownEditorOptions {
  parent: HTMLElement
  ytext: Y.Text
  awareness?: Awareness | null
  undoManager?: Y.UndoManager
  livePreview?: boolean
  readOnly?: boolean
  extensions?: Extension
}

export interface MarkdownEditor {
  readonly view: EditorView
  readonly ytext: Y.Text
  readonly undoManager: Y.UndoManager
  readonly isLivePreview: () => boolean
  setLivePreview(enabled: boolean): void
  setReadOnly(enabled: boolean): void
  undo(): boolean
  redo(): boolean
  destroy(): void
}

/**
 * Build one CodeMirror view over the caller's one Y.Text.
 *
 * Yjs owns document history and synchronization. Do not add CodeMirror
 * history() or initialize a second document model beside this adapter.
 */
export function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditor {
  if (!options.ytext.doc) {
    throw new Error('The collaborative Markdown Y.Text must be attached to a Y.Doc')
  }

  const previewCompartment = new Compartment()
  const readOnlyCompartment = new Compartment()
  const undoManager = options.undoManager ?? new Y.UndoManager(options.ytext)
  const ownsUndoManager = options.undoManager === undefined
  let previewEnabled = options.livePreview ?? true
  let destroyed = false

  const previewExtension = (): Extension =>
    previewEnabled ? livePreview() : []

  const view = new EditorView({
    state: EditorState.create({
      doc: options.ytext.toString(),
      extensions: [
        keymap.of(defaultKeymap),
        EditorView.lineWrapping,
        glyphdownMarkdown(),
        glyphdownHighlighting(),
        glyphdownTheme,
        markdownAutoClose(),
        markdownTab(),
        previewCompartment.of(previewExtension()),
        readOnlyCompartment.of(
          EditorState.readOnly.of(options.readOnly ?? false),
        ),
        glyphdownCollab(
          options.ytext,
          options.awareness ?? null,
          undoManager,
        ),
        options.extensions ?? [],
      ],
    }),
    parent: options.parent,
  })

  return {
    view,
    ytext: options.ytext,
    undoManager,
    isLivePreview: () => previewEnabled,
    setLivePreview(enabled: boolean) {
      if (destroyed || previewEnabled === enabled) return
      previewEnabled = enabled
      view.dispatch({
        effects: previewCompartment.reconfigure(previewExtension()),
      })
    },
    setReadOnly(enabled: boolean) {
      if (destroyed) return
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(
          EditorState.readOnly.of(enabled),
        ),
      })
    },
    undo: () => undoManager.undo() !== null,
    redo: () => undoManager.redo() !== null,
    destroy() {
      if (destroyed) return
      destroyed = true
      view.destroy()
      if (ownsUndoManager) undoManager.destroy()
    },
  }
}
