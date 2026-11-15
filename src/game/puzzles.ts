/**
 * 方块拼盘 —— 题库加载
 *
 * puzzles-data.ts 由 scripts/gen-puzzles.mjs + scripts/gen-config.mjs 生成：
 *   board    = 数字线索（每格一个 base36 字符，0 = 无数字）
 *   solution = 参考解（每格一个 base36 字符，表示该格所属正方形编号）
 *
 * 加载时会用同一套校验器验证「参考解合法」，不合法只告警并丢弃参考解，
 * 避免坏数据让「显示解」把棋盘填成非法图案。
 */

import { RAW_PUZZLES } from './puzzles-data.ts'
import {
  asSquarePuzzle,
  decodeClues,
  decodeSolution,
  type SquarePuzzle,
  type SquareRect,
  type SquareState,
} from './types.ts'
import { validate } from './validate.ts'

export const builtinPuzzles: SquarePuzzle[] = []
const referenceRegions = new Map<string, SquareRect[]>()

for (const raw of RAW_PUZZLES) {
  const size = raw.width * raw.height
  if (size <= 0 || raw.width <= 0 || raw.height <= 0) {
    console.warn(`[方块拼盘] 题目尺寸非法：${raw.id}`)
    continue
  }
  const clues = decodeClues(raw.board, size)
  if (!clues) {
    console.warn(`[方块拼盘] 线索解码失败：${raw.id}`)
    continue
  }
  let clueCount = 0
  for (const c of clues) if (c > 0) clueCount++
  if (!clueCount) {
    console.warn(`[方块拼盘] 题目没有任何数字：${raw.id}`)
    continue
  }

  const puzzle: SquarePuzzle = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    clues,
  }
  builtinPuzzles.push(puzzle)

  if (raw.solution) {
    const regions = decodeSolution(raw.solution, raw.width, raw.height)
    if (regions) {
      const state: SquareState = {
        puzzleId: raw.id,
        width: raw.width,
        height: raw.height,
        regions,
      }
      if (validate(state, puzzle).solved) {
        puzzle.solution = raw.solution
        referenceRegions.set(raw.id, regions)
      } else {
        console.warn(`[方块拼盘] 参考解未通过校验：${raw.id}`)
      }
    } else {
      console.warn(`[方块拼盘] 参考解解码失败：${raw.id}`)
    }
  }
}

export function getReferenceSolution(id: string): SquareState | null {
  const regions = referenceRegions.get(id)
  const puzzle = puzzleById(id)
  if (!regions || !puzzle) return null
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    regions: regions.map((r) => ({ ...r })),
  }
}

export function puzzleById(id: string): SquarePuzzle | undefined {
  return builtinPuzzles.find((p) => p.id === id)
}

export function referenceFor(p: SquarePuzzle): SquareRect[] | null {
  const regions = referenceRegions.get(p.id)
  if (regions) return regions.map((r) => ({ ...r }))
  const raw = asSquarePuzzle(p).solution
  return raw ? decodeSolution(raw, p.width, p.height) : null
}

/** 题目是否带参考解（测试用） */
export function hasReference(id: string): boolean {
  return referenceRegions.has(id)
}
