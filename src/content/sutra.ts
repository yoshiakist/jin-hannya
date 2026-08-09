/**
 * 全文テキストと格子座標。
 *
 * `content/sutra.txt` は文字インデックスの唯一の基準である。
 * ただしファイル上は可読性のために改行が入っていることがあるため、
 * **空白類をすべて除去した文字列**を正規形（canonical）として扱う。
 * README「`content/sutra.txt`」の規定（改行・空白・約物を含めない）に対する
 * 実装側の受け皿がこれで、ファイルを手で整形しても range がずれない。
 *
 * range の基準は正規形のままだが、**格子の列の切れ目はファイルの改行位置に従う**。
 * 1 行 = 1 列で、行が `COLS_PER_LINE` を超えるぶんだけ次の列へ折り返す。
 * 行が短ければその列は途中で終わり、次の字は必ず次の列の先頭（上端）から始まる。
 */

import { contentSource } from './source.ts'

const rawSutra = contentSource.sutra

/** 1 列に収める文字数の上限。README「ルート画面（全文格子）」より */
export const COLS_PER_LINE = 16

/** ファイルの 1 行 = 1 つの塊。行内の空白は落とし、空行は列を作らないので捨てる */
export const SUTRA_LINES: readonly string[] = rawSutra
  .split(/\r?\n/u)
  .map((line) => line.replace(/\s+/gu, ''))
  .filter((line) => line.length > 0)

/** 空白類（半角・全角・改行）をすべて落とした正規形 */
export const SUTRA = SUTRA_LINES.join('')

/** 正規形を 1 文字ずつに分解したもの。インデックスの基準 */
export const SUTRA_CHARS: readonly string[] = Array.from(SUTRA)

export const SUTRA_LENGTH = SUTRA_CHARS.length

export interface GridCell {
  /** 全文に対する文字インデックス */
  index: number
  /** 右から数えた列番号。0 が最初の列（＝紙面の右端） */
  column: number
  /** 列内の上からの位置 */
  row: number
}

/**
 * `index → (column, row)` の表を、行の切れ目で列を送りながら組む。
 * 行の長さが不揃いでも、次の行は必ず新しい列の row = 0 から始まる。
 */
function buildCells(): GridCell[] {
  const cells: GridCell[] = []
  let index = 0
  let column = 0
  for (const line of SUTRA_LINES) {
    let row = 0
    for (const _char of line) {
      // 1 行が上限を超えたら、同じ行の続きとして次の列へ折り返す
      if (row === COLS_PER_LINE) {
        column += 1
        row = 0
      }
      cells.push({ index, column, row })
      index += 1
      row += 1
    }
    column += 1
  }
  return cells
}

/** 全文ぶんの格子セル */
export const GRID_CELLS: readonly GridCell[] = buildCells()

/** 格子の列数。データから導出する（ハードコードしない） */
export const GRID_COLUMNS = (GRID_CELLS[GRID_CELLS.length - 1]?.column ?? 0) + 1

/** `(column, row) → index`。当たり判定でワールド座標から字を引くのに使う */
const INDEX_BY_CELL = new Map<number, number>(
  GRID_CELLS.map((cell) => [cell.column * COLS_PER_LINE + cell.row, cell.index]),
)

/** `index → (column, row)`。縦組みなので列は右から左、文字は上から下へ進む */
export function cellOf(index: number): GridCell {
  return GRID_CELLS[index] ?? { index, column: 0, row: 0 }
}

/** `(column, row)` に字があればその全文インデックス。無ければ `null`（行末より下の空き升） */
export function indexAt(column: number, row: number): number | null {
  if (column < 0 || column >= GRID_COLUMNS) return null
  if (row < 0 || row >= COLS_PER_LINE) return null
  return INDEX_BY_CELL.get(column * COLS_PER_LINE + row) ?? null
}

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
