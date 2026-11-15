/**
 * 方块拼盘 —— 随机题库生成器
 *
 * 流程：
 *   1. 随机生成一个满足 tatami 规则的正方形划分（分治回溯 + 随机边长）；
 *   2. 每个区域随机挑一格放上「边长」数字线索；
 *   3. 用回溯求解器检查：恰好一解；逻辑推理（Rules 1–3）能推完；
 *   4. 同尺寸多试几个种子，挑「逻辑规则命中最多（最少反证）」的一道；
 *   5. 输出 board（线索串，每格边长）/ solution（每格区域编号串）给 gen-puzzles.mjs。
 */

import {
  encodeClues,
  encodeSolution,
} from '../src/game/types.ts'
import {
  emptyOwners,
  firstUncovered,
  placeRect,
  placementAllowed,
  unplaceRect,
} from '../src/game/partition.ts'
import { countSolutions } from '../src/game/solver.ts'
import { planLogicSolve } from '../src/game/logic.ts'

export const NAME = '方块拼盘随机出题器（tatami + 唯一解 + 逻辑推演校验）'

const SPECS = [
  { w: 6, h: 6, difficulty: 'easy', tag: 'a', minRegions: 7, maxRegion: 3, keepRatio: 1 },
  { w: 6, h: 6, difficulty: 'easy', tag: 'b', minRegions: 7, maxRegion: 3, keepRatio: 1 },
  { w: 7, h: 7, difficulty: 'easy', tag: 'a', minRegions: 8, maxRegion: 4, keepRatio: 0.85 },
  { w: 8, h: 8, difficulty: 'medium', tag: 'a', minRegions: 9, maxRegion: 4, keepRatio: 0.8 },
  { w: 8, h: 8, difficulty: 'medium', tag: 'b', minRegions: 9, maxRegion: 4, keepRatio: 0.75 },
  { w: 9, h: 9, difficulty: 'hard', tag: 'a', minRegions: 10, maxRegion: 4, keepRatio: 0.7 },
  { w: 10, h: 10, difficulty: 'hard', tag: 'a', minRegions: 11, maxRegion: 5, keepRatio: 0.65 },
]

/** 线性同余随机数（可复现） */
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

const NO_CLUES = []

/** 随机生成一个 tatami 合法的正方形划分（行优先，边长随机，带回溯与重启） */
function randomPartition(w, h, rng) {
  const nodeCap = 120_000
  for (let attempt = 0; attempt < 40; attempt++) {
    const owner = emptyOwners(w, h)
    const regions = []
    let nodes = 0
    let aborted = false

    const dfs = () => {
      if (aborted) return false
      if (++nodes > nodeCap) {
        aborted = true
        return false
      }
      const cell = firstUncovered(owner)
      if (cell < 0) return true
      const x = cell % w
      const y = (cell / w) | 0
      const maxSide = Math.min(w - x, h - y)
      const sizes = []
      for (let s = 1; s <= maxSide; s++) sizes.push(s)
      shuffle(sizes, rng)
      for (const size of sizes) {
        const rect = { x, y, size }
        if (!placementAllowed(owner, w, h, NO_CLUES, rect)) continue
        placeRect(owner, w, rect, regions.length)
        regions.push(rect)
        if (dfs()) return true
        regions.pop()
        unplaceRect(owner, w, rect)
        if (aborted) return false
      }
      return false
    }

    if (dfs()) return regions
  }
  return null
}

function buildClues(w, h, regions, rng) {
  const clues = new Array(w * h).fill(0)
  for (const rect of regions) {
    const cx = rect.x + Math.floor(rng() * rect.size)
    const cy = rect.y + Math.floor(rng() * rect.size)
    clues[cy * w + cx] = rect.size
  }
  return clues
}

function clueCountOf(clues) {
  let n = 0
  for (const c of clues) if (c > 0) n++
  return n
}

function puzzleOf(w, h, clues, id) {
  return { id, name: '', width: w, height: h, difficulty: 'custom', clues }
}

/** 评估一道候选题：唯一解 + 逻辑推满，返回评分（规则 1/2 命中越多越好） */
function evaluate(w, h, clues, id) {
  const solved = countSolutions(clues, w, h, 2, 600_000)
  if (solved.timedOut) return null
  if (solved.count !== 1) return null
  return evaluateWithSolution(w, h, clues, id, solved)
}

function evaluateWithSolution(w, h, clues, id, solved) {
  const puzzle = puzzleOf(w, h, clues, id)
  const plan = planLogicSolve(puzzle, {
    puzzleId: id,
    width: w,
    height: h,
    regions: [],
  })
  if (!plan.frames.length || !plan.finalState) return null
  if (!plan.saturated) return null
  let byClue = 0
  let byCell = 0
  let byProbe = 0
  let bySearch = 0
  for (const f of plan.frames) {
    if (f.rule === 1) byClue++
    else if (f.rule === 2) byCell++
    else if (f.rule === 3) byProbe++
    else bySearch++
  }
  if (bySearch > 0) return null
  // 评分：规则 1/2 越多越好；反证越少越好
  const ruleScore = (byClue * 2 + byCell * 3 - byProbe) / plan.frames.length
  const score = ruleScore + Math.min(0.6, plan.frames.length * 0.05)
  return {
    plan,
    score,
    byClue,
    byCell,
    byProbe,
    frames: plan.frames.length,
    nodes: solved.nodes,
  }
}

/** 逐步删数字线索：仍然唯一解且逻辑可推满才保留删除 */
function pruneClues(w, h, clues, id, rng, keepRatio) {
  if (keepRatio >= 1) return clues
  const idxs = []
  for (let i = 0; i < clues.length; i++) if (clues[i] > 0) idxs.push(i)
  shuffle(idxs, rng)
  const limit = Math.floor(idxs.length * (1 - keepRatio))
  let removed = 0
  let cur = clues.slice()
  for (const i of idxs) {
    if (removed >= limit) break
    const trial = cur.slice()
    trial[i] = 0
    const evaluation = evaluate(w, h, trial, id)
    if (!evaluation) continue
    cur = trial
    removed++
  }
  return cur
}

async function generateOne(spec, seedBase) {
  const w = spec.w
  const h = spec.h
  const id = `sj-${w}x${h}-${spec.tag}`
  let best = null
  for (let k = 0; k < 30; k++) {
    const seed = seedBase + k * 7919
    const rng = makeRng(seed)
    const regions = randomPartition(w, h, rng)
    if (!regions) continue
    if (regions.length < spec.minRegions) continue
    if (regions.length > 30) continue
    let maxSize = 0
    for (const r of regions) maxSize = Math.max(maxSize, r.size)
    if (maxSize > spec.maxRegion) continue

    let clues = buildClues(w, h, regions, rng)
    let evaluation = evaluate(w, h, clues, id)
    // 唯一解/逻辑不满足时，继续补数字线索
    let extra = 0
    while (!evaluation && extra < regions.length * 3) {
      const rect = regions[Math.floor(rng() * regions.length)]
      const cx = rect.x + Math.floor(rng() * rect.size)
      const cy = rect.y + Math.floor(rng() * rect.size)
      extra++
      if (clues[cy * w + cx] > 0) continue
      clues[cy * w + cx] = rect.size
      evaluation = evaluate(w, h, clues, id)
    }
    if (!evaluation) continue

    const pruned = pruneClues(w, h, clues, id, rng, spec.keepRatio)
    if (pruned !== clues) {
      const prunedEval = evaluate(w, h, pruned, id)
      if (prunedEval) {
        clues = pruned
        evaluation = prunedEval
      }
    }

    const score = evaluation.score + regions.length * 0.05
    if (!best || score > best.score) {
      best = { regions, clues, evaluation, seed, score }
    }
    if (best && best.score >= 3.4) break
  }
  if (!best) return null
  return { ...best, w, h }
}

export async function generatePuzzles() {
  const out = []
  for (let i = 0; i < SPECS.length; i++) {
    const spec = SPECS[i]
    const picked = await generateOne(spec, 20260501 + i * 104729 + spec.w * 1009 + spec.h * 917)
    if (!picked) {
      console.warn(`[gen] ${spec.w}×${spec.h} 第 ${i} 道生成失败，跳过`)
      continue
    }
    const id = `sj-${spec.w}x${spec.h}-${spec.tag}`
    const clueN = clueCountOf(picked.clues)
    out.push({
      id,
      name: `方块拼盘 · ${picked.w}×${picked.h} · ${spec.tag.toUpperCase()}`,
      width: picked.w,
      height: picked.h,
      difficulty: spec.difficulty,
      series: `builtin-${picked.w}x${picked.h}`,
      board: encodeClues(picked.clues),
      solution: encodeSolution(picked.regions, picked.w, picked.h),
    })
    console.log(
      `[gen] ${id} ${picked.w}×${picked.h} 区域 ${picked.regions.length} 数字 ${clueN} ` +
        `规则1/2/3 = ${picked.evaluation.byClue}/${picked.evaluation.byCell}/${picked.evaluation.byProbe} ` +
        `(${picked.evaluation.nodes} 节点种子 ${picked.seed})`,
    )
  }
  if (out.length < 6) {
    throw new Error(`[gen] 只生成了 ${out.length} 道题（需要至少 6 道），请调整种子`)
  }
  return out
}
