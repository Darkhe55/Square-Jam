/**
 * 方块拼盘 —— 拖拽/键盘交互的瞬时界面状态
 *
 * 这部分状态不属于棋局存档：正在拖拽的预览正方形、键盘光标、拖拽锚点。
 * 渲染层读取它画出「幽灵正方形」与光标；交互层负责更新它。
 */

import type { SquareRect } from './types.ts'

export interface UiState {
  /** 正在拖拽/键盘选取的预览正方形 */
  preview: SquareRect | null
  /** 预览是否合法（不与已有区域重叠、不违反线索/tatami） */
  previewValid: boolean
  /** 键盘光标所在格 */
  cursor: { x: number; y: number }
  /** 是否显示键盘光标 */
  cursorVisible: boolean
  /** 当前起笔锚点（按下一角） */
  anchor: { x: number; y: number } | null
}

export const uiState: UiState = {
  preview: null,
  previewValid: true,
  cursor: { x: 0, y: 0 },
  cursorVisible: false,
  anchor: null,
}

export function resetUi(): void {
  uiState.preview = null
  uiState.previewValid = true
  uiState.cursor = { x: 0, y: 0 }
  uiState.cursorVisible = false
  uiState.anchor = null
}

export function clampCursor(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(w - 1, x)),
    y: Math.max(0, Math.min(h - 1, y)),
  }
}
