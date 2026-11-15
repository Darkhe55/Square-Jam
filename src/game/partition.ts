/**
 * 方块拼盘 —— 通用「正方形划分」几何与规则工具
 *
 * 求解器、逻辑推理、随机出题器、校验器共用这一份实现，保证规则完全一致：
 *   - 覆盖：每个格子恰好属于一个正方形；
 *   - 线索：正方形内的所有数字必须等于边长；
 *   - tatami：内部顶点处四个相邻格不能「两两不同」（否则四条区域边界在同一点相交，
 *     等价于两个正方形只在一个点接触）。
 *
 * 关键性质（行优先搜索的依据）：
 *   在所有「已确定被覆盖」的格子之后，第一个尚未覆盖的格子 (x,y)
 *   若能作为某个正方形的左上角，则它必须是该正方形的左上角 ——
 *   因为它的左方与上方格子都已被覆盖，正方形不可能向左上扩展。
 */

import type { SquareRect } from './types.ts'

/** 区域归属网格：-1 = 未覆盖，>=0 = 区域下标 */
export type OwnerGrid = Int16Array

export interface OwnerBuild {
  owner: OwnerGrid
  /** 每格被多个区域覆盖的位置 */
  overlap: number[]
  /** 越界 / 非法区域下标 */
  invalidRegions: number[]
  /** 每个区域实际拥有的格数（正常 = size²） */
  ownedCount: number[]
}

export function emptyOwners(w: number, h: number): OwnerGrid {
  return new Int16Array(w * h).fill(-1)
}

/** 由区域列表构建归属网格，同时报告重叠与非法区域 */
export function buildOwner(
  regions: readonly SquareRect[],
  w: number,
  h: number,
): OwnerBuild {
  const owner = emptyOwners(w, h)
  const overlap = new Set<number>()
  const invalidRegions: number[] = []
  const ownedCount = new Array<number>(regions.length).fill(0)

  for (let r = 0; r < regions.length; r++) {
    const rect = regions[r]!
    const inBounds =
      Number.isInteger(rect.x) &&
      Number.isInteger(rect.y) &&
      Number.isInteger(rect.size) &&
      rect.size >= 1 &&
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.size <= w &&
      rect.y + rect.size <= h
    if (!inBounds) {
      invalidRegions.push(r)
      continue
    }
    for (let dy = 0; dy < rect.size; dy++) {
      const y = rect.y + dy
      for (let dx = 0; dx < rect.size; dx++) {
        const x = rect.x + dx
        const i = y * w + x
        if (owner[i]! >= 0) {
          overlap.add(i)
          continue
        }
        owner[i] = r
        ownedCount[r] = ownedCount[r]! + 1
      }
    }
  }
  return {
    owner,
    overlap: Array.from(overlap),
    invalidRegions,
    ownedCount,
  }
}

/* ────────────────────────── tatami ────────────────────────── */

/** 内部顶点 (gx,gy) 处四个相邻格是否两两不同（= 四条区域边界交于一点） */
export function isTatamiViolation(
  owner: ArrayLike<number>,
  w: number,
  h: number,
  gx: number,
  gy: number,
): boolean {
  if (gx < 1 || gy < 1 || gx > w - 1 || gy > h - 1) return false
  const nw = owner[(gy - 1) * w + (gx - 1)]!
  const ne = owner[(gy - 1) * w + gx]!
  const sw = owner[gy * w + (gx - 1)]!
  const se = owner[gy * w + gx]!
  if (nw < 0 || ne < 0 || sw < 0 || se < 0) return false
  return nw !== ne && ne !== se && se !== sw && sw !== nw
}

export function vertexIndex(w: number, gx: number, gy: number): number {
  return gy * (w + 1) + gx
}

export function vertexFromIndex(w: number, index: number): { gx: number; gy: number } {
  return { gx: index % (w + 1), gy: Math.floor(index / (w + 1)) }
}

/** 内部顶点处四个相邻格（用于高亮） */
export function vertexCells(w: number, gx: number, gy: number): number[] {
  return [
    (gy - 1) * w + (gx - 1),
    (gy - 1) * w + gx,
    gy * w + (gx - 1),
    gy * w + gx,
  ]
}

/**
 * 放置 rect 后可能新产生的 tatami 冲突顶点（只检查「四格都已覆盖」的顶点）。
 * 只有新覆盖格子的四个角附近的顶点才可能从「未满」变成「满」。
 */
export function tatamiViolationsAfter(
  owner: ArrayLike<number>,
  w: number,
  h: number,
  rect: SquareRect,
): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (let dy = 0; dy <= rect.size; dy++) {
    const gy = rect.y + dy
    if (gy < 1 || gy > h - 1) continue
    for (let dx = 0; dx <= rect.size; dx++) {
      const gx = rect.x + dx
      if (gx < 1 || gx > w - 1) continue
      const v = vertexIndex(w, gx, gy)
      if (seen.has(v)) continue
      seen.add(v)
      if (isTatamiViolation(owner, w, h, gx, gy)) out.push(v)
    }
  }
  return out
}

/** 当前盘面上全部 tatami 冲突顶点 */
export function allTatamiViolations(
  owner: ArrayLike<number>,
  w: number,
  h: number,
): number[] {
  const out: number[] = []
  for (let gy = 1; gy < h; gy++) {
    for (let gx = 1; gx < w; gx++) {
      if (isTatamiViolation(owner, w, h, gx, gy)) out.push(vertexIndex(w, gx, gy))
    }
  }
  return out
}

/* ────────────────────────── 放置可行性 ────────────────────────── */

export function clueAt(clues: ArrayLike<number>, index: number): number {
  return clues[index] ?? 0
}

/**
 * 正方形能否放置：不越界、不与已覆盖格重叠、内部线索全部等于边长。
 * 不检查 tatami。
 */
export function squareFits(
  owner: ArrayLike<number>,
  w: number,
  h: number,
  clues: ArrayLike<number>,
  rect: SquareRect,
): boolean {
  if (
    rect.size < 1 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.size > w ||
    rect.y + rect.size > h
  ) {
    return false
  }
  for (let dy = 0; dy < rect.size; dy++) {
    const y = rect.y + dy
    for (let dx = 0; dx < rect.size; dx++) {
      const i = y * w + (rect.x + dx)
      if (owner[i]! >= 0) return false
      const clue = clueAt(clues, i)
      if (clue > 0 && clue !== rect.size) return false
    }
  }
  return true
}

/** 正方形能否放置（含 tatami） */
export function placementAllowed(
  owner: OwnerGrid,
  w: number,
  h: number,
  clues: ArrayLike<number>,
  rect: SquareRect,
): boolean {
  if (!squareFits(owner, w, h, clues, rect)) return false
  for (let dy = 0; dy < rect.size; dy++) {
    const y = rect.y + dy
    for (let dx = 0; dx < rect.size; dx++) owner[y * w + rect.x + dx] = 10000
  }
  const violations = tatamiViolationsAfter(owner, w, h, rect)
  for (let dy = 0; dy < rect.size; dy++) {
    const y = rect.y + dy
    for (let dx = 0; dx < rect.size; dx++) owner[y * w + rect.x + dx] = -1
  }
  return violations.length === 0
}

export function placeRect(owner: OwnerGrid, w: number, rect: SquareRect, value: number): void {
  for (let dy = 0; dy < rect.size; dy++) {
    const y = rect.y + dy
    for (let dx = 0; dx < rect.size; dx++) owner[y * w + rect.x + dx] = value
  }
}

export function unplaceRect(owner: OwnerGrid, w: number, rect: SquareRect): void {
  for (let dy = 0; dy < rect.size; dy++) {
    const y = rect.y + dy
    for (let dx = 0; dx < rect.size; dx++) owner[y * w + rect.x + dx] = -1
  }
}

/** 行优先第一个未覆盖格；-1 = 已铺满 */
export function firstUncovered(owner: ArrayLike<number>): number {
  for (let i = 0; i < owner.length; i++) if (owner[i]! < 0) return i
  return -1
}

/** 某格被哪个区域覆盖（-1 = 未覆盖） */
export function regionAt(owner: ArrayLike<number>, w: number, x: number, y: number): number {
  return owner[y * w + x] ?? -1
}

/**
 * 枚举覆盖某个格子的全部正方形（任意边长，左上角可在该格左上方向）。
 * 供逻辑规则「数字线索候选」使用；搜索主循环不需要它。
 */
export function squaresContainingCell(
  w: number,
  h: number,
  cx: number,
  cy: number,
): SquareRect[] {
  const maxSide = Math.min(w, h)
  const out: SquareRect[] = []
  for (let size = 1; size <= maxSide; size++) {
    const minSx = Math.max(0, cx - size + 1)
    const maxSx = Math.min(cx, w - size)
    const minSy = Math.max(0, cy - size + 1)
    const maxSy = Math.min(cy, h - size)
    for (let sy = minSy; sy <= maxSy; sy++) {
      for (let sx = minSx; sx <= maxSx; sx++) out.push({ x: sx, y: sy, size })
    }
  }
  return out
}

/** 边长恰为 size、覆盖某个格子的全部正方形位置 */
export function squaresOfSizeContaining(
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
): SquareRect[] {
  if (size < 1 || size > w || size > h) return []
  const out: SquareRect[] = []
  const minSx = Math.max(0, cx - size + 1)
  const maxSx = Math.min(cx, w - size)
  const minSy = Math.max(0, cy - size + 1)
  const maxSy = Math.min(cy, h - size)
  for (let sy = minSy; sy <= maxSy; sy++) {
    for (let sx = minSx; sx <= maxSx; sx++) out.push({ x: sx, y: sy, size })
  }
  return out
}
