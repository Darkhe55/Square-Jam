/**
 * 图片导入的题目（scripts/import-image.mjs 写入）
 *
 * 与 puzzles-data.ts 分开放，避免 `npm run gen` 重新生成题库时被覆盖。
 * 默认是空数组；用 `npm run import-image -- <图片> --append` 追加条目。
 */
import type { RawPuzzle } from './puzzles-data'

export const IMPORTED_PUZZLES: RawPuzzle[] = []
