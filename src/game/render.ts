/**
 * 方块拼盘 —— SVG 渲染与命中
 *
 * 视觉层次：棋盘底色 → 正方形填色 → 网格线 → 区域粗边界 → 错误高亮 →
 *          空点 → 数字线索 → 四点相交标记 → 拖拽预览 → 键盘光标 → 命中层
 */

import type { BoardMetrics, GameState, Puzzle, ValidationResult } from '../core/types.ts'
import { regionBoundarySegments } from '../core/board.ts'
import {
  asSquarePuzzle,
  asSquareState,
  packRect,
  sameRect,
  type SquareRect,
} from './types.ts'
import type { SquareResult } from './types.ts'
import {
  allTatamiViolations,
  buildOwner,
  emptyOwners,
  placeRect,
  unplaceRect,
  vertexFromIndex,
  vertexIndex,
} from './partition.ts'
import type { OwnerGrid } from './partition.ts'
import { uiState } from './ui-state.ts'

/** 区域配色：填色 + 粗边界（色相循环，保证相邻区域可区分） */
const PALETTE: Array<{ fill: string; stroke: string }> = [
  { fill: 'hsl(166 42% 91%)', stroke: 'hsl(166 40% 38%)' },
  { fill: 'hsl(32 60% 91%)', stroke: 'hsl(28 55% 42%)' },
  { fill: 'hsl(210 46% 92%)', stroke: 'hsl(212 42% 42%)' },
  { fill: 'hsl(278 34% 93%)', stroke: 'hsl(276 30% 46%)' },
  { fill: 'hsl(2 48% 93%)', stroke: 'hsl(2 42% 48%)' },
  { fill: 'hsl(184 40% 90%)', stroke: 'hsl(188 45% 35%)' },
  { fill: 'hsl(52 58% 90%)', stroke: 'hsl(44 55% 40%)' },
  { fill: 'hsl(322 34% 93%)', stroke: 'hsl(322 30% 46%)' },
  { fill: 'hsl(104 32% 91%)', stroke: 'hsl(108 34% 38%)' },
  { fill: 'hsl(18 55% 92%)', stroke: 'hsl(18 48% 45%)' },
  { fill: 'hsl(238 30% 93%)', stroke: 'hsl(238 28% 46%)' },
  { fill: 'hsl(196 44% 91%)', stroke: 'hsl(198 42% 38%)' },
]

export function paletteOf(index: number): { fill: string; stroke: string } {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!
}

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  const maxSide = Math.max(puzzle.width, puzzle.height)
  const cell = maxSide <= 6 ? 56 : maxSide <= 8 ? 50 : maxSide <= 10 ? 44 : maxSide <= 14 ? 38 : 32
  const pad = Math.round(cell * 0.4)
  return {
    cell,
    pad,
    width: puzzle.width,
    height: puzzle.height,
    svgWidth: pad * 2 + puzzle.width * cell,
    svgHeight: pad * 2 + puzzle.height * cell,
    k: 1,
  }
}

function origin(m: BoardMetrics): { x: number; y: number } {
  return { x: m.originX ?? m.pad, y: m.originY ?? m.pad }
}

export function cellRect(m: BoardMetrics, x: number, y: number): { px: number; py: number } {
  const o = origin(m)
  return { px: o.x + x * m.cell, py: o.y + y * m.cell }
}

export function cellCenter(m: BoardMetrics, x: number, y: number): { cx: number; cy: number } {
  const p = cellRect(m, x, y)
  return { cx: p.px + m.cell / 2, cy: p.py + m.cell / 2 }
}

export function pointCell(
  m: BoardMetrics,
  puzzle: Puzzle,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const o = origin(m)
  const cx = Math.floor((x - o.x) / m.cell)
  const cy = Math.floor((y - o.y) / m.cell)
  if (cx < 0 || cy < 0 || cx >= puzzle.width || cy >= puzzle.height) return null
  return { x: cx, y: cy }
}

export function pointCellClamped(
  m: BoardMetrics,
  puzzle: Puzzle,
  x: number,
  y: number,
): { x: number; y: number } {
  const o = origin(m)
  const cx = Math.floor((x - o.x) / m.cell)
  const cy = Math.floor((y - o.y) / m.cell)
  return {
    x: Math.max(0, Math.min(puzzle.width - 1, cx)),
    y: Math.max(0, Math.min(puzzle.height - 1, cy)),
  }
}

/* ────────────────────────── 预览合法性 ────────────────────────── */

export type PreviewKind = 'add' | 'remove' | 'invalid'

export function evaluatePreview(
  w: number,
  h: number,
  clues: ArrayLike<number>,
  regions: readonly SquareRect[],
  rect: SquareRect,
): PreviewKind {
  if (regions.some((r) => sameRect(r, rect))) return 'remove'
  const owner = buildOwner(regions, w, h).owner
  if (rect.x < 0 || rect.y < 0 || rect.size < 1) return 'invalid'
  if (rect.x + rect.size > w || rect.y + rect.size > h) return 'invalid'
  // 不能重叠
  for (let dy = 0; dy < rect.size; dy++) {
    for (let dx = 0; dx < rect.size; dx++) {
      if (owner[(rect.y + dy) * w + rect.x + dx]! >= 0) return 'invalid'
    }
  }
  // 线索必须匹配
  for (let dy = 0; dy < rect.size; dy++) {
    for (let dx = 0; dx < rect.size; dx++) {
      const clue = clues[(rect.y + dy) * w + rect.x + dx] ?? 0
      if (clue > 0 && clue !== rect.size) return 'invalid'
    }
  }
  // tatami：试放后不能出现四条边界相交
  placeRect(owner, w, rect, 9000)
  const bad = allTatamiViolations(owner, w, h).length > 0
  unplaceRect(owner, w, rect)
  return bad ? 'invalid' : 'add'
}

/* ────────────────────────── 绘制片段 ────────────────────────── */

function previewMarkup(m: BoardMetrics, rect: SquareRect, kind: PreviewKind): string {
  const p = cellRect(m, rect.x, rect.y)
  const side = rect.size * m.cell
  const cls =
    kind === 'invalid' ? 'sj-preview invalid' : kind === 'remove' ? 'sj-preview remove' : 'sj-preview ok'
  const dash = kind === 'remove' ? '4 4' : '7 5'
  const rx = Math.max(2, m.cell * 0.12)
  let out = `<rect class="${cls}" x="${(p.px + 1.5).toFixed(2)}" y="${(p.py + 1.5).toFixed(2)}" width="${(side - 3).toFixed(2)}" height="${(side - 3).toFixed(2)}" rx="${rx.toFixed(2)}" stroke-dasharray="${dash}" />`
  // 四个角上的小方块，强调「从一角拖到对角」
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const cx = p.px + dx * side
    const cy = p.py + dy * side
    out += `<rect class="sj-preview-corner" x="${(cx - 3).toFixed(2)}" y="${(cy - 3).toFixed(2)}" width="6" height="6" rx="1.5" />`
  }
  return out
}

function cursorMarkup(m: BoardMetrics, x: number, y: number): string {
  const p = cellRect(m, x, y)
  return `<rect class="sj-cursor" x="${(p.px + 2).toFixed(2)}" y="${(p.py + 2).toFixed(2)}" width="${(m.cell - 4).toFixed(2)}" height="${(m.cell - 4).toFixed(2)}" rx="${Math.max(2, m.cell * 0.14).toFixed(2)}" />`
}

function tatamiMarkup(m: BoardMetrics, w: number, vertices: number[]): string {
  const r = m.cell * 0.3
  let out = ''
  for (const v of vertices) {
    const { gx, gy } = vertexFromIndex(w, v)
    const o = origin(m)
    const cx = o.x + gx * m.cell
    const cy = o.y + gy * m.cell
    out += `<g class="sj-tatami"><circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" /><path d="M ${(cx - r * 0.62).toFixed(2)} ${(cy - r * 0.62).toFixed(2)} L ${(cx + r * 0.62).toFixed(2)} ${(cy + r * 0.62).toFixed(2)} M ${(cx + r * 0.62).toFixed(2)} ${(cy - r * 0.62).toFixed(2)} L ${(cx - r * 0.62).toFixed(2)} ${(cy + r * 0.62).toFixed(2)}" /></g>`
  }
  return out
}

/* ────────────────────────── 主渲染 ────────────────────────── */

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
): string {
  const m = metricsFor(puzzle)
  const p = asSquarePuzzle(puzzle)
  const s = asSquareState(state)
  const r = result as SquareResult
  const w = puzzle.width
  const h = puzzle.height
  const clues = p.clues ?? []
  const regions = s.regions

  const built = buildOwner(regions, w, h)
  const owner: OwnerGrid = built.owner
  const badCells = new Set<number>(r.badCells ?? [])
  const tatamiCells = new Set<number>(r.tatamiCells ?? [])
  const clueBad = new Set<number>(r.clueBadCells ?? [])
  const clueOpen = new Set<number>(r.clueOpenCells ?? [])
  const pad = m.pad
  const boardW = w * m.cell
  const boardH = h * m.cell

  const parts: string[] = []
  parts.push(
    `<rect class="sj-board-bg" x="${pad - 8}" y="${pad - 8}" width="${boardW + 16}" height="${boardH + 16}" rx="${(m.cell * 0.2).toFixed(2)}" />`,
  )

  // 1) 正方形填色
  for (let i = 0; i < regions.length; i++) {
    const rect = regions[i]!
    const pos = cellRect(m, rect.x, rect.y)
    const side = rect.size * m.cell
    const pal = paletteOf(i)
    parts.push(
      `<rect class="sj-region" data-index="${packRect(w, rect)}" data-region="${packRect(w, rect)}" data-owner="${i}" x="${pos.px.toFixed(2)}" y="${pos.py.toFixed(2)}" width="${side.toFixed(2)}" height="${side.toFixed(2)}" fill="${pal.fill}" />`,
    )
    // 区域边长小标签（右下角，弱化显示，便于核对面积）
    parts.push(
      `<text class="sj-size" x="${(pos.px + side - m.cell * 0.18).toFixed(2)}" y="${(pos.py + side - m.cell * 0.16).toFixed(2)}">${rect.size}</text>`,
    )
  }

  // 2) 网格线
  const grid: string[] = []
  for (let x = 0; x <= w; x++) {
    const px = pad + x * m.cell
    grid.push(`M ${px.toFixed(2)} ${pad.toFixed(2)} V ${(pad + boardH).toFixed(2)}`)
  }
  for (let y = 0; y <= h; y++) {
    const py = pad + y * m.cell
    grid.push(`M ${pad.toFixed(2)} ${py.toFixed(2)} H ${(pad + boardW).toFixed(2)}`)
  }
  parts.push(`<path class="sj-grid" d="${grid.join(' ')}" />`)

  // 3) 区域粗边界
  const bd = regionBoundarySegments(m, owner)
  if (bd.length) {
    const d = bd.map((seg) => `M ${seg.x1.toFixed(2)} ${seg.y1.toFixed(2)} L ${seg.x2.toFixed(2)} ${seg.y2.toFixed(2)}`).join(' ')
    parts.push(`<path class="sj-border" d="${d}" />`)
  }

  // 4) 错误高亮 + 空点
  for (let i = 0; i < w * h; i++) {
    const x = i % w
    const y = (i / w) | 0
    const pos = cellRect(m, x, y)
    if (owner[i]! < 0 && (clues[i] ?? 0) === 0) {
      const c = cellCenter(m, x, y)
      parts.push(`<circle class="sj-empty-dot" cx="${c.cx.toFixed(2)}" cy="${c.cy.toFixed(2)}" r="${(m.cell * 0.045).toFixed(2)}" />`)
    }
    if (badCells.has(i)) {
      parts.push(
        `<rect class="sj-cell-bad" x="${(pos.px + 1.5).toFixed(2)}" y="${(pos.py + 1.5).toFixed(2)}" width="${(m.cell - 3).toFixed(2)}" height="${(m.cell - 3).toFixed(2)}" rx="${(m.cell * 0.1).toFixed(2)}" />`,
      )
    }
    if (tatamiCells.has(i)) {
      parts.push(
        `<rect class="sj-cell-tatami" x="${(pos.px + 1.5).toFixed(2)}" y="${(pos.py + 1.5).toFixed(2)}" width="${(m.cell - 3).toFixed(2)}" height="${(m.cell - 3).toFixed(2)}" rx="${(m.cell * 0.1).toFixed(2)}" />`,
      )
    }
  }

  // 5) 数字线索
  for (let i = 0; i < w * h; i++) {
    const clue = clues[i] ?? 0
    if (clue <= 0) continue
    const x = i % w
    const y = (i / w) | 0
    const c = cellCenter(m, x, y)
    const ownerIdx = owner[i]!
    const satisfied = ownerIdx >= 0 && regions[ownerIdx]?.size === clue
    let cls = 'sj-clue'
    if (clueBad.has(i)) cls += ' bad'
    else if (satisfied) cls += ' satisfied'
    else if (clueOpen.has(i) && ownerIdx < 0) cls += ' open'
    const fontSize = clue >= 10 ? m.cell * 0.36 : m.cell * 0.44
    parts.push(
      `<text class="${cls}" x="${c.cx.toFixed(2)}" y="${(c.cy + m.cell * 0.02).toFixed(2)}" style="font-size:${fontSize.toFixed(2)}px">${clue}</text>`,
    )
  }

  // 6) 四点相交标记
  parts.push(tatamiMarkup(m, w, r.tatamiVertices ?? []))

  // 7) 拖拽预览
  let live = ''
  if (uiState.preview) {
    const kind = evaluatePreview(w, h, clues, regions, uiState.preview)
    uiState.previewValid = kind !== 'invalid'
    live = previewMarkup(m, uiState.preview, kind)
  }
  parts.push(`<g id="sj-live">${live}</g>`)

  // 8) 键盘光标
  if (uiState.cursorVisible && !uiState.preview) {
    parts.push(cursorMarkup(m, uiState.cursor.x, uiState.cursor.y))
  }

  // 9) 命中层（data-cell 避免与区域打包索引冲突）
  for (let i = 0; i < w * h; i++) {
    const x = i % w
    const y = (i / w) | 0
    const pos = cellRect(m, x, y)
    parts.push(
      `<rect class="cell-hit" data-cell="${i}" x="${pos.px.toFixed(2)}" y="${pos.py.toFixed(2)}" width="${m.cell.toFixed(2)}" height="${m.cell.toFixed(2)}" />`,
    )
  }

  return `<svg class="board-svg sj-board" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

/** 拖拽过程中只更新预览层，避免整块 SVG 重建打断指针捕获 */
export function updateLivePreview(
  svg: SVGSVGElement,
  m: BoardMetrics,
  puzzle: Puzzle,
  state: GameState,
): void {
  const live = svg.querySelector<SVGGElement>('#sj-live')
  if (!live) return
  const preview = uiState.preview
  if (!preview) {
    live.innerHTML = ''
    return
  }
  const p = asSquarePuzzle(puzzle)
  const s = asSquareState(state)
  const kind = evaluatePreview(puzzle.width, puzzle.height, p.clues ?? [], s.regions, preview)
  uiState.previewValid = kind !== 'invalid'
  live.innerHTML = previewMarkup(m, preview, kind)
}

export function hitTest(
  m: BoardMetrics,
  puzzle: Puzzle,
  x: number,
  y: number,
): { index: number } | null {
  const cell = pointCell(m, puzzle, x, y)
  if (!cell) return null
  return { index: cell.y * m.width + cell.x }
}

/** 供校验层/测试使用：状态是否正确 */
export function ownerGridOf(state: GameState): OwnerGrid {
  const s = asSquareState(state)
  return buildOwner(s.regions, s.width, s.height).owner
}

/** 当前 tatami 冲突顶点（用于交互提示） */
export function tatamiOf(state: GameState): number[] {
  const s = asSquareState(state)
  return allTatamiViolations(buildOwner(s.regions, s.width, s.height).owner, s.width, s.height)
}

/** 空盘 owner 网格（调试/测试用） */
export function emptyOwnerGrid(w: number, h: number): OwnerGrid {
  return emptyOwners(w, h)
}

/** 顶点索引小工具（测试用） */
export { vertexIndex, vertexFromIndex }
