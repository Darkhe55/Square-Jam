/**
 * 方块拼盘（Square Jam）题面图片导入（全自动识图版）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--width W] [--height H] [--name 名称] [--series 识图]
 *                                  [--append] [--verify] [--json out.json]
 *                                  [--map "x,y=数字,..."] [--ink-drop N] [--crop "x,y,w,h"] [--dry]
 *
 * 流程：
 *   1. Playwright + Edge 打开图片到 canvas，取灰度像素；
 *   2. 按页面底色裁出题板，用「格子底色比格线亮」的亮度投影找等距格线，自动判定 W×H；
 *   3. 每格中心裁切 + 自适应二值化识别数字线索（1–20，两位数按字形宽度自动拆成两个数字）；
 *   4. 预览线索矩阵；--verify 调项目 solver 检查唯一解并给出参考解（超时只告警）；
 *   5. --append 写入 src/game/imported-puzzles.ts（不会被 npm run gen 覆盖）。
 *
 * --map：人工修正某格线索，坐标 0 基（列,行），0 = 无数字，例如 --map "3,4=12,0,0=0"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { countSolutions, searchSolutions } from '../src/game/solver.ts'
import { encodeClues, encodeSolution, MAX_SIDE } from '../src/game/types.ts'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function edgePath() {
  for (const c of EDGE_CANDIDATES) {
    if (c && existsSync(c)) return c
  }
  throw new Error('找不到 Edge 可执行文件，请用 EDGE_PATH 指定')
}

const args = process.argv.slice(2)
function has(flag) {
  return args.includes(flag)
}
function arg(flag, fallback = '') {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const VALUE_FLAGS = ['--width', '--height', '--name', '--series', '--json', '--map', '--ink-drop', '--crop', '--timeout']
const imageArg = args.find((a, i) => {
  if (a.startsWith('--')) return false
  const prev = args[i - 1]
  return !(prev && VALUE_FLAGS.includes(prev))
})
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--width W] [--height H] [--name 名称] [--series 识图] [--append] [--verify] [--json out.json] [--map "x,y=数字,..."] [--ink-drop N] [--crop "x,y,w,h"] [--dry]',
  )
  process.exit(1)
}
const IMAGE = path.resolve(imageArg)
if (!existsSync(IMAGE)) {
  console.error('找不到图片:', IMAGE)
  process.exit(1)
}

const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const nameOpt = arg('--name')
const series = arg('--series', '识图')
const jsonOut = arg('--json')
const inkDrop = Number(arg('--ink-drop', '60')) || 60
const append = has('--append')
const verify = has('--verify')
const dry = has('--dry')
const cropArg = arg('--crop')
let crop = null
if (cropArg) {
  const v = cropArg.split(/[,xX]/).map((s) => Number(s.trim()))
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n) || n < 0)) {
    console.error(`--crop 格式错误：${cropArg}（应为 "x,y,w,h"）`)
    process.exit(1)
  }
  crop = v
}

// --map "x,y=数字,..."
const manual = new Map()
const mapArg = arg('--map')
if (mapArg) {
  const re = /(\d+)\s*,\s*(\d+)\s*=\s*(\d+)/g
  let matched = 0
  let m
  while ((m = re.exec(mapArg)) !== null) {
    manual.set(Number(m[2]) * 10000 + Number(m[1]), Number(m[3]))
    matched++
  }
  const residue = mapArg.replace(re, '').replace(/[\s,;]+/g, '')
  if (!matched || residue) {
    console.error(`--map 格式错误：${mapArg}（应为 x,y=数字）`)
    process.exit(1)
  }
}

// ───────────────────────── 浏览器端识图 ─────────────────────────
const dataUrl = `data:image/png;base64,${readFileSync(IMAGE).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: edgePath() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analysis = await page.evaluate(
  async ({ dataUrl, widthOpt, heightOpt, inkDrop, crop, maxSide }) => {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const W = img.naturalWidth
    const H = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, W, H).data
    const grayAt = (x, y) => {
      const i = (y * W + x) * 4
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    }

    // 1) 页面底色（四角中位数）+ 题板包围盒
    const cornerVals = []
    for (const [cx, cy] of [
      [5, 5],
      [W - 6, 5],
      [5, H - 6],
      [W - 6, H - 6],
    ]) {
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = Math.max(0, Math.min(W - 1, cx + dx))
          const y = Math.max(0, Math.min(H - 1, cy + dy))
          cornerVals.push(grayAt(x, y))
        }
    }
    cornerVals.sort((a, b) => a - b)
    const pageBg = cornerVals[Math.floor(cornerVals.length / 2)]
    let bx0 = crop ? crop[0] : W
    let by0 = crop ? crop[1] : H
    let bx1 = crop ? crop[0] + crop[2] - 1 : -1
    let by1 = crop ? crop[1] + crop[3] - 1 : -1
    if (!crop) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (Math.abs(grayAt(x, y) - pageBg) <= 8) continue
          if (x < bx0) bx0 = x
          if (x > bx1) bx1 = x
          if (y < by0) by0 = y
          if (y > by1) by1 = y
        }
      }
    }
    if (bx1 < bx0 || by1 < by0) throw new Error('图片里没有找到题板')
    const bw = bx1 - bx0 + 1
    const bh = by1 - by0 + 1

    // 2) 格子底色众数 + 亮像素投影
    const hist = new Int32Array(256)
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) hist[Math.round(grayAt(x, y)) | 0]++
    }
    let mode = 0
    let modeCount = -1
    for (let v = 0; v < 256; v++) {
      if (hist[v] > modeCount) {
        modeCount = hist[v]
        mode = v
      }
    }
    const isBright = new Uint8Array(bw * bh)
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        isBright[y * bw + x] = grayAt(bx0 + x, by0 + y) >= mode - 8 ? 1 : 0
      }
    }
    const colCount = new Int32Array(bw)
    const rowCount = new Int32Array(bh)
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!isBright[y * bw + x]) continue
        colCount[x]++
        rowCount[y]++
      }
    }
    const medianOf = (arr) => {
      const s = Array.from(arr).sort((a, b) => a - b)
      return s[Math.floor(s.length / 2)]
    }
    const groupsOf = (profile) => {
      const med = medianOf(profile)
      const thr = Math.max(3, med * 0.12)
      const out = []
      let start = -1
      for (let i = 0; i < profile.length; i++) {
        const on = profile[i] <= thr
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          out.push((start + i - 1) / 2)
          start = -1
        }
      }
      if (start >= 0) out.push((start + profile.length - 1) / 2)
      return out
    }
    const bestRun = (lines, wantCells) => {
      const out = []
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const step = (lines[j] - lines[i]) / (j - i)
          if (step < 6) continue
          let end = i
          for (let k = i + 1; k < lines.length; k++) {
            if (Math.abs(lines[k] - (lines[i] + step * (k - i))) > step * 0.12) break
            end = k
          }
          if (end - i >= 1) out.push({ start: i, end, step, count: end - i + 1 })
        }
      }
      out.sort((a, b) => b.count - a.count || b.step - a.step)
      if (wantCells >= 2) {
        const hit = out.find((r) => r.count - 1 === wantCells)
        if (hit) return hit
      }
      return out[0] ?? null
    }
    const axisOf = (profile, wantCells) => {
      const groups = groupsOf(profile)
      if (groups.length < 2) throw new Error('没有检测到足够的格线')
      const run = bestRun(groups, wantCells)
      if (!run) throw new Error('无法确定等距网格')
      const start = groups[run.start]
      const step = (groups[run.end] - start) / (run.count - 1)
      const lines = []
      for (let k = 0; k < run.count; k++) lines.push(start + k * step)
      return { lines, step, candidates: groups.length }
    }
    const xAxis = axisOf(colCount, widthOpt)
    const yAxis = axisOf(rowCount, heightOpt)
    const xs = xAxis.lines.map((v) => v + bx0)
    const ys = yAxis.lines.map((v) => v + by0)
    const cols = xs.length - 1
    const rows = ys.length - 1
    if (widthOpt >= 2 && cols !== widthOpt) throw new Error(`网格宽度不匹配：${cols} 列，--width ${widthOpt}`)
    if (heightOpt >= 2 && rows !== heightOpt) throw new Error(`网格高度不匹配：${rows} 行，--height ${heightOpt}`)
    if (cols < 2 || rows < 2) throw new Error(`识别到的网格太小：${cols}×${rows}`)
    const cellX = (xs[cols] - xs[0]) / cols
    const cellY = (ys[rows] - ys[0]) / rows

    // 3) 数字模板（0–9，多字体多字重，归一化 24×24）
    const NS = 24
    const SRC = 44
    const DIGITS = '0123456789'
    const normFromBBox = (inMask, x0, y0, x1, y1) => {
      const bwid = x1 - x0 + 1
      const bhei = y1 - y0 + 1
      const out = new Uint8Array(NS * NS)
      for (let j = 0; j < NS; j++) {
        for (let i = 0; i < NS; i++) {
          out[j * NS + i] = inMask[(y0 + Math.floor((bhei * j) / NS)) * SRC + (x0 + Math.floor((bwid * i) / NS))] ? 1 : 0
        }
      }
      return out
    }
    const inkMaskOf = (raw, T) => {
      const m = new Uint8Array(SRC * SRC)
      let ink = 0
      for (let j = 0; j < SRC; j++) {
        for (let i = 0; i < SRC; i++) {
          if (raw[j * SRC + i] < T) {
            m[j * SRC + i] = 1
            ink++
          }
        }
      }
      return { m, ink }
    }
    const bboxOf = (m) => {
      let x0 = SRC
      let y0 = SRC
      let x1 = -1
      let y1 = -1
      for (let j = 0; j < SRC; j++) {
        for (let i = 0; i < SRC; i++) {
          if (!m[j * SRC + i]) continue
          if (i < x0) x0 = i
          if (i > x1) x1 = i
          if (j < y0) y0 = j
          if (j > y1) y1 = j
        }
      }
      if (x1 < x0) return null
      return { x0, y0, x1, y1, bw: x1 - x0 + 1, bh: y1 - y0 + 1 }
    }
    const holesOf = (m) => {
      const seen = new Uint8Array(NS * NS)
      let holes = 0
      for (let j = 0; j < NS; j++) {
        for (let i = 0; i < NS; i++) {
          if (m[j * NS + i] || seen[j * NS + i]) continue
          let touches = false
          const st = [[i, j]]
          seen[j * NS + i] = 1
          while (st.length) {
            const [x, y] = st.pop()
            if (x === 0 || y === 0 || x === NS - 1 || y === NS - 1) touches = true
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || ny < 0 || nx >= NS || ny >= NS) continue
              if (seen[ny * NS + nx] || m[ny * NS + nx]) continue
              seen[ny * NS + nx] = 1
              st.push([nx, ny])
            }
          }
          if (!touches) holes++
        }
      }
      return holes
    }
    const tc = document.createElement('canvas')
    tc.width = 120
    tc.height = 120
    const tg = tc.getContext('2d', { willReadFrequently: true })
    const FONTS = [
      '700 84px Arial',
      '400 84px Arial',
      '700 84px "Segoe UI"',
      '400 84px "Segoe UI"',
      '700 84px Verdana',
      '700 84px Tahoma',
      '700 84px Consolas',
      '400 84px Consolas',
      '600 84px "Cascadia Code"',
      '400 84px "Cascadia Code"',
      '400 84px "Microsoft YaHei"',
      '700 84px "Microsoft YaHei"',
      '700 84px "Trebuchet MS"',
    ]
    const templates = {}
    for (const ch of DIGITS) templates[ch] = []
    for (const font of FONTS) {
      for (const ch of DIGITS) {
        tg.fillStyle = '#fff'
        tg.fillRect(0, 0, 120, 120)
        tg.fillStyle = '#000'
        tg.font = font
        tg.textAlign = 'center'
        tg.textBaseline = 'middle'
        tg.fillText(ch, 60, 60)
        const data = tg.getImageData(0, 0, 120, 120).data
        const raw = new Float32Array(SRC * SRC)
        for (let j = 0; j < SRC; j++) {
          for (let i = 0; i < SRC; i++) {
            const sx = Math.floor((i * 120) / SRC)
            const sy = Math.floor((j * 120) / SRC)
            raw[j * SRC + i] = data[(sy * 120 + sx) * 4]
          }
        }
        const { m } = inkMaskOf(raw, 128)
        const bb = bboxOf(m)
        if (!bb) continue
        templates[ch].push({ m: normFromBBox(m, bb.x0, bb.y0, bb.x1, bb.y1), holes: holesOf(normFromBBox(m, bb.x0, bb.y0, bb.x1, bb.y1)) })
      }
    }
    const simShift = (a, b) => {
      let best = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          let inter = 0
          let union = 0
          for (let j = 0; j < NS; j++) {
            const bj = j + dy
            for (let i = 0; i < NS; i++) {
              const av = a[j * NS + i]
              const bi = i + dx
              const bv = bj >= 0 && bj < NS && bi >= 0 && bi < NS ? b[bj * NS + bi] : 0
              if (av && bv) inter++
              if (av || bv) union++
            }
          }
          const s = union ? inter / union : 0
          if (s > best) best = s
        }
      }
      return best
    }
    /** 单字形 → 最可能的数字 */
    const recognizeGlyph = (m, allowLeading = DIGITS) => {
      const holes = holesOf(m)
      const ranked = []
      for (const d of allowLeading) {
        let best = 0
        for (const t of templates[d]) {
          let s = simShift(m, t.m)
          if (t.holes === holes) s += 0.1
          else if (Math.abs(t.holes - holes) >= 2) s -= 0.12
          if (s > best) best = s
        }
        ranked.push({ d, score: Number(best.toFixed(4)) })
      }
      ranked.sort((a, b) => b.score - a.score)
      return ranked[0]
    }
    const patchMedian = (cx, cy, half) => {
      const vals = []
      for (let dy = -half; dy <= half; dy++)
        for (let dx = -half; dx <= half; dx++)
          vals.push(grayAt(Math.max(0, Math.min(W - 1, Math.round(cx + dx))), Math.max(0, Math.min(H - 1, Math.round(cy + dy)))))
      vals.sort((a, b) => a - b)
      return vals[Math.floor(vals.length / 2)]
    }

    // 4) 每格数字线索
    const cells = []
    const warnings = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = xs[c]
        const x1 = xs[c + 1]
        const y0 = ys[r]
        const y1 = ys[r + 1]
        const cw = x1 - x0
        const chh = y1 - y0
        const half = Math.max(1, Math.round(Math.min(cw, chh) * 0.05))
        const corners = [
          patchMedian(x0 + cw * 0.2, y0 + chh * 0.2, half),
          patchMedian(x1 - cw * 0.2, y0 + chh * 0.2, half),
          patchMedian(x0 + cw * 0.2, y1 - chh * 0.2, half),
          patchMedian(x1 - cw * 0.2, y1 - chh * 0.2, half),
        ]
        corners.sort((a, b) => a - b)
        const bg = corners[Math.floor(corners.length / 2)]
        const mx = x0 + cw * 0.16
        const my = y0 + chh * 0.16
        const mw = cw * 0.68
        const mh = chh * 0.68
        const raw = new Float32Array(SRC * SRC)
        for (let j = 0; j < SRC; j++) {
          for (let i = 0; i < SRC; i++) {
            raw[j * SRC + i] = grayAt(
              Math.max(0, Math.min(W - 1, Math.round(mx + (mw * i) / (SRC - 1)))),
              Math.max(0, Math.min(H - 1, Math.round(my + (mh * j) / (SRC - 1)))),
            )
          }
        }
        let { m, ink } = inkMaskOf(raw, bg - inkDrop)
        if (ink < 8) {
          const alt = inkMaskOf(raw, bg - Math.max(30, inkDrop * 0.6))
          if (alt.ink >= 8) {
            m = alt.m
            ink = alt.ink
          }
        }
        let value = 0
        let score = 0
        let digitsText = ''
        const bb = ink >= 8 ? bboxOf(m) : null
        if (bb && Math.max(bb.bw, bb.bh) >= SRC * 0.25) {
          // 两位数：字形明显偏宽 → 在中间找一条墨迹最少的竖线切成两个字形
          if (bb.bw > bb.bh * 1.02 && bb.bw > SRC * 0.4) {
            const colInk = new Array(SRC).fill(0)
            for (let j = bb.y0; j <= bb.y1; j++)
              for (let i = bb.x0; i <= bb.x1; i++) if (m[j * SRC + i]) colInk[i]++
            const lo = bb.x0 + Math.floor(bb.bw * 0.3)
            const hi = bb.x0 + Math.ceil(bb.bw * 0.7)
            let split = -1
            let bestCost = Infinity
            for (let i = lo; i <= hi; i++) {
              const cost = colInk[i]
              if (cost < bestCost) {
                bestCost = cost
                split = i
              }
            }
            if (split > bb.x0 && split + 1 <= bb.x1) {
              const leftBB = bboxOf((() => {
                const sub = new Uint8Array(SRC * SRC)
                for (let j = bb.y0; j <= bb.y1; j++)
                  for (let i = bb.x0; i <= split; i++) sub[j * SRC + i] = m[j * SRC + i]
                return sub
              })())
              const rightBB = bboxOf((() => {
                const sub = new Uint8Array(SRC * SRC)
                for (let j = bb.y0; j <= bb.y1; j++)
                  for (let i = split + 1; i <= bb.x1; i++) sub[j * SRC + i] = m[j * SRC + i]
                return sub
              })())
              if (leftBB && rightBB) {
                const leftMask = normFromBBox(m, leftBB.x0, leftBB.y0, leftBB.x1, leftBB.y1)
                const rightMask = normFromBBox(m, rightBB.x0, rightBB.y0, rightBB.x1, rightBB.y1)
                const d1 = recognizeGlyph(leftMask, '123')
                const d2 = recognizeGlyph(rightMask, '0123456789')
                value = Number(d1.d) * 10 + Number(d2.d)
                score = Math.min(d1.score, d2.score)
                digitsText = `${d1.d}${d2.d}`
                if (score < 0.45) warnings.push(`格 (${c},${r}) 两位数置信度低：${value} ${score.toFixed(2)}（可 --map 修正）`)
              }
            }
          }
          if (!digitsText) {
            const mask = normFromBBox(m, bb.x0, bb.y0, bb.x1, bb.y1)
            const best = recognizeGlyph(mask, '123456789')
            value = Number(best.d)
            score = best.score
            digitsText = String(value)
            if (score < 0.45) warnings.push(`格 (${c},${r}) 数字置信度低：${value} ${score.toFixed(2)}（可 --map 修正）`)
          }
        }
        if (value > maxSide) {
          warnings.push(`格 (${c},${r}) 识别到非法线索 ${value}（>${MAX_SIDE}），已忽略`)
          value = 0
        }
        cells.push({ c, r, value, score, bg, ink, bw: bb ? bb.bw : 0, bh: bb ? bb.bh : 0 })
      }
    }
    return {
      imageW: W,
      imageH: H,
      board: { x: bx0, y: by0, w: bw, h: bh },
      cols,
      rows,
      cellX: Number(cellX.toFixed(2)),
      cellY: Number(cellY.toFixed(2)),
      mode,
      xs: xs.map((v) => Number(v.toFixed(1))),
      ys: ys.map((v) => Number(v.toFixed(1))),
      cells,
      warnings,
    }
  },
  { dataUrl, widthOpt, heightOpt, inkDrop, crop, maxSide: MAX_SIDE },
)

await browser.close()

const cols = analysis.cols
const rows = analysis.rows
const clues = new Array(cols * rows).fill(0)
for (const c of analysis.cells) clues[c.r * cols + c.c] = c.value
for (const [key, value] of manual) {
  const x = key % 10000
  const y = Math.floor(key / 10000)
  if (x >= cols || y >= rows) {
    console.error(`--map 坐标越界：${x},${y}（网格 ${cols}×${rows}）`)
    process.exit(1)
  }
  clues[y * cols + x] = value
  console.log(`[import] 人工修正 (${x},${y}) = ${value}`)
}

const clueCount = clues.filter((v) => v > 0).length
console.log(
  `[import] ${path.basename(IMAGE)}：${analysis.imageW}×${analysis.imageH}px，题板 ${analysis.board.w}×${analysis.board.h}，` +
    `识别网格 ${cols}×${rows}，格距 ${analysis.cellX}×${analysis.cellY}px，格子底色 ${analysis.mode}`,
)
console.log(`[import] 线索 ${clueCount}/${cols * rows} 格`)
console.log('[import] 识别结果（. = 无数字）：')
for (let y = 0; y < rows; y++) {
  let line = ''
  for (let x = 0; x < cols; x++) {
    const v = clues[y * cols + x]
    line += v > 0 ? String(v).padStart(2) : ' .'
  }
  console.log('  ' + String(y).padStart(2) + ' ' + line)
}
if (analysis.warnings.length) {
  console.log(`[import] 注意 ${analysis.warnings.length} 条：`)
  for (const w of analysis.warnings.slice(0, 25)) console.log('  - ' + w)
  if (analysis.warnings.length > 25) console.log(`  … 其余 ${analysis.warnings.length - 25} 条略`)
}
if (clueCount === 0) {
  console.error('[import] 没有识别到任何数字线索，无法作为题库（可用 --map 手工补）')
  process.exit(1)
}

// ───────────────────────── 校验 / 求解 ─────────────────────────
let solution = null
let unique = null
if (verify || append) {
  const t0 = Date.now()
  const counted = countSolutions(clues, cols, rows, 2, 1_500_000)
  if (counted.timedOut) {
    console.warn(`[import] 唯一性检查超时（${counted.nodes} 节点 / ${Date.now() - t0}ms），仅告警`)
  } else if (counted.count !== 1) {
    console.warn(`[import] 解不唯一：找到 ${counted.count} 个（可能是识别错误，可用 --map 修正）`)
  } else {
    unique = true
    const out = searchSolutions(clues, cols, rows, [], 1, 2_000_000)
    if (out.solutions.length) {
      solution = out.solutions[0]
      console.log(`[import] 项目 solver 校验：唯一解 ✓（${Date.now() - t0}ms，${counted.nodes} 节点），正方形 ${solution.length} 个`)
    } else {
      console.warn('[import] 唯一解存在但 solver 没求出解（超时），参考解留空')
    }
  }
} else {
  console.log('[import] 未加 --verify：跳过唯一性校验。')
}

// ───────────────────────── 导出 / 写入 ─────────────────────────
const id = `square-import-${Date.now().toString(36)}`
const name = nameOpt || `识图 · ${cols}×${rows}`
const boardText = encodeClues(clues)
const solutionText = solution ? encodeSolution(solution, cols, rows) : ''
if (jsonOut) {
  const file = path.resolve(jsonOut)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        width: cols,
        height: rows,
        clueCount,
        board: boardText,
        solution: solutionText || null,
        unique,
        source: path.basename(IMAGE),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[import] 已导出 JSON：${file}`)
}

if (append) {
  if (dry) {
    console.log('[import] --dry：跳过写入')
  } else if (unique === false) {
    console.warn('[import] 未确认唯一解，仍按题面写入（参考解留空），建议先修正识别结果')
  } else {
    const entry =
      `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${cols}, height: ${rows}, ` +
      `difficulty: 'custom', series: ${JSON.stringify(series)}, board: ${JSON.stringify(boardText)}, solution: ${JSON.stringify(solutionText)} },\n`
    const dataFile = path.resolve('src/game/imported-puzzles.ts')
    if (!existsSync(dataFile)) {
      writeFileSync(
        dataFile,
        `import type { RawPuzzle } from './puzzles-data'\n\nexport const IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}]\n`,
      )
    } else {
      let text = readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
      if (/=\s*\[\s*\]/.test(text)) {
        text = text.replace(/=\s*\[\s*\]/, () => '= [\n' + entry + ']')
      } else {
        const marker = text.lastIndexOf('\n]')
        if (marker < 0) throw new Error('imported-puzzles.ts 格式异常：找不到结尾 ]')
        text = text.slice(0, marker + 1) + entry + text.slice(marker + 1)
      }
      writeFileSync(dataFile, text)
    }
    console.log(`[import] 已写入 ${dataFile}：${id} ${name}`)
    console.log('[import] 提示：导入题写在 imported-puzzles.ts，不会被 npm run gen 覆盖。')
  }
} else {
  console.log('[import] 预览模式（未写入）。加 --append 写入 src/game/imported-puzzles.ts。')
}
