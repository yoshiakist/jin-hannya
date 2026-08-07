/**
 * 紙面（L0 の格子）のワールド座標。
 *
 * 単位は「1 升 = 1」。字の大きさは可読性から決め、画面幅から逆算しない（README「画面外へはみ出してよい」）。
 * 縦 16 升ぶんが画面高に収まるようカメラの視野を決め、横は収めない。
 */

import { COLS_PER_LINE, GRID_COLUMNS, cellOf } from '../content/sutra.ts'

/** 字送り（列内・縦方向）。1.0 だと升が詰まりすぎるので少し空ける */
export const CELL_Y = 1.1
/** 行送り（列間・横方向） */
export const CELL_X = 1.61

/** 字そのものの大きさ。グリフは 1x1 に正規化されているので升とは独立に持つ */
export const GLYPH_SIZE = 0.95

/** 上下の余白（合計）。字送りに引きずられないよう絶対値で持つ */
export const MARGIN_Y = 2.93

/** 縦 16 升 + 上下の余白。カメラの視野高はこの値に固定する */
export const VIEW_HEIGHT = COLS_PER_LINE * CELL_Y + MARGIN_Y

/** 紙面の幅（ワールド単位） */
export const PAPER_WIDTH = (GRID_COLUMNS - 1) * CELL_X

/** 格子上の位置。列は右から左（x が負へ）、文字は上から下（y が負へ）進む */
export function gridPosition(index: number): [number, number] {
  const { column, row } = cellOf(index)
  return [-column * CELL_X, ((COLS_PER_LINE - 1) / 2 - row) * CELL_Y]
}

// パン可能な範囲はビューポート依存なので src/world/pan.ts が実測から引き直す。
// ここは紙面そのものの寸法だけを持つ。
