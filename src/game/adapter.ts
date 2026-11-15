/**
 * ════════════════════════════════════════════════════════════════════
 *  方块拼盘（Square Jam）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 规则：
 *   1. 把整个棋盘划分成若干正方形区域（不能出现非正方形）；
 *   2. 数字格表示「该格所在正方形的边长」；一个正方形可以没有数字，
 *      也可以包含多个相同的数字；
 *   3. 任意内部顶点处不能有四条区域边界相交（tatami 规则，
 *      等价于两个正方形不能只在一个点接触）；
 *   4. 题目有唯一解。
 *
 * 交互由 ./interaction.ts 接管：鼠标从一角拖到对角画正方形；键盘方向键 + 回车。
 */

import { playDrop, playPluck } from '../core/audio.ts'
import { flashForMove as coreFlash } from '../core/fx.ts'
import type {
  CustomSupport,
  GameAdapter,
  Move,
  Puzzle,
  SolveResult,
} from '../core/types.ts'
import { interaction } from './interaction.ts'
import { planLogicSolve } from './logic.ts'
import { builtinPuzzles, getReferenceSolution } from './puzzles.ts'
import { hitTest, metricsFor, renderBoard } from './render.ts'
import { solvePuzzle } from './solver.ts'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state.ts'
import {
  asSquarePuzzle,
  decodeClues,
  encodeClues,
  SIZE_BITS,
  unpackRect,
  type SquarePuzzle,
} from './types.ts'
import { statusBits, validate } from './validate.ts'

/* ── 1. 元信息 ── */

const meta = {
  title: '方块拼盘（Square Jam）',
  tagline: '把棋盘切成正方形 · 数字就是边长 · 经典 Square Jam',
  footerNote:
    '规则：把整个棋盘划分成若干正方形（不能出现矩形）；数字格表示它所在正方形的边长；任意顶点处不能有四条区域边界相交（两个正方形不能只在一个点接触）；每道题都有唯一解。',
  storageKeyPrefix: 'square-jam',
  customIdPrefix: 'squarejam-custom-',
  customMinW: 4,
  customMinH: 4,
  customMaxW: 20,
  customMaxH: 20,
  targetKind: 'cell' as const,
  interactionHint:
    '<kbd>左键拖拽</kbd> 从一角拖到对角画正方形 · <kbd>右键</kbd> 删除正方形 · <kbd>方向键</kbd>+<kbd>回车</kbd> 键盘绘制',
}

/* ── 2. 自定义题板 ── */

const CUSTOM_MAX_CLUE = 20
const VALUE_CYCLE: Array<number | null> = [null]
for (let n = 1; n <= CUSTOM_MAX_CLUE; n++) VALUE_CYCLE.push(n)

function clampClue(v: number | null, w: number, h: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const n = Math.round(v)
  if (n < 1) return 0
  return Math.min(n, Math.min(w, h, CUSTOM_MAX_CLUE))
}

function readClues(value: unknown, size: number): number[] | null {
  if (typeof value === 'string') return decodeClues(value, size)
  if (Array.isArray(value)) {
    if (value.length !== size) return null
    const out: number[] = []
    for (const v of value) {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0 || n > 35) return null
      out.push(n)
    }
    return out
  }
  return null
}

const custom: CustomSupport = {
  mode: 'cell',
  valueCycle: VALUE_CYCLE,

  keyForDigit: (digit) => {
    if (digit === 0) return null
    if (digit >= 1 && digit <= 9) return digit
    return undefined
  },

  cellLabel: (v) => (v == null ? '' : String(v)),
  cellClass: (v) => (v == null ? '' : `sj-clue-val`),

  hint:
    '点击格子循环：空 → 1 → 2 → … → 20；数字键 1–9 快速填写，0 清零，. / 退格清空。10–20 请点击格子循环选择。载入后可用「求解」检查是否恰好一解。',

  toGrid: (p) => {
    const clues = (p as SquarePuzzle).clues
    if (!Array.isArray(clues) || clues.length !== p.width * p.height) return null
    return {
      width: p.width,
      height: p.height,
      grid: clues.map((v) => (typeof v === 'number' && v > 0 ? v : null)),
    }
  },

  makePuzzle: (w, h, grid, existingId) => {
    const clues = grid.map((v) => clampClue(v, w, h))
    return {
      id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
      name: `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      clues,
    } satisfies SquarePuzzle
  },

  encodePuzzle: (p) => ({
    clues: encodeClues((p as SquarePuzzle).clues ?? []),
  }),

  decodePuzzle: (record) => {
    if (typeof record.id !== 'string') return null
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const w = record.width
    const h = record.height
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
    const clues = readClues(record.clues, w * h)
    if (!clues) return null
    return {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      clues,
    } satisfies SquarePuzzle
  },
}

/* ── 3. 音效 / 特效 ── */

function playForMove(move: Move, streak: number): void {
  if (move.from === 0) {
    const size = move.index & ((1 << SIZE_BITS) - 1)
    playPluck(streak, Math.max(0.6, Math.min(1.5, 0.7 + size * 0.08)))
  } else {
    playDrop(streak)
  }
}

function flashForMove(
  svg: SVGSVGElement,
  move: Move,
  streak: number,
  m: import('../core/types.ts').BoardMetrics,
): void {
  if (move.from === 0) {
    coreFlash(svg, move, streak, m)
    return
  }
  // 删除：在正方形左上角格子上做涟漪
  const rect = unpackRect(m.width, move.index)
  if (!rect) return
  coreFlash(svg, { index: rect.y * m.width + rect.x, from: 1, to: 0 }, streak, m)
}

/* ── 4. 组装 ── */

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  firstHintMove,
  custom,
  playForMove,
  flashForMove,
  interaction,
}

/** 供调试/测试：题目线索 */
export function cluesOf(puzzle: Puzzle): number[] {
  return asSquarePuzzle(puzzle).clues ?? []
}
