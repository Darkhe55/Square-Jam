/**
 * 方块拼盘 —— 逻辑解题回放计划
 *
 * 只用「必然结论」推进，不猜：
 *   R1 数字线索唯一定位：某数字格所有可能的正方形位置里只剩一个 → 该正方形必在解中；
 *   R2 覆盖传播：任一未覆盖格的所有可行正方形里只剩一种 → 该正方形必在解中；
 *   R3 反证：对第一个未覆盖格逐一试放每个可行边长，只有一种能继续求解 → 它必在解中；
 *   R4 回溯补完：规则推不动时用求解器补齐（回放标注「回溯补完」）。
 *
 * 每条规则都是可证明的推理，因此回放与「显示解」一致，也用于提示一格。
 */

import type { GameState, LogicPlan, PlaybackFrame, Puzzle, Move } from '../core/types.ts'
import {
  asSquarePuzzle,
  asSquareState,
  packRect,
  type SquareRect,
  type SquareState,
} from './types.ts'
import {
  allTatamiViolations,
  emptyOwners,
  firstUncovered,
  placeRect,
  placementAllowed,
  squareFits,
  squaresContainingCell,
  squaresOfSizeContaining,
} from './partition.ts'
import { searchSolutions } from './solver.ts'

const RULE_CLUE = 1
const RULE_CELL = 2
const RULE_PROBE = 3
const RULE_SEARCH = 4

const RULE_LABEL: Record<number, string> = {
  [RULE_CLUE]: '数字线索只剩一个可能位置 → 该正方形必在解中',
  [RULE_CELL]: '第一个未覆盖格只剩一种可行边长 → 该正方形必在解中',
  [RULE_PROBE]: '其余摆放都会导致无解（反证）→ 该正方形必在解中',
  [RULE_SEARCH]: '规则推不动，回溯补完剩余正方形',
}

const PROBE_NODES = 120_000
const PLAN_TIME_BUDGET_MS = 8_000

function emptyPlan(puzzleId: string): LogicPlan {
  return { puzzleId, frames: [], finalState: null, ruleSteps: 0, saturated: false }
}

export function planLogicSolve(puzzle: Puzzle, initialState: GameState): LogicPlan {
  const stats: Record<string, number> = { probeCalls: 0, probeNodes: 0, searchNodes: 0 }
  const p = asSquarePuzzle(puzzle)
  const s = asSquareState(initialState)
  const w = s.width
  const h = s.height
  const size = w * h
  const clues = p.clues ?? []
  if (clues.length !== size) return emptyPlan(p.id)

  const owner = emptyOwners(w, h)
  const placed: SquareRect[] = []
  for (const src of s.regions) {
    const rect: SquareRect = { x: src.x, y: src.y, size: src.size }
    if (!squareFits(owner, w, h, clues, rect)) return emptyPlan(p.id)
    placeRect(owner, w, rect, placed.length)
    placed.push(rect)
  }
  if (allTatamiViolations(owner, w, h).length) return emptyPlan(p.id)

  const frames: PlaybackFrame[] = []
  let lastRule = 0
  let streak = 0
  const emit = (rect: SquareRect, rule: number): void => {
    const move: Move = { index: packRect(w, rect), from: 0, to: 1 }
    if (rule === lastRule) streak++
    else {
      lastRule = rule
      streak = 1
    }
    frames.push({ rule, label: RULE_LABEL[rule]!, move, streak })
    placeRect(owner, w, rect, placed.length)
    placed.push(rect)
  }

  const deadline = Date.now() + PLAN_TIME_BUDGET_MS
  const canPlace = (rect: SquareRect): boolean => placementAllowed(owner, w, h, clues, rect)

  let saturated = true
  let guard = 0
  for (;;) {
    if (firstUncovered(owner) < 0) break
    if (Date.now() > deadline) {
      saturated = false
      break
    }
    if (++guard > size * 4 + 64) {
      saturated = false
      break
    }

    // R1：数字线索唯一定位
    let placedByClue = false
    for (let i = 0; i < size; i++) {
      const clue = clues[i] ?? 0
      if (clue <= 0 || owner[i]! >= 0) continue
      const x = i % w
      const y = (i / w) | 0
      const cands = squaresOfSizeContaining(w, h, x, y, clue).filter(canPlace)
      if (cands.length === 1) {
        emit(cands[0]!, RULE_CLUE)
        placedByClue = true
        break
      }
    }
    if (placedByClue) continue

    // R2：覆盖传播 —— 任一未覆盖格若只剩一种可行正方形，该正方形必在解中
    //（比只看「第一个未覆盖格」强：任何未覆盖格都必须被某个正方形覆盖）
    let bestRect: SquareRect | null = null
    for (let i = 0; i < size; i++) {
      if (owner[i]! >= 0) continue
      const x = i % w
      const y = (i / w) | 0
      let found: SquareRect | null = null
      let count = 0
      for (const cand of squaresContainingCell(w, h, x, y)) {
        if (!canPlace(cand)) continue
        count++
        found = cand
        if (count > 1) break
      }
      if (count === 0) return emptyPlan(p.id)
      if (count === 1 && found) {
        bestRect = found
        break
      }
    }
    if (bestRect) {
      emit(bestRect, RULE_CELL)
      continue
    }

    // 第一个未覆盖格（行优先）必定是所属正方形的左上角，用于 R3 试放
    const cell = firstUncovered(owner)
    const cx = cell % w
    const cy = (cell / w) | 0
    const maxSide = Math.min(w - cx, h - cy)
    const cands: SquareRect[] = []
    for (let side = 1; side <= maxSide; side++) {
      const rect = { x: cx, y: cy, size: side }
      if (canPlace(rect)) cands.push(rect)
    }
    if (!cands.length) return emptyPlan(p.id)

    // R3：反证 —— 逐一试放，只有一种能继续求解
    const feasible: SquareRect[] = []
    let probeTimedOut = false
    for (const cand of cands) {
      stats.probeCalls++
      const out = searchSolutions(clues, w, h, [...placed, cand], 1, PROBE_NODES)
      stats.probeNodes += out.nodes
      if (out.timedOut) probeTimedOut = true
      else if (out.solutions.length) feasible.push(cand)
    }
    if (!probeTimedOut && !feasible.length) return emptyPlan(p.id)
    if (!probeTimedOut && feasible.length === 1) {
      emit(feasible[0]!, RULE_PROBE)
      continue
    }
    break
  }

  if (firstUncovered(owner) >= 0) {
    saturated = false
    const out = searchSolutions(clues, w, h, placed, 1, 1_500_000)
    stats.searchNodes = out.nodes
    if (!out.solutions.length) {
      // 规则已推出的部分结论仍然有效；若一组解都找不到，说明盘面本身矛盾
      return emptyPlan(p.id)
    }
    const solution = out.solutions[0]!
    for (const rect of solution) {
      const exists = placed.some(
        (r) => r.x === rect.x && r.y === rect.y && r.size === rect.size,
      )
      if (!exists) emit(rect, RULE_SEARCH)
    }
    if (out.timedOut) saturated = false
  }

  const finalState: SquareState = {
    puzzleId: p.id,
    width: w,
    height: h,
    regions: placed.map((r) => ({ ...r })),
  }

  return {
    puzzleId: p.id,
    frames,
    finalState,
    ruleSteps: frames.length,
    saturated,
    stats,
  }
}

export const LOGIC_RULES = { RULE_CLUE, RULE_CELL, RULE_PROBE, RULE_SEARCH }
