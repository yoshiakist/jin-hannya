import { z } from 'zod'

/**
 * `content/graph/*.yaml` のスキーマ。
 *
 * README「コンテンツモデル」の定義をそのまま写したもの。
 * ここが唯一のスキーマ定義で、ビルド時検証（scripts/validate-graph.ts）と
 * ランタイムのローダ（src/content/loader.ts）の双方がこれを使う。
 */

/** ノードの種別。深度ではなく「何であるか」を表す */
export const NodeKind = z.enum(['sutra', 'phrase', 'term'])
export type NodeKind = z.infer<typeof NodeKind>

/**
 * 子ノードの配置文法。描画側では決めず、概念ごとにノードが持つ。
 * - `none`   … 子の図を持たない（img_01）
 * - `circle` … 円相の内側に子を円周配置（img_03）
 * - `column` … 角丸矩形を縦に連結（img_02）
 */
export const Layout = z.enum(['none', 'circle', 'column'])
export type Layout = z.infer<typeof Layout>

/** 全文に対する文字インデックスの半開区間 `[start, end)` */
export const Range = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => start < end, {
    message: 'range は [start, end) の半開区間。start < end であること',
  })
export type Range = z.infer<typeof Range>

export const Sanskrit = z.object({
  /** ラテン翻字 */
  text: z.string().min(1),
  /** カナ表記 */
  kana: z.string().min(1),
})
export type Sanskrit = z.infer<typeof Sanskrit>

/** スラッグ。ローマ字小文字とハイフンのみ */
const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, 'id はローマ字小文字とハイフンのみ')

/** 列の切れ目。`label` と `reading` で共通 */
export const COLUMN_BREAK = '/'

/**
 * `label` / `reading` を列に割る。切れ目は `/` だけで、空白は列の中身として残す
 * （読みの中の半角・全角スペースを意図どおり出すため）。
 * `/` の前後の半角空白・改行だけは YAML の書きやすさのために落とす。
 */
export function splitColumns(value: string): string[] {
  return value
    .split(COLUMN_BREAK)
    .map((column) => column.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, ''))
    .filter((column) => column.length > 0)
}

export const GraphNode = z.object({
  id: Slug,
  kind: NodeKind,
  /**
   * 大書に使う文字列。構成文字はすべて assets/svg/ に存在すること。
   * `/` が**列の切れ目**（`headlineLayout`）。字そのものは `labelText()` で取り出す。
   */
  label: z
    .string()
    .min(1)
    .refine((value) => splitColumns(value).every((column) => !/\s/u.test(column)), {
      message: '大書の列の中に空白は置けない。列の切れ目は / で示す',
    }),
  reading: z.string().min(1),
  sanskrit: Sanskrit.optional(),
  /** 右中段の短い定義（数十字） */
  summary: z.string().min(1),
  parent: Slug.optional(),
  children: z.array(Slug).default([]),
  /** 隣接ノード。フィールドとしては持つが UI・遷移は未定義（README「設計対象外」） */
  related: z.array(Slug).default([]),
  layout: Layout,
  /** 経文に登場しない概念ノードは持たない */
  range: Range.optional(),
  /** assets/voice/ 配下のファイル名。未収録なら省略 */
  audio: z.string().optional(),
})
export type GraphNode = z.infer<typeof GraphNode>

/**
 * label から列の切れ目（`/`）と空白を除いた字だけの並び。
 * range との突き合わせ、図の中の子の組版、グリフ在庫の検査はこちらを見る。
 */
export function labelText(label: string): string {
  return label.replace(/[/\s]+/gu, '')
}

/** `content/docs/*.md` の frontmatter */
export const DocFrontmatter = z.object({
  id: Slug,
})
export type DocFrontmatter = z.infer<typeof DocFrontmatter>
