import { EditorSelection } from '@codemirror/state'
import * as Y from 'yjs'
import { createMarkdownEditor } from './editor.ts'
import './style.css'

const editorRoot = requiredElement<HTMLElement>('editor')
const previewButton = requiredElement<HTMLButtonElement>('preview')
const undoButton = requiredElement<HTMLButtonElement>('undo')
const redoButton = requiredElement<HTMLButtonElement>('redo')
const agentButton = requiredElement<HTMLButtonElement>('agent-edit')
const status = requiredElement<HTMLElement>('status')

const ydoc = new Y.Doc()
const ytext = ydoc.getText('content')
ytext.insert(
  0,
  [
    '# Shared Markdown',
    '',
    'This independent build proves the adapted Glyphdown editor is a view over one `Y.Text`.',
    '',
    '- [ ] Human edit',
    '- [ ] Agent edit',
    '',
    '> [!note] Production transport and persistence arrive in the next work packages.',
    '',
  ].join('\n'),
)

const editor = createMarkdownEditor({
  parent: editorRoot,
  ytext,
  livePreview: true,
})

previewButton.addEventListener('click', () => {
  const next = !editor.isLivePreview()
  editor.setLivePreview(next)
  previewButton.setAttribute('aria-pressed', String(next))
  previewButton.textContent = next ? 'Live preview' : 'Raw source'
})

undoButton.addEventListener('click', () => {
  editor.undo()
  editor.view.focus()
})

redoButton.addEventListener('click', () => {
  editor.redo()
  editor.view.focus()
})

agentButton.addEventListener('click', () => {
  ydoc.transact(() => {
    ytext.insert(ytext.length, '\nAgent transaction reached the same Y.Text.\n')
  }, 'preview-agent')
  editor.view.dispatch({
    selection: EditorSelection.cursor(editor.view.state.doc.length),
    scrollIntoView: true,
  })
  status.textContent = 'agent transaction applied · one Y.Text'
})

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}
