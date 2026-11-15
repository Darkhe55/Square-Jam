/**
 * 方块拼盘（Square Jam）—— 游戏专用类型与编码
 *
 * 棋盘被划分为若干「正方形区域」（region），每个区域用 { x, y, size } 描述：
 *   - x / y 为左上角格子坐标，size 为边长；
 *   - 棋盘必须被正方形恰好覆盖一次（不能重叠、不能不覆盖）；
 *   - 数字线索表示「该格所在正方形的边长」；
 *   - 任意内部顶点处，四个相邻格不能两两属于不同区域（不允许四条区域边界在同一点相交，
 *     也就是两个正方形不能只在一个点接触 —— tatami 规则）。
 *
 * 约定与模板核心一致：Move.from / Move.to 中 0 = 未定 / 不存在，1 = 区域存在。
 * 一次落子用 Move.index 打包一个正方形：((cell + 1) << 7) | size。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types.ts'

/** 一局游戏里允许的最大边长（自定义题板建议上限 20×20） */
export const MAX_SIDE = 35

/** 打包 Move.index 时 size 占用的位数（必须 > log2(MAX_SIDE)） */
export const SIZE_BITS = 7
const SIZE_MASK = (1 << SIZE_BITS) - 1

/** 正方形区域 */
export interface SquareRect {
  x: number
  y: number
  size: number
}

/** 题面：在模板 Puzzle 上增加数字线索（0 = 没有数字，正整数 = 边长） */
export interface SquarePuzzle extends Puzzle {
  clues: number[]
  /** 参考解编码串（每格一个 base36 字符，表示该格所属正方形编号） */
  solution?: string
}

/** 棋盘状态：当前已画出的正方形区域列表 */
export interface SquareState extends GameState {
  regions: SquareRect[]
}

/** 校验结果明细 */
export interface SquareResult extends ValidationResult {
  /** 仍未被覆盖的格子数 */
  empty: number
  /** 盘面是否已铺满（不含重叠） */
  complete: boolean
  /** 每格所属区域下标（-1 = 空） */
  regionOf: number[]
  /** 重叠格（正常交互不会出现，用于校验损坏的存档） */
  overlapCells: number[]
  /** 数字与所在正方形边长不符的格子 */
  clueBadCells: number[]
  /** 仍未被覆盖的数字格 */
  clueOpenCells: number[]
  /** 四条边界相交的内部顶点（顶点索引 = y*(w+1)+x） */
  tatamiVertices: number[]
  /** 与四点相交相关的格子 */
  tatamiCells: number[]
  /** 所有需要高亮的错误格 */
  badCells: number[]
  /** 数字线索总数 */
  clueCount: number
}

/* ────────────────────────── 编码 ────────────────────────── */

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 编码数字线索：每格一个 base36 字符，0 = 没有数字 */
export function encodeClues(clues: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < clues.length; i++) {
    const v = clues[i]! | 0
    if (v <= 0 || v >= BASE36.length) out += '0'
    else out += BASE36[v]!
  }
  return out
}

/** 解码数字线索；长度不符或含非法字符返回 null */
export function decodeClues(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected).fill(0)
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!.toLowerCase()
    if (ch === '.' || ch === '-' || ch === '?') continue
    const v = BASE36.indexOf(ch)
    if (v < 0) return null
    out[i] = v
  }
  return out
}

/**
 * 把区域列表编码成「每格区域编号」串。
 * 用区域编号（而不是边长）编码，避免两个同尺寸正方形相邻时被误认为同一块。
 */
export function encodeSolution(regions: readonly SquareRect[], w: number, h: number): string {
  const ids = new Array<number>(w * h).fill(0)
  for (let r = 0; r < regions.length; r++) {
    const rect = regions[r]!
    for (let dy = 0; dy < rect.size; dy++) {
      const y = rect.y + dy
      if (y < 0 || y >= h) continue
      for (let dx = 0; dx < rect.size; dx++) {
        const x = rect.x + dx
        if (x < 0 || x >= w) continue
        ids[y * w + x] = r + 1
      }
    }
  }
  let out = ''
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!
    out += id > 0 && id < BASE36.length ? BASE36[id]! : '0'
  }
  return out
}

/**
 * 从「每格区域编号」串还原区域列表。
 * 相同编号的连通块必须恰好是一个正方形；否则返回 null。
 */
export function decodeSolution(text: string, w: number, h: number): SquareRect[] | null {
  if (typeof text !== 'string' || text.length !== w * h) return null
  const ids = new Array<number>(w * h).fill(0)
  for (let i = 0; i < ids.length; i++) {
    const ch = text[i]!.toLowerCase()
    const v = BASE36.indexOf(ch)
    if (v <= 0) return null
    ids[i] = v
  }
  const seen = new Uint8Array(w * h)
  const regions: SquareRect[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start]) continue
    const id = ids[start]!
    const stack = [start]
    seen[start] = 1
    const cells: number[] = []
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    while (stack.length) {
      const i = stack.pop()!
      cells.push(i)
      const x = i % w
      const y = (i / w) | 0
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (x > 0 && !seen[i - 1] && ids[i - 1] === id) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x + 1 < w && !seen[i + 1] && ids[i + 1] === id) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && !seen[i - w] && ids[i - w] === id) {
        seen[i - w] = 1
        stack.push(i - w)
      }
      if (y + 1 < h && !seen[i + w] && ids[i + w] === id) {
        seen[i + w] = 1
        stack.push(i + w)
      }
    }
    const sideX = maxX - minX + 1
    const sideY = maxY - minY + 1
    if (sideX !== sideY) return null
    if (cells.length !== sideX * sideX) return null
    regions.push({ x: minX, y: minY, size: sideX })
  }
  regions.sort((a, b) => a.y - b.y || a.x - b.x)
  return regions
}

/* ────────────────────────── Move 打包 ────────────────────────── */

export function packRect(width: number, rect: SquareRect): number {
  const cell = rect.y * width + rect.x
  return ((cell + 1) << SIZE_BITS) | (rect.size & SIZE_MASK)
}

export function unpackRect(width: number, code: number): SquareRect | null {
  const size = code & SIZE_MASK
  const cell = (code >>> SIZE_BITS) - 1
  if (size <= 0 || cell < 0) return null
  return { x: cell % width, y: Math.floor(cell / width), size }
}

export function sameRect(a: SquareRect, b: SquareRect): boolean {
  return a.x === b.x && a.y === b.y && a.size === b.size
}

/** 正方形是否完全落在棋盘内 */
export function rectInBounds(rect: SquareRect, w: number, h: number): boolean {
  return (
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.size) &&
    rect.size >= 1 &&
    rect.size <= MAX_SIDE &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.size <= w &&
    rect.y + rect.size <= h
  )
}

export function asSquarePuzzle(p: Puzzle): SquarePuzzle {
  return p as SquarePuzzle
}

export function asSquareState(s: GameState): SquareState {
  return s as SquareState
}
