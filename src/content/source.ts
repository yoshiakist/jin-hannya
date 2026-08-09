/**
 * 前計算済みコンテンツ（scripts/build-content.ts の出力）への唯一の入口。
 *
 * 生成物 content.json は巨大なリテラルとして推論されると型検査が重くなるだけなので、
 * ここで一度だけ意味のある型へ付け替え、他のモジュールはこれを経由して読む。
 * 中身の検証（zod・参照整合性）は loader.ts と scripts/validate-graph.ts の仕事。
 */

import generated from '../generated/content.json'

interface ContentSource {
  /** content/sutra.txt の生テキスト。改行が L0 の列の切れ目なのでそのまま */
  sutra: string
  /** ファイル名 → YAML をパースした素の値 */
  graph: Record<string, unknown>
  /** ファイル名 → frontmatter 込みの生 Markdown */
  docs: Record<string, string>
  /** DOM 用筆文字（public/glyph-svg/）の在庫 */
  svgChars: string[]
  /** 読み上げ音源（public/audio/voice/）の在庫 */
  voiceFiles: string[]
}

export const contentSource = generated as ContentSource
