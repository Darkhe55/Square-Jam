/**
 * 方块拼盘 —— 回溯求解器
 *
 * 搜索方式：行优先选择「第一个未覆盖格」，枚举以它为左上角的正方形边长。
 *
 * 正确性依据：
 *   所有行优先顺序在它之前的格子都已被覆盖，因此任何包含它的正方形都不可能向上/向左
 *   扩展 —— 它必须是所属正方形区域的左上角。
 *
 * 剪枝：
 *   - 正方形内的数字线索必须等于边长；
 *   - 与已放置区域不重叠；
 *   - tatami：新放置的正方形不能在内部顶点造成四条区域边界相交。
 *
 * 同时用于：显示解 / 提示一格 / 自定义题板唯一解校验 / 逻辑推理的反证规则。
 */

import type { Puzzle, SolveResult } from '../core/types.ts'
import { asSquarePuzzle, type SquareRect, type SquareState } from './types.ts'
import {
  allTatamiViolations,
  emptyOwners,
  firstUncovered,
  placeRect,
  squareFits,
  tatamiViolationsAfter,
  unplaceRect,
  type OwnerGrid,
} from './partition.ts'

export interface SearchOutcome {
  solutions: SquareRect[][]
  nodes: number
  timedOut: boolean
}

function seedForced(
  clues: ArrayLike<number>,
  w: number,
  h: number,
  forced: readonly SquareRect[],
): { owner: OwnerGrid; regions: SquareRect[] } | null {
  const owner = emptyOwners(w, h)
  const regions: SquareRect[] = []
  for (const src of forced) {
    const rect: SquareRect = { x: src.x, y: src.y, size: src.size }
    if (!squareFits(owner, w, h, clues, rect)) return null
    placeRect(owner, w, rect, regions.length)
    regions.push(rect)
  }
  // 强制区域之间也可能凑出 tatami 冲突
  if (allTatamiViolations(owner, w, h).length) return null
  return { owner, regions }
}

/**
 * 在「forced 区域已经确定」的前提下搜索完整正方形划分。
 * 返回最多 limit 组解；timedOut = 节点数超过 maxNodes。
 */
export function searchSolutions(
  clues: ArrayLike<number>,
  w: number,
  h: number,
  forced: readonly SquareRect[] = [],
  limit = 2,
  maxNodes = 800_000,
): SearchOutcome {
  const size = w * h
  if (clues.length !== size) return { solutions: [], nodes: 0, timedOut: false }
  const seeded = seedForced(clues, w, h, forced)
  if (!seeded) return { solutions: [], nodes: 0, timedOut: false }
  const owner = seeded.owner
  const regions = seeded.regions
  const solutions: SquareRect[][] = []
  let nodes = 0
  let timedOut = false

  const dfs = (): void => {
    if (solutions.length >= limit || timedOut) return
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return
    }

    const cell = firstUncovered(owner)
    if (cell < 0) {
      solutions.push(regions.map((r) => ({ ...r })))
      return
    }

    const x = cell % w
    const y = (cell / w) | 0
    const clue = clues[cell] ?? 0
    const maxSide = Math.min(w - x, h - y)
    const regionIndex = regions.length

    if (clue > 0) {
      if (clue > maxSide) return
      const rect = { x, y, size: clue }
      if (!squareFits(owner, w, h, clues, rect)) return
      placeRect(owner, w, rect, regionIndex)
      if (!tatamiViolationsAfter(owner, w, h, rect).length) {
        regions.push(rect)
        dfs()
        regions.pop()
      }
      unplaceRect(owner, w, rect)
      return
    }

    for (let side = 1; side <= maxSide; side++) {
      if (solutions.length >= limit || timedOut) return
      const rect = { x, y, size: side }
      if (!squareFits(owner, w, h, clues, rect)) continue
      placeRect(owner, w, rect, regionIndex)
      if (!tatamiViolationsAfter(owner, w, h, rect).length) {
        regions.push(rect)
        dfs()
        regions.pop()
      }
      unplaceRect(owner, w, rect)
    }
  }

  dfs()
  return { solutions, nodes, timedOut }
}

export interface CountOutcome {
  count: number
  nodes: number
  timedOut: boolean
}

export function countSolutions(
  clues: ArrayLike<number>,
  w: number,
  h: number,
  limit = 2,
  maxNodes = 800_000,
  forced: readonly SquareRect[] = [],
): CountOutcome {
  const out = searchSolutions(clues, w, h, forced, limit, maxNodes)
  return { count: out.solutions.length, nodes: out.nodes, timedOut: out.timedOut }
}

export function makeStateFromRegions(
  puzzleId: string,
  w: number,
  h: number,
  regions: readonly SquareRect[],
): SquareState {
  return {
    puzzleId,
    width: w,
    height: h,
    regions: regions.map((r) => ({ ...r })),
  }
}

export function solvePuzzle(puzzle: Puzzle, maxNodes = 1_500_000): SolveResult {
  const p = asSquarePuzzle(puzzle)
  const clues = p.clues ?? []
  const w = p.width
  const h = p.height
  if (clues.length !== w * h) {
    return { solved: false, solution: null, nodes: 0, timedOut: false, solutions: 0, unique: false }
  }
  const out = searchSolutions(clues, w, h, [], 2, maxNodes)
  if (!out.solutions.length) {
    return {
      solved: false,
      solution: null,
      nodes: out.nodes,
      timedOut: out.timedOut,
      solutions: 0,
      unique: false,
    }
  }
  return {
    solved: true,
    solution: makeStateFromRegions(p.id, w, h, out.solutions[0]!),
    nodes: out.nodes,
    timedOut: out.timedOut,
    solutions: out.solutions.length,
    unique: out.solutions.length === 1 && !out.timedOut,
  }
}
