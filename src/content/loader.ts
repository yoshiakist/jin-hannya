/**
 * `content/graph/*.yaml` と `content/docs/*.md` を読み込み、zod で検証してグラフを組む。
 *
 * YAML は vite.config.ts の yamlPlugin がビルド時に JSON へ変換済み。
 * ここでの zod 検証は「型を信じるための最後の関門」であり、
 * 参照整合性など横断的な検査は scripts/validate-graph.ts が CI で行う。
 */

import { GraphNode, DocFrontmatter } from './schema.ts'
import { SUTRA_CHARS, sliceOfRange } from './sutra.ts'

const yamlModules = import.meta.glob<{ default: unknown }>('#content/graph/*.yaml', {
  eager: true,
})
const docModules = import.meta.glob<string>('#content/docs/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

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
  for (const [path, module] of Object.entries(yamlModules)) {
    const parsed = GraphNode.safeParse(module.default)
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

/** 根から `node` までの経路。現在位置インジケータとルーティングが使う */
export function ancestryOf(node: GraphNode): GraphNode[] {
  const path: GraphNode[] = [node]
  const seen = new Set([node.id])
  let current = node
  while (current.parent) {
    const parent = nodes.get(current.parent)
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
if (import.meta.env.DEV) {
  for (const node of nodes.values()) {
    // 根の range は全文を指し、label は大書用の題名なので突き合わせない
    if (node.kind !== 'sutra' && node.range && sliceOfRange(node.range) !== node.label) {
      console.warn(
        `[content] ${node.id}: range ${JSON.stringify(node.range)} が label "${node.label}" と一致しない ` +
          `(実際: "${sliceOfRange(node.range)}")`,
      )
    }
    if (!docs.has(node.id)) console.warn(`[content] ${node.id}: docs/${node.id}.md が無い`)
  }
  console.info(`[content] ${nodes.size} ノード / 全文 ${SUTRA_CHARS.length} 字を読み込んだ`)
}
