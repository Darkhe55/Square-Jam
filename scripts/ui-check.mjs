/**
 * 方块拼盘（Square Jam）—— 浏览器实测（Playwright + Edge）
 *
 * 覆盖：
 *   1. 页面启动、内置题库（≥ 6 道）全部可「显示解」并通过校验；
 *   2. 鼠标拖拽：从正方形一角拖到对角画出正方形（含删除）；
 *   3. 键盘：方向键 + 回车开始/结束绘制、Esc 取消；
 *   4. 撤销 / 重做 / 提示一格 / 右键删除；
 *   5. 逻辑解题回放能推满并解出；
 *   6. 自定义题板：键盘录入数字 → 载入 → 求解（唯一解）→ 保存 → 编辑 → 删除。
 *
 * 用法：
 *   1) 先启动服务（任一）：
 *        npx vite preview --port 5219 --strictPort
 *        npm run dev            （带 /__store 项目内存储）
 *   2) node scripts/ui-check.mjs
 *
 * 可用 EDGE_PATH 指定 Edge；截图输出到 output/。
 */

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { PORT } from './_port.mjs'

const executablePath =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = process.env.UI_BASE || `http://127.0.0.1:${PORT}/`

mkdirSync('output', { recursive: true })

let checks = 0
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`)
  checks++
  console.log(`  ✓ ${msg}`)
}

async function reachable(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

if (!(await reachable(BASE))) {
  console.error(`[ui-check] 无法访问 ${BASE}`)
  console.error('[ui-check] 请先运行：npx vite preview --port 5219 --strictPort（或 npm run dev）')
  process.exit(1)
}

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`)
})

const statusText = () => page.locator('#status').innerText()
const session = () =>
  page.evaluate(() => {
    const s = window.__game.getSession()
    if (!s) return null
    return {
      id: s.puzzle.id,
      width: s.puzzle.width,
      height: s.puzzle.height,
      regions: s.state.regions.map((r) => ({ ...r })),
    }
  })

const cellCenter = (cx, cy) =>
  page.evaluate(
    ([x, y]) => {
      const g = window.__game
      const s = g.getSession()
      const svg = document.querySelector('svg.board-svg')
      const rect = svg.getBoundingClientRect()
      const vb = svg.viewBox.baseVal
      const m = g.adapter.metricsFor(s.puzzle)
      const sx = rect.width / vb.width
      const sy = rect.height / vb.height
      return {
        x: rect.left + (m.pad + (x + 0.5) * m.cell - vb.x) * sx,
        y: rect.top + (m.pad + (y + 0.5) * m.cell - vb.y) * sy,
      }
    },
    [cx, cy],
  )

const solutionRegions = () =>
  page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    const sol = g.adapter.getReferenceSolution(s.puzzle.id)
    return sol ? sol.regions.map((r) => ({ ...r })) : null
  })

const isValid = () =>
  page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    return g.adapter.validate(s.state, s.puzzle).solved
  })

const selectBuiltinByIndex = async (index) => {
  await page.locator('.puzzle-item').nth(index).click()
  await page.waitForTimeout(80)
}

async function clearBoard() {
  await page.click('#btn-clear')
  await page.waitForTimeout(80)
}

async function dragSquare(rect) {
  const from = await cellCenter(rect.x, rect.y)
  const to = await cellCenter(rect.x + rect.size - 1, rect.y + rect.size - 1)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.waitForTimeout(60)
  await page.mouse.up()
  await page.waitForTimeout(140)
}

try {
  /* 1. 启动与内置题 */
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelectorAll('.puzzle-item').length > 0)
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'output/01-initial.png', fullPage: true })

  const puzzleCount = await page.locator('.puzzle-item').count()
  assert(puzzleCount >= 6, `内置题库至少 6 道（实际 ${puzzleCount} 道）`)
  assert((await page.locator('svg.board-svg').count()) === 1, '棋盘 SVG 已渲染')
  assert((await page.locator('.sj-region').count()) === 0, '新题棋盘初始没有正方形')

  /* 2. 每道内置题「显示解」→ 校验通过 */
  for (let i = 0; i < puzzleCount; i++) {
    await selectBuiltinByIndex(i)
    const s = await session()
    assert(!!s, `第 ${i + 1} 题可载入`)
    await page.click('#btn-solve')
    await page.waitForTimeout(120)
    assert(await isValid(), `第 ${i + 1} 题（${s.width}×${s.height}）显示解通过校验`)
    const regionCells = await page.locator('.sj-region').count()
    assert(regionCells > 0, `第 ${i + 1} 题渲染出正方形区域（${regionCells} 块）`)
  }
  await page.screenshot({ path: 'output/02-solved.png', fullPage: true })

  /* 3. 鼠标拖拽画正方形 */
  await selectBuiltinByIndex(0)
  await clearBoard()
  const ref = await solutionRegions()
  assert(!!ref && ref.length > 0, '拿到参考解区域列表')
  const target = ref.find((r) => r.size >= 2) || ref[0]
  await dragSquare(target)
  let s = await session()
  assert(
    s.regions.some((r) => r.x === target.x && r.y === target.y && r.size === target.size),
    `拖拽画出参考解中的 ${target.size}×${target.size} 正方形（左上 ${target.x},${target.y}）`,
  )
  assert(s.regions.length === 1, '一次拖拽只产生一个正方形区域')
  await page.screenshot({ path: 'output/03-drag-square.png', fullPage: true })

  // 右键删除刚画的正方形
  const inside = await cellCenter(target.x, target.y)
  await page.mouse.click(inside.x, inside.y, { button: 'right' })
  await page.waitForTimeout(120)
  s = await session()
  assert(s.regions.length === 0, '右键删除正方形生效')

  /* 4. 键盘：回车开始 → 方向键 → 回车结束 */
  await clearBoard()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(80)
  const previewCount = await page.locator('#sj-live .sj-preview').count()
  assert(previewCount === 1, '键盘绘制时显示预览正方形')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(120)
  s = await session()
  assert(
    s.regions.some((r) => r.x === 0 && r.y === 0 && r.size === 2),
    '键盘绘制出 (0,0) 的 2×2 正方形',
  )
  await page.screenshot({ path: 'output/04-keyboard.png', fullPage: true })

  // Esc 取消键盘绘制
  await clearBoard()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  s = await session()
  assert(s.regions.length === 0, 'Esc 取消键盘绘制，不落子')

  /* 5. 撤销 / 重做 / 提示一格 */
  await page.click('#btn-hint')
  await page.waitForTimeout(120)
  s = await session()
  assert(s.regions.length === 1, '提示一格新增了一个正方形')
  await page.click('#btn-undo')
  await page.waitForTimeout(100)
  s = await session()
  assert(s.regions.length === 0, '撤销后正方形被移除')
  await page.click('#btn-redo')
  await page.waitForTimeout(100)
  s = await session()
  assert(s.regions.length === 1, '重做后正方形恢复')

  /* 6. 逻辑解题回放 */
  await selectBuiltinByIndex(0)
  await clearBoard()
  const logicFrames = await page.evaluate(() => {
    const g = window.__game
    const s = g.getSession()
    return g.adapter.planLogicSolve(s.puzzle, s.state).frames.length
  })
  assert(logicFrames > 0, `逻辑计划有 ${logicFrames} 帧`)
  await page.click('#btn-logic')
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#status')?.textContent || ''
      return t.includes('逻辑解题完成') || t.includes('回放完毕')
    },
    { timeout: 90_000 },
  )
  await page.waitForTimeout(150)
  assert(await isValid(), '逻辑回放结束后盘面已解出')
  await page.screenshot({ path: 'output/05-logic-playback.png', fullPage: true })

  /* 6b. 错误高亮：直接注入违规盘面（模拟坏存档/求解器反例），检查标红与状态栏 */
  await clearBoard()
  await page.evaluate(() => {
    const s = window.__game.getSession()
    s.state.regions.push(
      { x: 0, y: 0, size: 1 },
      { x: 1, y: 0, size: 1 },
      { x: 0, y: 1, size: 1 },
      { x: 1, y: 1, size: 1 },
    )
  })
  await page.keyboard.press('c')
  await page.waitForTimeout(160)
  assert((await page.locator('.sj-tatami').count()) > 0, '四点相交顶点被标红')
  assert((await statusText()).includes('四点相交'), '状态栏报告四点相交')
  assert((await page.locator('.sj-cell-bad').count()) > 0, '违规格子被高亮')
  await page.screenshot({ path: 'output/11-error-highlight.png', fullPage: true })

  await clearBoard()
  await page.evaluate(() => {
    const s = window.__game.getSession()
    s.state.regions.push({ x: 0, y: 0, size: 2 }, { x: 1, y: 1, size: 2 })
  })
  await page.keyboard.press('c')
  await page.waitForTimeout(160)
  assert((await statusText()).includes('重叠'), '状态栏报告区域重叠')
  await clearBoard()
  await page.evaluate(() => {
    const s = window.__game.getSession()
    s.state.regions.push({ x: 1, y: 0, size: 1 })
  })
  await page.keyboard.press('c')
  await page.waitForTimeout(160)
  assert((await statusText()).includes('数字与边长不符'), '状态栏报告数字与边长不符')

  /* 7. 自定义题板：录入内置题线索 → 载入 → 求解 → 保存 → 编辑 → 删除 */
  const builtinClues = await page.evaluate(() => {
    const g = window.__game
    return { clues: g.adapter.builtinPuzzles[0].clues.slice(), w: 6, h: 6 }
  })
  await page.click('#btn-custom')
  await page.waitForTimeout(100)
  await page.fill('#custom-w', '6')
  await page.fill('#custom-h', '6')
  await page.click('#custom-regen')
  await page.waitForTimeout(120)
  await page.locator('#custom-grid').focus()
  for (const clue of builtinClues.clues) {
    await page.keyboard.press(clue > 0 ? String(clue) : '.')
  }
  await page.waitForTimeout(80)
  const customCells = await page.locator('.custom-cell').allInnerTexts()
  const expectedLabels = builtinClues.clues.map((c) => (c > 0 ? String(c) : ''))
  assert(
    JSON.stringify(customCells) === JSON.stringify(expectedLabels),
    '自定义题板键盘录入的数字与内置题线索一致',
  )
  await page.screenshot({ path: 'output/06-custom-editor.png', fullPage: true })

  await page.click('#custom-apply')
  await page.waitForTimeout(200)
  assert((await statusText()).includes('已载入自定义'), '自定义题板已载入')
  const customLoaded = await page.evaluate(() => {
    const s = window.__game.getSession()
    return { clues: s.puzzle.clues.slice(), regions: s.state.regions.length }
  })
  assert(customLoaded.regions === 0, '自定义题板载入后盘面为空')
  assert(
    JSON.stringify(customLoaded.clues) === JSON.stringify(builtinClues.clues),
    '自定义题板题面与内置题线索一致',
  )

  await page.click('#custom-solve')
  await page.waitForTimeout(400)
  const solveMsg = await page.locator('#custom-msg').innerText()
  assert(solveMsg.includes('唯一解'), `自定义题板求解报告唯一解（实际：${solveMsg}）`)
  await page.screenshot({ path: 'output/07-custom-solved.png', fullPage: true })

  await page.click('#custom-save')
  await page.waitForTimeout(150)
  await page.click('#custom-close')
  await page.waitForTimeout(150)
  assert((await page.locator('[data-edit]').count()) >= 1, '自定义题已保存到左侧题库')
  await page.screenshot({ path: 'output/08-custom-saved.png', fullPage: true })

  // 编辑：重新打开后题面应还原
  await page.locator('[data-edit]').first().click()
  await page.waitForTimeout(150)
  const restored = await page.locator('.custom-cell').allInnerTexts()
  assert(
    JSON.stringify(restored) === JSON.stringify(expectedLabels),
    '点击「编辑」后自定义题面完整还原',
  )
  await page.screenshot({ path: 'output/09-custom-edit.png', fullPage: true })
  await page.click('#custom-close')
  await page.waitForTimeout(100)

  // 删除：需要点两次（第二次确认）
  await page.locator('[data-del]').first().click()
  await page.waitForTimeout(100)
  assert((await page.locator('[data-del].confirm').count()) === 1, '删除需要二次确认')
  await page.locator('[data-del]').first().click()
  await page.waitForTimeout(250)
  assert((await page.locator('[data-edit]').count()) === 0, '自定义题已从题库删除')
  await page.screenshot({ path: 'output/10-custom-deleted.png', fullPage: true })

  /* 8. 页面错误 */
  assert(pageErrors.length === 0, `无页面 JS 错误${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`)

  console.log(`\n[ui-check] 全部通过：${checks} 项断言，截图已输出到 output/`)
} catch (err) {
  console.error(`\n[ui-check] 失败：${err instanceof Error ? err.message : String(err)}`)
  if (pageErrors.length) console.error(`[ui-check] 页面错误：${pageErrors.join(' | ')}`)
  try {
    await page.screenshot({ path: 'output/99-failure.png', fullPage: true })
  } catch {
    /* ignore */
  }
  process.exitCode = 1
} finally {
  await browser.close()
}
