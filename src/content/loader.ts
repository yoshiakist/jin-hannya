/**
 * `content/graph/*.yaml` と `content/docs/*.md` を読み込み、zod で検証してグラフを組む。
 *
 * YAML / Markdown は scripts/build-content.ts がビルド時に 1 本の JSON へ束ねてある。
 * ここでの zod 検証は「型を信じるための最後の関門」であり、
 * 参照整合性など横断的な検査は scripts/validate-graph.ts が CI で行う。
 */

import { GraphNode, DocFrontmatter, labelText } from './schema.ts'
import { contentSource } from './source.ts'
import { SUTRA_CHARS, SUTRA_LENGTH, sliceOfRange } from './sutra.ts'

const yamlModules = contentSource.graph
const docModules = contentSource.docs

export interface Doc {
  id: string
  /** frontmatter を除いた本文。DOM レイヤーで縦書き組版される */
  body: string
}

/** frontmatter 付き Markdown を分割する。`---` で囲まれた先頭ブロックのみを見る */
function splitFrontmatter(source: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { frontmatter: {}, body: source.trim() }

  const frontmatter: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 0) continue
    frontmatter[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return { frontmatter, body: source.slice(match[0].length).trim() }
}

function loadNodes(): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>()
  for (const [path, source] of Object.entries(yamlModules)) {
    const parsed = GraphNode.safeParse(source)
    if (!parsed.success) {
      throw new Error(`${path}: グラフノードのスキーマ違反\n${z_issues(parsed.error)}`)
    }
    const node = parsed.data
    if (nodes.has(node.id)) throw new Error(`${path}: id "${node.id}" が重複している`)
    nodes.set(node.id, node)
  }
  return nodes
}

function z_issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}

function loadDocs(): Map<string, Doc> {
  const docs = new Map<string, Doc>()
  for (const [path, source] of Object.entries(docModules)) {
    const { frontmatter, body } = splitFrontmatter(source)
    const parsed = DocFrontmatter.safeParse(frontmatter)
    if (!parsed.success) {
      throw new Error(`${path}: frontmatter のスキーマ違反\n${z_issues(parsed.error)}`)
    }
    docs.set(parsed.data.id, { id: parsed.data.id, body })
  }
  return docs
}

export const nodes: ReadonlyMap<string, GraphNode> = loadNodes()
export const docs: ReadonlyMap<string, Doc> = loadDocs()

/** `kind: sutra` のノード。グラフの根 */
export const root: GraphNode = (() => {
  const roots = [...nodes.values()].filter((n) => n.kind === 'sutra')
  if (roots.length !== 1) {
    throw new Error(`kind: sutra のノードはちょうど 1 つであること（現在 ${roots.length} 件）`)
  }
  return roots[0]!
})()

export function nodeById(id: string): GraphNode | undefined {
  return nodes.get(id)
}

export function docById(id: string): Doc | undefined {
  return docs.get(id)
}

export function childrenOf(node: GraphNode): GraphNode[] {
  return node.children.flatMap((id) => {
    const child = nodes.get(id)
    return child ? [child] : []
  })
}

/**
 * 隣接の表。**向きを持たない関係**なので、YAML の片側の記述から両向きを張る。
 * 両側に手書きさせると必ず片方が腐るため、対称化はここ 1 箇所で行う。
 *
 * エッジは 2 つの書き方から作る。
 *   - `related: [...]`   … 同じ層の語どうしの横の線
 *   - `anchor: <id>`     … 隣接ノードとその帰属先。帰属は同時に 1 本の隣接でもある
 *
 * 並びは「自分の `related` に書いた順 → `anchor` → 他ノードから張られた順」で、
 * ファイル名順に読むので毎回同じになる（散らし配置の乱数の種にも使うので順序が要る）。
 */
const adjacency: ReadonlyMap<string, readonly string[]> = (() => {
  const table = new Map<string, string[]>()
  const link = (from: string, to: string) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return
    const list = table.get(from) ?? []
    if (!list.includes(to)) list.push(to)
    table.set(from, list)
  }
  for (const node of [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const id of node.related) {
      link(node.id, id)
      link(id, node.id)
    }
    if (node.anchor) {
      link(node.id, node.anchor)
      link(node.anchor, node.id)
    }
  }
  return table
})()

/**
 * このノードを帰属先（`anchor`）にしている隣接ノード。**向きを持つ片側だけ**を返す。
 *
 * `relatedOf` は対称化した表を引くので、他の枝の語まで混ざる。
 * 「この層を見終えたか」を測るには、その層に属すると宣言した語だけが要る。
 */
export function anchoredOf(node: GraphNode): GraphNode[] {
  return [...nodes.values()]
    .filter((n) => n.anchor === node.id)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 関連語句として並べる隣接ノード。木の子は含まない */
export function relatedOf(node: GraphNode): GraphNode[] {
  return (adjacency.get(node.id) ?? []).flatMap((id) => {
    const found = nodes.get(id)
    return found ? [found] : []
  })
}

/**
 * 全文の文字インデックス → その字が属する句（根の子）の id。範囲外の字は null。
 *
 * L0 で触れられるのは根の子だけなので、その `range` を展開して 1 本の表にしておく。
 * hover の判定と、遷移で「どの字が次の見出しへ持ち越されるか」の判定が同じ表を引く。
 * 同じ字が紙面に何度現れても、持ち越されるのは選んだ句の位置にある字だけになる。
 */
export const SUTRA_INDEX_TO_NODE: readonly (string | null)[] = (() => {
  const table: (string | null)[] = new Array(SUTRA_LENGTH).fill(null)
  for (const child of childrenOf(root)) {
    if (!child.range) continue
    const [start, end] = child.range
    for (let i = start; i < end && i < table.length; i++) table[i] = child.id
  }
  return table
})()

/**
 * 全文の文字インデックス → その字を大書へ持ち越す独立ページの id（`kind: page` の `range`）。
 *
 * **所有ではない。** 紙面での hover・入口・読破はどれも `SUTRA_INDEX_TO_NODE`（根の子＝句）が
 * 決めており、この表はそこに一切触らない。ここが決めるのは遷移で持ち越される字だけで、
 * `深般若` は経文の語のまとまりではない（`深` は `行` に掛かる）以上、
 * 紙面で「一続きの語」として見せてはいけない —— 動きは文法の主張ではないので、
 * リンクから出入りする一度きりの運動としてだけ使う。
 */
export const SUTRA_INDEX_TO_PAGE: readonly (string | null)[] = (() => {
  const table: (string | null)[] = new Array(SUTRA_LENGTH).fill(null)
  for (const node of nodes.values()) {
    if (node.kind !== 'page' || !node.range) continue
    const [start, end] = node.range
    for (let i = start; i < end && i < table.length; i++) table[i] = node.id
  }
  return table
})()

/**
 * 大書の中の入口。`labelText(node.label)` と同じ順・同じ長さで、その字から潜れる子の id を返す
 * （どの子にも属さない字は null）。
 *
 * **子の関係図を持たないノード（`layout: none`）だけが持つ。** 図があるノードでは子は図の中に
 * 出ているので、大書にも入口を作ると同じ子への口が 2 つでき、持ち越しの対応づけも二重になる。
 *
 * 判定は `range` の内包で行う。L0 の紙面で句の範囲だけが光るのと同じ規則を大書へ持ち込んだもので、
 * 表の引き方（`SUTRA_INDEX_TO_NODE`）も揃えてある。hover の判定と、遷移で「どの字が次の大書へ
 * 持ち越されるか」の判定が同じ表を引く。
 */
export function headlineChildOwners(node: GraphNode): (string | null)[] {
  const chars = Array.from(labelText(node.label))
  const owners: (string | null)[] = new Array(chars.length).fill(null)
  if (node.layout !== 'none' || !node.range) return owners

  const [start, end] = node.range
  // 根の range は全文を指し、label は大書用の題名なので字数が合わない。入口は出さない
  if (end - start !== chars.length) return owners

  for (const child of childrenOf(node)) {
    if (!child.range) continue
    const [from, to] = child.range
    for (let i = Math.max(from, start); i < Math.min(to, end); i++) owners[i - start] = child.id
  }
  return owners
}

/**
 * 根から `node` までの経路。現在位置インジケータとルーティングが使う。
 *
 * 隣接ノードは木の子ではないが、URL にも現在位置にも出す必要があるので
 * `anchor` を親の代わりに辿る。**深度そのものは増えたことにならない**（帰属先と同じ層に居る）
 * が、経路としては 1 つ深い位置に並ぶ。原稿の水準はアンカーに合わせる（→ skill: doc-writing）。
 */
export function ancestryOf(node: GraphNode): GraphNode[] {
  // 独立ページ（`kind: page`）は木の外に居るが、URL（`/about/`）も現在位置も
  // 「根の隣に開いた 1 枚」として扱う。ここで根に繋ぐことで、戻り先と深度が他と同じ規則に乗る
  if (node.kind === 'page') return [root, node]

  const path: GraphNode[] = [node]
  const seen = new Set([node.id])
  let current = node
  while (current.parent ?? current.anchor) {
    const parent = nodes.get((current.parent ?? current.anchor)!)
    if (!parent || seen.has(parent.id)) break // 循環は validate-graph が落とす
    path.unshift(parent)
    seen.add(parent.id)
    current = parent
  }
  return path
}

/**
 * ランタイム側の軽い整合性チェック。
 * 網羅的な検査は scripts/validate-graph.ts が持つ。ここは開発中の早期発見用。
 */
if (process.env.NODE_ENV === 'development') {
  for (const node of nodes.values()) {
    // 根の range は全文を指し、label は大書用の題名なので突き合わせない
    if (node.kind !== 'sutra' && node.range && sliceOfRange(node.range) !== labelText(node.label)) {
      console.warn(
        `[content] ${node.id}: range ${JSON.stringify(node.range)} が label "${node.label}" と一致しない ` +
          `(実際: "${sliceOfRange(node.range)}")`,
      )
    }
    if (!docs.has(node.id)) console.warn(`[content] ${node.id}: docs/${node.id}.md が無い`)
  }
  console.info(`[content] ${nodes.size} ノード / 全文 ${SUTRA_CHARS.length} 字を読み込んだ`)
}
