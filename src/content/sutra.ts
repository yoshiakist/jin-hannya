/**
 * 全文テキストと格子座標。
 *
 * `content/sutra.txt` は文字インデックスの唯一の基準である。
 * ただしファイル上は可読性のために改行が入っていることがあるため、
 * **空白類をすべて除去した文字列**を正規形（canonical）として扱う。
 * README「`content/sutra.txt`」の規定（改行・空白・約物を含めない）に対する
 * 実装側の受け皿がこれで、ファイルを手で整形しても range がずれない。
 */

import rawSutra from '#content/sutra.txt?raw'

/** 1 列に収める文字数。README「ルート画面（全文格子）」より */
export const COLS_PER_LINE = 16

/** 空白類（半角・全角・改行）をすべて落とした正規形 */
export const SUTRA = rawSutra.replace(/\s+/gu, '')

/** 正規形を 1 文字ずつに分解したもの。インデックスの基準 */
export const SUTRA_CHARS: readonly string[] = Array.from(SUTRA)

export const SUTRA_LENGTH = SUTRA_CHARS.length

/** 格子の列数。データから導出する（ハードコードしない） */
export const GRID_COLUMNS = Math.ceil(SUTRA_LENGTH / COLS_PER_LINE)

export interface GridCell {
  /** 全文に対する文字インデックス */
  index: number
  /** 右から数えた列番号。0 が最初の列（＝紙面の右端） */
  column: number
  /** 列内の上からの位置 */
  row: number
}

/** `index → (column, row)`。縦組みなので列は右から左、文字は上から下へ進む */
export function cellOf(index: number): GridCell {
  return {
    index,
    column: Math.floor(index / COLS_PER_LINE),
    row: index % COLS_PER_LINE,
  }
}

/** 全文ぶんの格子セル */
export const GRID_CELLS: readonly GridCell[] = SUTRA_CHARS.map((_, i) => cellOf(i))

/** 半開区間 `[start, end)` に含まれるインデックスの配列 */
export function indicesInRange([start, end]: readonly [number, number]): number[] {
  const lo = Math.max(0, start)
  const hi = Math.min(SUTRA_LENGTH, end)
  const out: number[] = []
  for (let i = lo; i < hi; i++) out.push(i)
  return out
}

/** 半開区間が指す文字列 */
export function sliceOfRange([start, end]: readonly [number, number]): string {
  return SUTRA_CHARS.slice(start, end).join('')
}
