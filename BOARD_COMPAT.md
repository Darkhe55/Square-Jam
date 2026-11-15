# 模板棋盘兼容扩展

本次扩展让 `src/core` 不再只支持「方块网格 + 单格填值」，同时保持所有旧游戏（只使用 `pad`/`cell`/`HitTarget.index`）完全兼容。

## 1. BoardMetrics：非对称留白与矩形格

新增可选字段：

| 字段 | 含义 |
|------|------|
| `originX` / `originY` | 棋盘区左上角（默认 = `pad`） |
| `cellW` / `cellH` | 单元格宽高（默认 = `cell`） |
| `padLeft` / `padTop` / `padRight` / `padBottom` | 四边留白，用于行列线索/刻度 |
| `shape` | `'square' \| 'hex' \| 'triangle'`（元信息，渲染/命中由游戏实现） |
| `targetKind` | `'cell' \| 'edge' \| 'vertex'`（主命中目标类型） |

旧游戏继续使用 `m.pad` 和 `m.cell` 即可，无需改动。

## 2. `src/core/board.ts`：通用几何工具

```ts
import { squareMetrics, cellAtPoint, edgeAtPoint, edgeCells, vertexAtPoint, regionBoundarySegments, regionFill } from './core/board'

// 方阵 + 线索留白
const m = squareMetrics(w, h, { cell: 44, padLeft: 88, padTop: 88, padRight: 20, padBottom: 20 })

// 单格命中
const index = cellAtPoint(m, x, y)

// 边命中：返回标准边索引（水平优先，再竖直）
const edge = edgeAtPoint(m, x, y)
const pair = edgeCells(edge, w, h) // { a, b, horizontal }

// 顶点命中
const v = vertexAtPoint(m, x, y)

// 区域粗边界与配色
const segments = regionBoundarySegments(m, regions)
const fill = regionFill(region)
```

标准边索引：

- 水平边：`h*(w-1)` 条，`horizontalEdgeIndex(w,x,y) = y*(w-1)+x`
- 竖直边：`(h-1)*w` 条，`verticalEdgeIndex(w,h,x,y) = h*(w-1)+y*w+x`
- 顶点：`(w+1)*(h+1)` 个，`vertexIndex(w,x,y) = y*(w+1)+x`

## 3. HitTarget：复合目标

```ts
interface HitTarget {
  index: number
  kind?: 'cell' | 'edge' | 'vertex'
  a?: number
  b?: number
  x?: number
  y?: number
}
```

游戏仍只需要保证 `valueAt/cycleValue/applyMove` 使用 `index`；`kind/a/b` 可用于边、顶点或同格多层的额外信息。

## 4. CustomSupport：四种自定义题板模式

```ts
const custom: CustomSupport = {
  mode: 'edge', // 'cell' | 'region' | 'picture' | 'edge' | 'none'
  valueCycle: [null, 1],
  keyForDigit: (d) => (d === 0 ? null : d),
  cellLabel: (v) => (v == null ? '' : String(v)),
  hint: '在格子之间画边',

  // edge 模式专用
  edgeValueCycle: [null, 1],
  edgeLabel: (v) => (v == null ? '' : '│'),
  makePuzzleFromEdges: (w, h, edges, existingId) => ({ ... }),

  makePuzzle: (w, h, grid, existingId) => ({ ... }),
  encodePuzzle: (p) => ({ ... }),
  decodePuzzle: (r) => ({ ... }),
}
```

- `cell`：原行为。
- `region` / `picture`：编辑器外观同 `cell`，由游戏解释为区域号或图案。
- `edge`：编辑器渲染 `(2w-1) × (2h-1)` 的边网格；水平边按行、竖直边按行排列，索引顺序与 `board.ts` 一致。
- `none`：标题栏的「自定义」按钮禁用，避免不支持的棋盘出现空编辑器。

## 5. GameMeta：交互提示

```ts
const meta = {
  ...
  targetKind: 'edge',
  interactionHint: '<kbd>左键</kbd> 画边 · <kbd>右键</kbd> 清除',
}
```

`targetKind` 在未提供 `interactionHint` 时会自动生成默认文案（格子/边/顶点）。

## 6. 推荐的新游戏接入方式

| 棋盘类型 | 需要用到 |
|----------|----------|
| 方块填值（阴阳、数墙、数壹、黑白+…） | 现有 cell 模式 |
| 行列线索（数织、温度计） | `squareMetrics` 的非对称留白 |
| 区域划分（LITS、星之战、星系、数方） | `regionBoundarySegments` + `regionFill` |
| 画边/环路（数回、珍珠、信号旗、搭桥、缝线、数邻） | `edgeAtPoint` + `edgeCells` + `custom.mode='edge'` |
| 顶点/交点（划斜线、信号旗） | `vertexAtPoint` / `vertexCenter` |
| 六边形/三角形（未来） | `BoardMetrics.shape` + 自行实现 `hitTest`/`renderBoard` |

## 7. 向后兼容

- 所有新增字段都是可选的。
- 旧 `metricsFor` 仍可只返回 `cell/pad/width/height/svgWidth/svgHeight/k`。
- 旧 `custom` 不写 `mode` 时默认 `'cell'`。
- 旧 `HitTarget` 只返回 `{ index }` 仍然有效。

## 8. GameInteraction：自定义拖拽 / 键盘交互（新增，可选）

「从一角拖到对角画正方形」这类手势无法用默认的「点击循环涂写」表达，因此
`GameAdapter` 增加一个**可选**的 `interaction` 字段，由适配器完全接管棋盘指针操作：

```ts
import type { GameInteraction } from '../core/types'

const interaction: GameInteraction = {
  // 返回 true = 已接管这次按下（模板不再执行默认点击逻辑）
  down(ctx) {
    // ctx: { event, svg, point, target, metrics, puzzle, state,
    //        commit(move), render(), status(text, tone) }
    return true
  },
  move(ctx) {},                  // 拖拽中（此时只更新预览层，不要整块重绘）
  up(ctx) {},                    // 松开：用 ctx.commit(move) 落子，再 ctx.render()
  cancel() {},                   // pointercancel
  reset() {},                    // 切换题目 / 清空盘面
  handleKey(ctx) { return false }, // 方向键 / 回车 / Esc 等，返回 true = 已消费
}

const adapter: GameAdapter = { /* ... */, interaction }
```

接入后模板会自动：

- 不再生成默认的「按住拖拽连续涂写」图例，改为提示拖拽/键盘；
- 仍然负责缩放、平移、按钮状态、撤销重做、逻辑回放与存档；
- 键盘 `Z/C/L/P/R/M/±/0` 等模板快捷键保持不变；`interaction.handleKey` 优先于它们被调用。

`commit(move)` 只做「应用 + 记撤销栈 + 存档」，不会重绘 —— 手势结束时调用一次
`render()` 即可，一次手势 = 一步撤销。

参考实现：`方块拼盘/src/game/interaction.ts`（方块拼盘）。

