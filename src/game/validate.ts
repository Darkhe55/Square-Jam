/**
 * 方块拼盘 —— 实时校验
 *
 * 校验项：
 *   R1 覆盖：每一格都恰好属于一个正方形（不能重叠 / 不能留空）；
 *   R2 正方形：每个区域必须是 size×size（由状态结构保证，同时校验被重叠抢占后的实际格数）；
 *   R3 数字：每个数字格所在正方形边长必须等于数字；
 *   R4 tatami：任意内部顶点处不能四条区域边界相交。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types.ts'
import {
  asSquarePuzzle,
  asSquareState,
  rectInBounds,
  type SquareResult,
} from './types.ts'
import {
  allTatamiViolations,
  buildOwner,
  vertexCells,
  vertexFromIndex,
} from './partition.ts'

export function validate(state: GameState, puzzle: Puzzle): SquareResult {
  const s = asSquareState(state)
  const p = asSquarePuzzle(puzzle)
  const w = s.width
  const h = s.height
  const size = w * h
  const clues = p.clues ?? []
  const regions = s.regions

  const built = buildOwner(regions, w, h)
  const owner = built.owner

  let empty = 0
  for (let i = 0; i < size; i++) if (owner[i]! < 0) empty++

  // R2 正方形：区域格数必须等于 size²（被重叠抢占或越界都会导致不等）
  const badRegions = new Set<number>(built.invalidRegions)
  for (let r = 0; r < regions.length; r++) {
    const rect = regions[r]!
    if (!rectInBounds(rect, w, h)) continue
    if (built.ownedCount[r] !== rect.size * rect.size) badRegions.add(r)
    if (rect.size < 1) badRegions.add(r)
  }

  // R3 数字匹配
  const clueBad = new Set<number>()
  const clueOpen: number[] = []
  let clueCount = 0
  if (clues.length === size) {
    for (let i = 0; i < size; i++) {
      const clue = clues[i] ?? 0
      if (clue <= 0) continue
      clueCount++
      const r = owner[i]!
      if (r < 0) {
        clueOpen.push(i)
        continue
      }
      const rect = regions[r]
      if (!rect || badRegions.has(r)) continue
      if (rect.size !== clue) clueBad.add(i)
    }
  }

  // R4 tatami
  const tatamiVertices = allTatamiViolations(owner, w, h)
  const tatamiCells = new Set<number>()
  for (const v of tatamiVertices) {
    const { gx, gy } = vertexFromIndex(w, v)
    for (const c of vertexCells(w, gx, gy)) tatamiCells.add(c)
  }

  const overlap = new Set<number>(built.overlap)
  const badCells = new Set<number>()
  for (const i of overlap) badCells.add(i)
  for (const i of clueBad) badCells.add(i)
  for (const i of tatamiCells) badCells.add(i)
  if (badRegions.size) {
    for (let r = 0; r < regions.length; r++) {
      if (!badRegions.has(r)) continue
      const rect = regions[r]!
      for (let dy = 0; dy < rect.size; dy++) {
        for (let dx = 0; dx < rect.size; dx++) {
          const x = rect.x + dx
          const y = rect.y + dy
          if (x >= 0 && y >= 0 && x < w && y < h) badCells.add(y * w + x)
        }
      }
    }
  }

  const complete = empty === 0 && overlap.size === 0
  const solved =
    complete &&
    clueBad.size === 0 &&
    tatamiVertices.length === 0 &&
    badRegions.size === 0 &&
    clues.length === size

  return {
    solved,
    empty,
    complete,
    regionOf: Array.from(owner),
    overlapCells: Array.from(overlap),
    clueBadCells: Array.from(clueBad),
    clueOpenCells: clueOpen,
    tatamiVertices,
    tatamiCells: Array.from(tatamiCells),
    badCells: Array.from(badCells),
    clueCount,
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as SquareResult
  if (r.solved) return ['完成']
  const bits: string[] = []
  if (typeof r.empty === 'number' && r.empty > 0) bits.push(`还需划分 ${r.empty} 格`)
  if (r.overlapCells?.length) bits.push(`${r.overlapCells.length} 格重叠`)
  if (r.clueBadCells?.length) bits.push(`${r.clueBadCells.length} 处数字与边长不符`)
  if (r.tatamiVertices?.length) bits.push(`${r.tatamiVertices.length} 处四点相交`)
  if (r.complete && !r.clueBadCells?.length && !r.tatamiVertices?.length && !r.overlapCells?.length) {
    bits.push('覆盖完整，但仍有问题')
  }
  if (!bits.length) bits.push('继续划分正方形')
  return bits
}
