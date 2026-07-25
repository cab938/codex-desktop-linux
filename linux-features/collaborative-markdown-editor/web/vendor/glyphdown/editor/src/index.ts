/*
 * SPDX-License-Identifier: MIT
 * Selected from Glyphdown commit
 * faf98d07c1aa939a3ee5b3d29cc600bde12a38e6.
 * Modified for Collaborative Markdown Editor; see UPSTREAM.md.
 */

export { glyphdownMarkdown, highlightExtension } from './markdown.ts'
export {
  markdownAutoClose,
  autoCloseInsert,
  autoCloseBackspace,
  markdownFormat,
} from './autoclose.ts'
export { markdownTab, markdownTabCommand } from './tab.ts'
export {
  MAX_QUOTE_DEPTH,
  imageResolver,
  listHangPrefixes,
  listHangingIndent,
  livePreview,
  livePreviewField,
  parseImageSize,
  renderedHangWidth,
  resolveImageSrc,
  toggleCheckboxChange,
} from './live-preview.ts'
export type {
  ImageSize,
  RenderedHang,
  RenderedMarkerMetrics,
} from './live-preview.ts'
export { commentField, findComments } from './comment.ts'
export type { InlineComment } from './comment.ts'
export { glyphdownCollab } from './collab.ts'
export {
  glyphdownHighlightStyle,
  glyphdownHighlighting,
  glyphdownTheme,
} from './theme.ts'
export {
  CALLOUT_ALIASES,
  CALLOUT_COLORS,
  CALLOUT_ICONS,
  canonicalCalloutType,
  fallbackCalloutTitle,
  parseCalloutHeader,
} from './callout.ts'
export type { CalloutHeader } from './callout.ts'
export { findFootnoteDefinition, footnoteExtension } from './footnote.ts'
export {
  ADD_BUTTON_SIZE,
  ADDROW_TO_SCROLLBAR_GAP,
  DEFAULT_BOTTOM_PADDING,
  HANDLE_HEIGHT,
  HANDLE_WIDTH,
  SCROLLBAR_BOTTOM_PAD,
  SCROLLBAR_HEIGHT,
  TABLE_MARGIN_BOTTOM,
  TABLE_TO_ADDROW_GAP,
  buildTableModel,
  computeTableAddButtons,
  computeTableBleed,
  computeTableBottomGutter,
  computeTableHandles,
  computeTableScrollbar,
  parseDelimiterAlignments,
} from './table.ts'
export type {
  CellSpan,
  TableAddButtons,
  TableAddButtonsInput,
  TableAlign,
  TableBleed,
  TableBleedInput,
  TableBottomGutter,
  TableCellModel,
  TableHandlePlacement,
  TableHandles,
  TableHandlesInput,
  TableModel,
  TableScrollbar,
  TableScrollbarInput,
} from './table.ts'
export {
  applyTableOp,
  diffReplace,
  escapeCellText,
  findTableAt,
  parseTableGrid,
  setTableEditEffect,
  splitTableRow,
  tableEditField,
  tableEditor,
} from './table-edit.ts'
export type {
  TableCellSlice,
  TableGrid,
  TableLineSlice,
  TableOp,
} from './table-edit.ts'
export { mathSyntax } from './math-syntax.ts'
export {
  delimitedMath,
  katexIfLoaded,
  loadKatex,
  mathField,
  mathPreview,
  MathWidget,
  renderMathInto,
} from './math.ts'
