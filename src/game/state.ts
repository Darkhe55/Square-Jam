/**
 * 方块拼盘 —— 棋盘状态
 *
 * 状态 = 已画出的正方形区域列表（互不重叠；重叠只可能来自损坏存档，
 * 会在校验里被标红）。撤销/重做依赖 Move 的打包编码，见 types.ts。
 */

import type { GameState, HitTarget, Move, Puzzle } from '../core/types.ts'
import {
  asSquareState,
  packRect,
  rectInBounds,
  sameRect,
  unpackRect,
  type SquareRect,
  type SquareState,
} from './types.ts'

export function createEmptyState(puzzle: Puzzle): SquareState {
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    regions: [],
  }
}

export function cloneState(state: GameState): SquareState {
  const s = asSquareState(state)
  return {
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    regions: s.regions.map((r) => ({ ...r })),
  }
}

/** 默认点击语义在本游戏里由自定义拖拽交互接管；保留兜底实现 */
export function cycleValue(_state: GameState, _target: HitTarget): number {
  return 1
}

export function rightClickValue(_state: GameState, _target: HitTarget): number {
  return 0
}

export function indexOfRegion(regions: readonly SquareRect[], rect: SquareRect): number {
  for (let i = 0; i < regions.length; i++) if (sameRect(regions[i]!, rect)) return i
  return -1
}

export function applyMove(state: GameState, move: Move): void {
  const s = asSquareState(state)
  const rect = unpackRect(s.width, move.index)
  if (!rect) return
  const at = indexOfRegion(s.regions, rect)
  if (move.to === 1) {
    if (at < 0 && rectInBounds(rect, s.width, s.height)) s.regions.push(rect)
  } else if (move.to === 0 && at >= 0) {
    s.regions.splice(at, 1)
  }
}

export function invertMove(move: Move): Move {
  return { index: move.index, from: move.to, to: move.from }
}

export function valueAt(state: GameState, index: number): number {
  const s = asSquareState(state)
  const rect = unpackRect(s.width, index)
  if (!rect) return 0
  return indexOfRegion(s.regions, rect) >= 0 ? 1 : 0
}

export function serializeState(state: GameState): Record<string, unknown> {
  const s = asSquareState(state)
  return {
    version: 1,
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    regions: s.regions.map((r) => `${r.x},${r.y},${r.size}`).join(';'),
  }
}

function parseRegions(text: unknown, w: number, h: number): SquareRect[] | null {
  if (typeof text !== 'string') return null
  const out: SquareRect[] = []
  if (!text.trim()) return out
  for (const chunk of text.split(';')) {
    if (!chunk) continue
    const parts = chunk.split(',')
    if (parts.length !== 3) return null
    const x = Number(parts[0])
    const y = Number(parts[1])
    const size = Number(parts[2])
    const rect = { x, y, size }
    if (!rectInBounds(rect, w, h)) return null
    if (indexOfRegion(out, rect) >= 0) return null
    out.push(rect)
  }
  return out
}

export function deserializeState(data: Record<string, unknown>): SquareState | null {
  if (typeof data.puzzleId !== 'string') return null
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null
  const w = data.width
  const h = data.height
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
  const regions = parseRegions(data.regions, w, h)
  if (!regions) return null
  return { puzzleId: data.puzzleId, width: w, height: h, regions }
}

/**
 * 提示一格对应的 Move：
 *   1. 先移除与参考解冲突的区域；
 *   2. 再补一个参考解里还没画出的区域；
 *   3. 全部一致则返回 null。
 */
export function firstHintMove(state: GameState, solution: GameState): Move | null {
  const s = asSquareState(state)
  const sol = asSquareState(solution)
  for (const rect of s.regions) {
    if (indexOfRegion(sol.regions, rect) < 0) {
      return { index: packRect(s.width, rect), from: 1, to: 0 }
    }
  }
  for (const rect of sol.regions) {
    if (indexOfRegion(s.regions, rect) < 0) {
      return { index: packRect(s.width, rect), from: 0, to: 1 }
    }
  }
  return null
}
