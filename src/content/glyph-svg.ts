/**
 * DOM レイヤーで筆文字の字面を出すための、字 → SVG ファイルの URL 表。
 *
 * GPU レイヤーの字（大書・紙面・粒子）はビルド時に前計算した mesh / particles / sdf を読む。
 * ここはそれとは別で、**DOM に置く小さな字**（関連語句）が同じ筆文字で出るようにするためのもの。
 * SVG は `mask-image` として敷くだけで、ランタイムでパスを読んだりサンプリングしたりはしない
 * （README「ランタイムで SVG を触らない」はサンプリングの話で、画像として貼るのは含まない）。
 *
 * 字面は色を持たない型紙として扱う。塗りは CSS 側（`background-color`）が決めるので、
 * 墨・琥珀の切り替えが他の DOM 文字と同じトークンから引ける。
 */

import { contentSource } from './source.ts'

/** scripts/build-content.ts が assets/svg/ からコピーした在庫。URL は字がそのままファイル名 */
const stock = new Set(contentSource.svgChars)

/**
 * 1 字ぶんの SVG の URL。在庫が無ければ `undefined`。
 *
 * `label` に使う字の在庫はビルド時に検証されている（`scripts/validate-graph.ts` のグリフ在庫）ので、
 * 通常は必ず引ける。引けなかったときは呼び出し側で素の文字へ落とす。
 */
export function glyphUrl(char: string): string | undefined {
  return stock.has(char) ? `/glyph-svg/${encodeURIComponent(char)}.svg` : undefined
}
