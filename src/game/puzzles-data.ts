/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "sj-6x6-a", name: "方块拼盘 · 6×6 · A", width: 6, height: 6, difficulty: "easy", series: "builtin-6x6", board: "021030001000100000102100020220000011", solution: "112333114333566333766899aabb99aabbcd" },
  { id: "sj-6x6-b", name: "方块拼盘 · 6×6 · B", width: 6, height: 6, difficulty: "easy", series: "builtin-6x6", board: "110211200000000002022002000000110211", solution: "1233456633776688779988aa99bbaacdbbef" },
  { id: "sj-7x7-a", name: "方块拼盘 · 7×7 · A", width: 7, height: 7, difficulty: "easy", series: "builtin-7x7", board: "1000011100002010004000000020000200030000000001020", solution: "1222234522226672222668222299aaabb99aaabbccaaadecc" },
  { id: "sj-8x8-a", name: "方块拼盘 · 8×8 · A", width: 8, height: 8, difficulty: "medium", series: "builtin-8x8", board: "0130000102000020000000030000100004001000000030010000000011110001", solution: "1233344566333447663338889999a8889999b8889999cccd9999cccefghicccj" },
  { id: "sj-8x8-b", name: "方块拼盘 · 8×8 · B", width: 8, height: 8, difficulty: "medium", series: "builtin-8x8", board: "0000000102000000104000002000000000000020010000000200002000040011", solution: "1122223411222255672222558822229988aaaa99bcaaaaddeeaaaaddeeaaaafg" },
  { id: "sj-9x9-a", name: "方块拼盘 · 9×9 · A", width: 9, height: 9, difficulty: "hard", series: "builtin-9x9", board: "000000100000030120300000001003000200020000000000000000000000000000300040200001100", solution: "11122234411122254411122266788999a66b88999ccccdd999ccccddeeeccccffeeeccccffeeeghij" },
  { id: "sj-10x10-a", name: "方块拼盘 · 10×10 · A", width: 10, height: 10, difficulty: "hard", series: "builtin-10x10", board: "0000000002000000300000000000200000010100000000000011100000000002050000003100000000000000001000010011", solution: "111112223311111222331111122244111115674411111888889abcc88888dddcc88888dddef88888dddgg88888hijggklmno" },
]
