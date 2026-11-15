/**
 * 方块拼盘 —— 棋盘交互
 *
 * 鼠标：
 *   - 左键从某个格子按下，拖到目标格后松开：以「按下的格子 + 目标格」确定一个正方形。
 *     正方形取能覆盖两点的最小 size×size，拖动时实时显示幽灵正方形；
 *     若该正方形已存在则松开 = 删除（可用来「反向擦除」）。
 *   - 单击某一格：放置 / 删除 1×1 正方形。
 *   - 右键点已有正方形：删除。
 *
 * 键盘：
 *   - 方向键移动光标；回车开始选正方形；移动方向键调整对角；再按回车完成；
 *   - Esc 取消当前绘制（没有绘制时交给模板清空盘面）；
 *   - Backspace / Delete 删除光标所在正方形。
 */

import type { GameInteraction, KeyContext, Move, PointerContext } from '../core/types.ts'
import {
  asSquarePuzzle,
  asSquareState,
  packRect,
  sameRect,
  type SquareRect,
} from './types.ts'
import {
  evaluatePreview,
  updateLivePreview,
  pointCell,
  pointCellClamped,
  type PreviewKind,
} from './render.ts'
import { clampCursor, resetUi, uiState } from './ui-state.ts'
import { buildOwner } from './partition.ts'
import { validate } from './validate.ts'

interface Anchor {
  x: number
  y: number
}

interface DragSession {
  anchor: Anchor
}

let mouseDrag: DragSession | null = null
let keyDrag: DragSession | null = null

/** 由锚点与目标格确定正方形：取能同时覆盖两个格子的最小正方形 */
export function squareFromCells(anchor: Anchor, cell: Anchor, w: number, h: number): SquareRect {
  const dx = cell.x - anchor.x
  const dy = cell.y - anchor.y
  const span = Math.max(Math.abs(dx), Math.abs(dy)) + 1
  const size = Math.max(1, Math.min(span, w, h))
  let x = dx >= 0 ? anchor.x : anchor.x - size + 1
  let y = dy >= 0 ? anchor.y : anchor.y - size + 1
  x = Math.max(0, Math.min(x, w - size))
  y = Math.max(0, Math.min(y, h - size))
  return { x, y, size }
}

function previewKind(ctx: PointerContext | KeyContext, rect: SquareRect): PreviewKind {
  const puzzle = ctx.puzzle
  const state = ctx.state
  if (!puzzle || !state) return 'invalid'
  const p = asSquarePuzzle(puzzle)
  const s = asSquareState(state)
  return evaluatePreview(p.width, p.height, p.clues ?? [], s.regions, rect)
}

/**
 * 提交一个正方形：已存在则删除，否则放置；非法时给出原因。
 * 每次手势只产生一步（一次撤销即可回退）。
 */
function commitRect(ctx: PointerContext | KeyContext, rect: SquareRect, w: number): void {
  if (!ctx.puzzle || !ctx.state) return
  const puzzle = ctx.puzzle
  const kind = previewKind(ctx, rect)
  if (kind === 'invalid') {
    ctx.status(
      '不能放在这里：与已有正方形重叠、数字与边长不符，或会造成四点相交。',
      'bad',
    )
    ctx.render()
    return
  }
  const move: Move =
    kind === 'remove'
      ? { index: packRect(w, rect), from: 1, to: 0 }
      : { index: packRect(w, rect), from: 0, to: 1 }
  ctx.commit(move)
  ctx.render()
  const solved = validate(ctx.state, puzzle).solved
  if (solved) return
  ctx.status(
    kind === 'remove'
      ? `已删除 ${rect.size}×${rect.size} 正方形。`
      : `已画出 ${rect.size}×${rect.size} 正方形（左上角 ${rect.x + 1},${rect.y + 1}）。`,
    'ok',
  )
}

function removeAtCell(ctx: PointerContext | KeyContext, w: number): boolean {
  if (!ctx.puzzle || !ctx.state) return false
  const s = asSquareState(ctx.state)
  const anchor = mouseDrag?.anchor ?? keyDrag?.anchor ?? uiState.cursor
  const owner = buildOwner(s.regions, s.width, s.height).owner
  const idx = owner[anchor.y * w + anchor.x]
  if (idx === undefined || idx < 0) return false
  const rect = s.regions[idx]
  if (!rect) return false
  commitRect(ctx, rect, w)
  return true
}

/* ────────────────────────── 指针 ────────────────────────── */

function onDown(ctx: PointerContext): boolean {
  if (!ctx.point) return false
  const p = asSquarePuzzle(ctx.puzzle)
  const w = p.width
  const h = p.height
  const cell = pointCell(ctx.metrics, p, ctx.point.x, ctx.point.y)
  if (!cell) return false

  // 右键：删除该格所在正方形
  if (ctx.event.button === 2) {
    keyDrag = null
    uiState.preview = null
    uiState.anchor = null
    if (removeAtCell(ctx, w)) return true
    ctx.status('这里还没有正方形。右键已画的正方形可以删除它。')
    return true
  }
  if (ctx.event.button !== 0) return false

  if (keyDrag) {
    keyDrag = null
    uiState.preview = null
    uiState.anchor = null
  }
  mouseDrag = { anchor: cell }
  uiState.anchor = { ...cell }
  uiState.cursor = { ...cell }
  uiState.cursorVisible = false
  uiState.preview = squareFromCells(cell, cell, w, h)
  updateLivePreview(ctx.svg, ctx.metrics, p, ctx.state)
  ctx.status('拖到正方形的对角后松开即可画出正方形；单击放置 1×1。')
  return true
}

function onMove(ctx: PointerContext): void {
  if (!mouseDrag || !ctx.point) return
  const p = asSquarePuzzle(ctx.puzzle)
  const cell = pointCellClamped(ctx.metrics, p, ctx.point.x, ctx.point.y)
  uiState.preview = squareFromCells(mouseDrag.anchor, cell, p.width, p.height)
  updateLivePreview(ctx.svg, ctx.metrics, p, ctx.state)
}

function onUp(ctx: PointerContext): void {
  if (!mouseDrag) return
  const p = asSquarePuzzle(ctx.puzzle)
  const rect = uiState.preview
  mouseDrag = null
  uiState.anchor = null
  uiState.preview = null
  if (!rect) {
    ctx.render()
    return
  }
  uiState.cursor = { x: rect.x, y: rect.y }
  commitRect(ctx, rect, p.width)
}

function onCancel(): void {
  mouseDrag = null
  keyDrag = null
  uiState.preview = null
  uiState.anchor = null
}

function onReset(): void {
  mouseDrag = null
  keyDrag = null
  resetUi()
}

/* ────────────────────────── 键盘 ────────────────────────── */

function onKey(ctx: KeyContext): boolean {
  if (!ctx.puzzle || !ctx.state || !ctx.metrics) return false
  const p = asSquarePuzzle(ctx.puzzle)
  const w = p.width
  const h = p.height
  const key = ctx.event.key

  if (key === 'Escape') {
    if (keyDrag || uiState.preview) {
      ctx.event.preventDefault()
      keyDrag = null
      mouseDrag = null
      uiState.preview = null
      uiState.anchor = null
      uiState.cursorVisible = true
      ctx.render()
      ctx.status('已取消绘制。')
      return true
    }
    return false
  }

  if (key === 'Enter') {
    ctx.event.preventDefault()
    uiState.cursorVisible = true
    if (!keyDrag) {
      keyDrag = { anchor: { ...uiState.cursor } }
      uiState.anchor = { ...uiState.cursor }
      uiState.preview = { x: uiState.cursor.x, y: uiState.cursor.y, size: 1 }
      ctx.render()
      ctx.status('已选起点：用方向键移到对角，再按回车完成；Esc 取消。')
      return true
    }
    const rect = uiState.preview
    keyDrag = null
    uiState.preview = null
    uiState.anchor = null
    if (rect) {
      uiState.cursor = { x: rect.x, y: rect.y }
      commitRect(ctx, rect, w)
    } else {
      ctx.render()
    }
    return true
  }

  if (key === 'Backspace' || key === 'Delete') {
    ctx.event.preventDefault()
    keyDrag = null
    uiState.preview = null
    uiState.anchor = null
    if (!removeAtCell(ctx, w)) {
      ctx.status('光标位置没有正方形。')
      ctx.render()
    }
    return true
  }

  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
    ctx.event.preventDefault()
    uiState.cursorVisible = true
    const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
    const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
    const next = clampCursor(uiState.cursor.x + dx, uiState.cursor.y + dy, w, h)
    uiState.cursor = next
    if (keyDrag) {
      uiState.preview = squareFromCells(keyDrag.anchor, next, w, h)
    }
    ctx.render()
    return true
  }

  return false
}

/* ────────────────────────── 导出 ────────────────────────── */

export const interaction: GameInteraction = {
  down: onDown,
  move: onMove,
  up: onUp,
  cancel: onCancel,
  reset: onReset,
  handleKey: onKey,
}

/** 供测试/调试：当前拖拽状态 */
export function interactionDebug(): { mouse: boolean; keyboard: boolean; preview: SquareRect | null } {
  return { mouse: !!mouseDrag, keyboard: !!keyDrag, preview: uiState.preview ? { ...uiState.preview } : null }
}

export function isSamePreview(rect: SquareRect): boolean {
  return !!uiState.preview && sameRect(uiState.preview, rect)
}

/** 供单元测试使用：不经过 DOM 直接算预览类型 */
export function previewKindFor(
  w: number,
  h: number,
  clues: number[],
  regions: SquareRect[],
  rect: SquareRect,
): PreviewKind {
  return evaluatePreview(w, h, clues, regions, rect)
}
