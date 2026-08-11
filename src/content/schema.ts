import { z } from 'zod'

/**
 * `content/graph/*.yaml` のスキーマ。
 *
 * README「コンテンツモデル」の定義をそのまま写したもの。
 * ここが唯一のスキーマ定義で、ビルド時検証（scripts/validate-graph.ts）と
 * ランタイムのローダ（src/content/loader.ts）の双方がこれを使う。
 */

/**
 * ノードの種別。深度ではなく「何であるか」を表す。
 * `page` だけは経文の外側にあるノード（このサイトについて 等）で、
 * 木にも隣接にも繋がらないが、L1 と同じ画面文法・同じ遷移で読ませる。
 */
export const NodeKind = z.enum(['sutra', 'phrase', 'term', 'page'])
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

const GraphNodeFields = z.object({
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
  /**
   * 隣接ノードの帰属先。`parent` と排他で、**深度を持たない語**（下位分類ではないが
   * その層の理解に要る語）がどの層に属するかを示す。URL と現在位置はこれを親として辿る。
   */
  anchor: Slug.optional(),
  /**
   * 隣接ノード。包含ではない横の関係で、図には出さず「関連語句」として出す。
   * 向きを持たないので**片側にだけ書けばよい**（逆向きはローダが張る）。
   */
  related: z.array(Slug).default([]),
  layout: Layout,
  /** 経文に登場しない概念ノードは持たない */
  range: Range.optional(),
  /** assets/voice/ 配下のファイル名。未収録なら省略 */
  audio: z.string().optional(),
  /**
   * 原稿（`summary` と `docs/*.md`）が AI 生成のままで、人手の監修を経ていないこと。
   * 監修が入ったら**この行を消す**（false を書き足さない）。既定は false。
   */
  ai_generated: z.boolean().default(false),
})

/**
 * 木の子（`parent` / `children`）と隣接（`anchor` / `related`）は別の関係で、混ぜられない。
 * 隣接ノードは層に属するだけなので、そこからさらに木を生やさない。
 */
export const GraphNode = GraphNodeFields.refine(
  (node) => !(node.parent && node.anchor),
  { message: 'parent と anchor は排他。木の子か隣接語かのどちらかにする', path: ['anchor'] },
)
  .refine((node) => !(node.anchor && node.children.length > 0), {
    message: '隣接ノード（anchor 持ち）は children を持てない',
    path: ['children'],
  })
  .refine((node) => !(node.anchor && node.layout !== 'none'), {
    message: '隣接ノードは子の図を持たないので layout: none にする',
    path: ['layout'],
  })
  /**
   * 独立ページ（`kind: page`）は経文のグラフの外に居る。木にも隣接にも繋がず、
   * 経文の字も指さない。位置づけは「根と並ぶもう 1 枚」で、深度は L1 と同じ扱いになる
   * （経路は `ancestryOf` が根に繋ぐ）。ここで結線を禁じておかないと、
   * 語の一覧や関連語句に紛れ込んで経文の読み筋を濁す。
   */
  .refine(
    (node) =>
      node.kind !== 'page' ||
      (!node.parent && !node.anchor && node.children.length === 0 && node.related.length === 0),
    { message: 'kind: page は木にも隣接にも繋がない（parent / anchor / children / related を持たない）' },
  )
  /**
   * 独立ページの `range` は**遷移で持ち越す字の指定**であって、経文の語の宣言ではない。
   * 「深般若」はサイトの名を経文の一行（行深般若波羅蜜多時）から借りたもので、
   * 語のまとまりではない（`深` は `行` に掛かる）。だから紙面では光らせず・入口にもせず、
   * リンクから出入りするときにその 3 字が大書へ抜けていく動きにだけ使う（→ `Transition.tsx`）。
   * 字が合っているか（`range` の指す字 = `label`）はビルド時検証が見る。
   */
  .refine((node) => !(node.kind === 'page' && node.layout !== 'none'), {
    message: 'kind: page は子を持たないので layout: none にする',
    path: ['layout'],
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
