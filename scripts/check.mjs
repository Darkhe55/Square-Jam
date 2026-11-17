/**
 * 方块拼盘（Square Jam）题库深度审计
 *
 * 复用浏览器里的同一套游戏代码（Node 24 可直接 import .ts），检查：
 *   1. 数据结构：id 唯一 / 宽高 / 难度 / 线索长度与取值范围；
 *   2. 参考解：能由「每格边长」串还原成正方形划分，并通过实时校验器（正方形 / 数字 / tatami）；
 *   3. 唯一解：回溯求解器（限制 2 解）恰好找到 1 组解且不超时；
 *   4. 逻辑可推完：planLogicSolve 从空盘出发，只靠规则推理（规则 1–3）铺满棋盘、不回退；
 *   5. 回放一致性：逐帧 applyMove 后的盘面 === plan.finalState，且通过校验；
 *   6. 交互/序列化：正方形打包编码、进度序列化、自定义题板编解码、提示一格；
 *   7. 纯函数交互几何：从两格确定正方形（鼠标拖拽/键盘选择的同一实现）。
 *
 * 用法：npm run check
 */

import { builtinPuzzles, getReferenceSolution } from '../src/game/puzzles.ts'
import { countSolutions } from '../src/game/solver.ts'
import { planLogicSolve } from '../src/game/logic.ts'
import { validate } from '../src/game/validate.ts'
import { applyMove, cloneState, invertMove, serializeState, deserializeState, firstHintMove, createEmptyState, valueAt } from '../src/game/state.ts'
import { adapter } from '../src/game/adapter.ts'
import { packRect, unpackRect, sameRect } from '../src/game/types.ts'
import { squareFromCells, previewKindFor } from '../src/game/interaction.ts'

let errors = 0
let warnings = 0
const fail = (msg) => {
  console.error(`[check] ✗ ${msg}`)
  errors++
}
const warn = (msg) => {
  console.warn(`[check] ! ${msg}`)
  warnings++
}
const ok = (msg) => console.log(`[check] ✓ ${msg}`)

const ids = new Set()

if (builtinPuzzles.length < 6) {
  fail(`内置题只有 ${builtinPuzzles.length} 道，至少需要 6 道`)
}

for (const p of builtinPuzzles) {
  const tag = `${p.id} ${p.width}×${p.height}`
  const size = p.width * p.height

  if (ids.has(p.id)) fail(`${tag} id 重复`)
  ids.add(p.id)
  if (!p.name) fail(`${tag} 缺少 name`)
  if (!['easy', 'medium', 'hard', 'custom'].includes(p.difficulty)) {
    fail(`${tag} 难度非法：${p.difficulty}`)
  }
  if (p.width <= 0 || p.height <= 0) {
    fail(`${tag} 宽高非法`)
    continue
  }
  if (!Array.isArray(p.clues) || p.clues.length !== size) {
    fail(`${tag} 线索长度不符`)
    continue
  }

  let clueCount = 0
  let clueBad = 0
  for (const c of p.clues) {
    if (!Number.isInteger(c) || c < 0) clueBad++
    if (c > 0) {
      clueCount++
      if (c > Math.min(p.width, p.height)) clueBad++
    }
  }
  if (!clueCount) fail(`${tag} 没有任何数字线索`)
  if (clueBad) fail(`${tag} 有 ${clueBad} 个非法数字线索`)

  // 参考解
  const ref = getReferenceSolution(p.id)
  if (!ref) {
    fail(`${tag} 缺少参考解`)
    continue
  }
  const refResult = validate(ref, p)
  if (!refResult.solved) {
    fail(`${tag} 参考解未通过校验：${JSON.stringify(refResult)}`)
    continue
  }
  if (ref.regions.length < 2) warn(`${tag} 参考解只有 ${ref.regions.length} 块区域（过于简单）`)

  // 唯一解
  const counted = countSolutions(p.clues, p.width, p.height, 2, 600_000)
  if (counted.timedOut) {
    fail(`${tag} 唯一解检查超时（${counted.nodes} 节点）`)
    continue
  }
  if (counted.count !== 1) {
    fail(`${tag} 解不唯一：找到 ${counted.count} 组`)
    continue
  }

  // 逻辑推演
  const plan = planLogicSolve(p, createEmptyState(p))
  if (!plan.frames.length) {
    fail(`${tag} 逻辑推演没有任何结论`)
    continue
  }
  if (!plan.finalState) {
    fail(`${tag} 逻辑推演没有终态`)
    continue
  }
  if (!plan.saturated) fail(`${tag} 逻辑推演未饱和（需要回溯）`)

  const ruleCount = { 1: 0, 2: 0, 3: 0, 4: 0 }
  for (const f of plan.frames) {
    if (ruleCount[f.rule] === undefined) fail(`${tag} 未知规则编号 ${f.rule}`)
    else ruleCount[f.rule]++
  }
  if (ruleCount[4] > 0) fail(`${tag} 逻辑回放含回溯补完 ${ruleCount[4]} 帧（应纯逻辑推完）`)

  const planResult = validate(plan.finalState, p)
  if (!planResult.solved) {
    fail(`${tag} 逻辑推演终态未通过校验`)
    continue
  }

  // 回放一致性：逐帧 applyMove
  const replay = cloneState(createEmptyState(p))
  for (const f of plan.frames) {
    if (f.move.from !== 0 || f.move.to !== 1) {
      fail(`${tag} 回放帧不是「新增正方形」`)
      break
    }
    const rect = unpackRect(p.width, f.move.index)
    if (!rect) {
      fail(`${tag} 回放帧 index 无法解包`)
      break
    }
    applyMove(replay, f.move)
  }
  const replayMatch =
    replay.regions.length === plan.finalState.regions.length &&
    replay.regions.every((r, i) => sameRect(r, plan.finalState.regions[i]))
  if (!replayMatch) fail(`${tag} 逐帧回放结果与逻辑终态不一致`)

  // 序列化往返 + 撤销一步
  const ser = serializeState(ref)
  const back = deserializeState(ser)
  if (!back || back.regions.length !== ref.regions.length) {
    fail(`${tag} 进度序列化往返失败`)
  } else {
    const last = ref.regions[ref.regions.length - 1]
    const move = { index: packRect(p.width, last), from: 0, to: 1 }
    const st = cloneState(ref)
    applyMove(st, invertMove(move))
    if (valueAt(st, move.index) !== 0) fail(`${tag} 撤销后区域仍存在`)
    applyMove(st, move)
    if (valueAt(st, move.index) !== 1) fail(`${tag} 重做后区域未恢复`)
  }

  // 提示一格
  const hint = firstHintMove(createEmptyState(p), ref)
  if (!hint || hint.from !== 0 || hint.to !== 1) {
    fail(`${tag} 提示一格未返回新增正方形`)
  }

  // 自定义题板编解码往返（同一套 codec）
  const encoded = adapter.custom.encodePuzzle(p)
  const decoded = adapter.custom.decodePuzzle({ ...encoded, id: p.id, name: p.name, width: p.width, height: p.height })
  if (!decoded || decoded.clues.join(',') !== p.clues.join(',')) {
    fail(`${tag} 自定义题板线索编解码往返失败`)
  }
  const grid = adapter.custom.toGrid(p)
  if (!grid) {
    fail(`${tag} toGrid 还原失败`)
  } else {
    const made = adapter.custom.makePuzzle(grid.width, grid.height, grid.grid)
    if (made.clues.join(',') !== p.clues.join(',')) fail(`${tag} toGrid → makePuzzle 往返失败`)
  }

  // 求解器（显示解路径）也应返回唯一解
  const solved = adapter.solvePuzzle(p, 600_000)
  if (!solved.solved || !solved.solution) fail(`${tag} solvePuzzle 失败`)
  else {
    if (!validate(solved.solution, p).solved) fail(`${tag} solvePuzzle 的解未通过校验`)
    if (solved.solutions !== 1) fail(`${tag} solvePuzzle 报告解数 ${solved.solutions}（应为 1）`)
  }

  const st = plan.stats ?? {}
  ok(
    `${tag} 数字 ${clueCount} · 区域 ${ref.regions.length} · 唯一解 · ` +
      `逻辑可推满（规则1/2/3 = ${ruleCount[1]}/${ruleCount[2]}/${ruleCount[3]}）· ${counted.nodes} 节点` +
      `（试放 ${st.probeCalls ?? 0} 次 / 试放搜索 ${st.probeNodes ?? 0} 节点 / 回溯 ${st.searchNodes ?? 0} 节点）`,
  )
}

/* ────────────────────────── 纯函数交互几何 ────────────────────────── */

{
  const cases = [
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, 5, 5, { x: 0, y: 0, size: 1 }],
    [{ x: 0, y: 0 }, { x: 2, y: 0 }, 5, 5, { x: 0, y: 0, size: 3 }],
    [{ x: 0, y: 0 }, { x: 2, y: 1 }, 5, 5, { x: 0, y: 0, size: 3 }],
    [{ x: 4, y: 4 }, { x: 2, y: 2 }, 5, 5, { x: 2, y: 2, size: 3 }],
    [{ x: 4, y: 0 }, { x: 4, y: 2 }, 5, 5, { x: 2, y: 0, size: 3 }],
    [{ x: 0, y: 4 }, { x: 2, y: 4 }, 5, 5, { x: 0, y: 2, size: 3 }],
    [{ x: 3, y: 3 }, { x: 4, y: 4 }, 5, 5, { x: 3, y: 3, size: 2 }],
  ]
  let bad = 0
  for (const [a, b, w, h, expected] of cases) {
    const got = squareFromCells(a, b, w, h)
    if (!sameRect(got, expected)) {
      fail(`squareFromCells(${JSON.stringify(a)}→${JSON.stringify(b)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`)
      bad++
    }
  }
  if (!bad) ok('拖拽几何：从两格确定正方形（7 组用例）')

  // 预览合法性：空盘可放 / 重叠不可放 / 数字不匹配不可放
  const emptyClues = new Array(25).fill(0)
  if (previewKindFor(5, 5, emptyClues, [], { x: 0, y: 0, size: 3 }) !== 'add') {
    fail('空盘 3×3 预览应合法')
  }
  if (previewKindFor(5, 5, emptyClues, [{ x: 0, y: 0, size: 2 }], { x: 1, y: 1, size: 2 }) !== 'invalid') {
    fail('重叠预览应非法')
  }
  if (previewKindFor(5, 5, emptyClues, [{ x: 0, y: 0, size: 2 }], { x: 0, y: 0, size: 2 }) !== 'remove') {
    fail('点已有正方形预览应为删除')
  }
  const clueClash = emptyClues.slice()
  clueClash[0] = 2
  if (previewKindFor(5, 5, clueClash, [], { x: 0, y: 0, size: 3 }) !== 'invalid') {
    fail('数字不匹配的预览应非法')
  }
  // tatami：三块已占住顶点三格时，第四格不能是另一块 1×1（会造成四条边界相交）
  const tatamiClues = new Array(25).fill(0)
  if (
    previewKindFor(
      5,
      5,
      tatamiClues,
      [
        { x: 0, y: 0, size: 1 },
        { x: 1, y: 0, size: 1 },
        { x: 0, y: 1, size: 1 },
      ],
      { x: 1, y: 1, size: 1 },
    ) !== 'invalid'
  ) {
    fail('顶点四格各成一块的预览应非法（tatami）')
  }
  if (previewKindFor(5, 5, tatamiClues, [], { x: 1, y: 1, size: 1 }) !== 'add') {
    fail('空盘任意 1×1 预览应合法')
  }
  ok('预览合法性：空盘 / 重叠 / 删除 / 数字 / tatami（6 组用例）')
}

/* ────────────────────────── 汇总 ────────────────────────── */

console.log('')
console.log(`[check] 共 ${builtinPuzzles.length} 道内置题，错误 ${errors}，警告 ${warnings}`)
if (builtinPuzzles.length < 6) console.error('[check] 内置题数量不足 6 道')
if (errors > 0) process.exitCode = 1
else console.log('[check] 全部通过 ✅')
