/**
 * コンテンツの静的検証。CI で落とすべき条件は README「ビルド時検証」に列挙されている。
 *
 * ランタイムのローダ（src/content/loader.ts）は個々のノードのスキーマしか見ない。
 * 横断的な整合性（参照切れ・親子の非対称・range の内包関係・グリフの在庫）はここで見る。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { GraphNode, labelText } from '../src/content/schema.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GRAPH_DIR = join(ROOT, 'content/graph')
const DOCS_DIR = join(ROOT, 'content/docs')
const SUTRA_PATH = join(ROOT, 'content/sutra.txt')
const SVG_DIR = join(ROOT, 'assets/svg')

const errors: string[] = []
const warnings: string[] = []
const fail = (message: string) => errors.push(message)
const warn = (message: string) => warnings.push(message)

// --- 全文 -------------------------------------------------------------------

const rawSutra = readFileSync(SUTRA_PATH, 'utf8')
/** src/content/sutra.ts と同じ正規化。空白類をすべて落としたものがインデックスの基準 */
const sutra = Array.from(rawSutra.replace(/\s+/gu, ''))

const glyphs = new Set(
  readdirSync(SVG_DIR)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => basename(f, '.svg'))
    // `<字>_path.svg` は塗りではなく筆順の中心線。字の在庫としては数えない
    .filter((key) => !key.endsWith('_path')),
)

// 改行は L0 の列の切れ目（1 行 = 1 列）、行内の全角スペースは 1 升ぶんの空き。
// それ以外の空白は黙って落ちるので知らせる
{
  const lines = rawSutra.split(/\r?\n/u).filter((l) => l.trim().length > 0)
  const spaced = lines.filter((l) => /[^\S　]/u.test(l.trim())).length
  if (spaced > 0) {
    warn(
      `content/sutra.txt の ${spaced} 行に全角スペース以外の空白がある。` +
        'ローダは除去するため range はずれないが、その空白ぶんの升は空かずに詰まる',
    )
  }
  // 全角スペースも 1 升を占めるので、折り返しの判定では字と同じに数える
  const over = lines.filter((l) => Array.from(l.replace(/[^\S　]+/gu, '')).length > 16).length
  if (over > 0) {
    warn(`content/sutra.txt に 16 字を超える行が ${over} 行ある。超えたぶんは次の列へ折り返して描かれる`)
  }
}

{
  const missing = [...new Set(sutra)].filter((c) => !glyphs.has(c))
  if (missing.length > 0) {
    fail(
      `content/sutra.txt に assets/svg/ の無い文字がある: ${missing.join(' ')}\n` +
        `    （対応する ${missing.map((c) => `${c}.svg`).join(' / ')} を追加するか、在庫のある異体字へ寄せる）`,
    )
  }
}

// --- ノード -----------------------------------------------------------------

const nodes = new Map<string, GraphNode>()

for (const file of readdirSync(GRAPH_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const parsed = GraphNode.safeParse(parseYaml(readFileSync(join(GRAPH_DIR, file), 'utf8')))
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      fail(`content/graph/${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
    continue
  }
  const node = parsed.data
  if (nodes.has(node.id)) fail(`content/graph/${file}: id "${node.id}" が重複している`)
  if (basename(file).replace(/\.ya?ml$/, '') !== node.id) {
    warn(`content/graph/${file}: ファイル名と id "${node.id}" が一致しない`)
  }
  nodes.set(node.id, node)
}

const roots = [...nodes.values()].filter((n) => n.kind === 'sutra')
if (roots.length !== 1) fail(`kind: sutra のノードはちょうど 1 つであること（現在 ${roots.length} 件）`)

for (const node of nodes.values()) {
  const at = `${node.id}`

  // 参照切れ
  for (const [field, ids] of [
    ['parent', node.parent ? [node.parent] : []],
    ['anchor', node.anchor ? [node.anchor] : []],
    ['children', node.children],
    ['related', node.related],
  ] as const) {
    for (const id of ids) {
      if (!nodes.has(id)) fail(`${at}: ${field} が存在しないノード "${id}" を参照している`)
    }
  }

  // 隣接（anchor / related）。向きを持たない関係なので片側にだけ書く。
  // 対称化はローダが行うため、ここでは「両側に書いてある」ことは咎めず、
  // **包含と隣接が同じ 2 ノードに二重に張られること**だけを落とす（関係の種類が曖昧になる）
  if (node.related.includes(node.id)) fail(`${at}: related が自分自身を含んでいる`)
  if (node.anchor === node.id) fail(`${at}: anchor が自分自身を指している`)
  for (const id of node.related) {
    const kin = id === node.parent || node.children.includes(id) || id === node.anchor
    if (kin) fail(`${at}: "${id}" と包含（parent/children/anchor）と related の両方で結ばれている`)
    const other = nodes.get(id)
    if (other && (other.parent === node.id || other.children.includes(node.id))) {
      fail(`${at}: "${id}" とは親子なので related には書かない（関連語句は包含でない関係だけ）`)
    }
  }
  // 隣接ノードは経文に現れない概念語なので range を持たない。持つなら木の子であるはず
  if (node.anchor && node.range) {
    fail(`${at}: anchor 持ちなのに range がある（経文に現れる語は木の子として置く）`)
  }

  // 親子関係の非対称
  if (node.parent) {
    const parent = nodes.get(node.parent)
    if (parent && !parent.children.includes(node.id)) {
      fail(`${at}: parent は "${parent.id}" だが、"${parent.id}".children に含まれていない`)
    }
  }
  for (const childId of node.children) {
    const child = nodes.get(childId)
    if (child && child.parent !== node.id) {
      fail(`${at}: children に "${childId}" があるが、"${childId}".parent が "${node.id}" でない`)
    }
  }

  // layout と children の整合。
  // layout が支配するのは「子の関係図」であって遷移そのものではない。
  // 句どうしの下降（sutra / phrase）は図を伴わないので none のまま子を持ってよい。
  // 一方、語（term）が layout: none で子を持つのは、子を出す場所が無いという矛盾になる。
  if (node.layout === 'none' && node.children.length > 0 && node.kind === 'term') {
    fail(`${at}: kind: term かつ layout: none なのに children を ${node.children.length} 件持つ（子を描く場所が無い）`)
  }
  if (node.layout !== 'none' && node.children.length === 0) {
    fail(`${at}: layout: ${node.layout} だが children が空。配置する子が無い`)
  }
  // 図を持たないノードの入口は大書そのもの（`headlineChildOwners`）。子が range を持たないと
  // 大書のどの字にも当たらず、その子へ潜る手立てが無くなる。根だけは L0 の紙面が入口になる
  if (node.layout === 'none' && node.kind !== 'sutra') {
    for (const childId of node.children) {
      if (!nodes.get(childId)?.range) {
        fail(`${at}: layout: none なので大書の中が入口になるが、子 "${childId}" が range を持たない（潜れない）`)
      }
    }
  }

  // 解説
  if (!existsSync(join(DOCS_DIR, `${node.id}.md`))) fail(`${at}: content/docs/${node.id}.md が無い`)

  // グリフ在庫
  for (const char of new Set(Array.from(labelText(node.label)))) {
    if (!glyphs.has(char)) fail(`${at}: label の "${char}" に対応する assets/svg/${char}.svg が無い`)
  }

  // 読み上げ音源（未収録は警告）
  if (node.audio && !existsSync(join(ROOT, 'assets/voice', node.audio))) {
    warn(`${at}: audio "${node.audio}" が assets/voice/ に無い（未収録なら audio を外す）`)
  }

  // range
  if (node.range) {
    const [start, end] = node.range
    if (end > sutra.length) {
      fail(`${at}: range [${start}, ${end}) が全文長 ${sutra.length} を超えている`)
    } else if (node.kind !== 'sutra') {
      // 根は range: [0, 全文長] を持つが、label は大書用の短い題名であって全文ではない
      const actual = sutra.slice(start, end).join('')
      // label の `/` は大書の列の切れ目。突き合わせは字だけで見る
      if (actual !== labelText(node.label)) {
        fail(`${at}: range [${start}, ${end}) は "${actual}" を指すが label は "${node.label}"`)
      }
    }
    if (node.parent) {
      const parentRange = nodes.get(node.parent)?.range
      if (parentRange && (start < parentRange[0] || end > parentRange[1])) {
        fail(
          `${at}: range [${start}, ${end}) が親 "${node.parent}" の [${parentRange[0]}, ${parentRange[1]}) に内包されていない`,
        )
      }
    }
  } else if (node.kind === 'phrase') {
    fail(`${at}: kind: phrase は range が必須`)
  }
}

// 到達不能な孤立ノード。
// 隣接ノードは木の子として辿れないので、anchor を持つノードを帰属先から辿れる辺として足す
// （related だけで繋がったノードは、どの層にも属さないので孤立とみなす）
if (roots.length === 1) {
  const anchored = new Map<string, string[]>()
  for (const node of nodes.values()) {
    if (!node.anchor) continue
    anchored.set(node.anchor, [...(anchored.get(node.anchor) ?? []), node.id])
  }
  const reachable = new Set<string>()
  const stack = [roots[0]!.id]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const child of nodes.get(id)?.children ?? []) stack.push(child)
    for (const satellite of anchored.get(id) ?? []) stack.push(satellite)
  }
  for (const id of nodes.keys()) {
    if (!reachable.has(id)) fail(`${id}: 根から到達できない孤立ノード`)
  }
}

// 未参照の docs
for (const file of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) {
  const id = basename(file, '.md')
  if (!nodes.has(id)) warn(`content/docs/${file}: 対応するノード "${id}" が無い`)
}

// --- 結果 -------------------------------------------------------------------

for (const w of warnings) console.warn(`warn  ${w}`)
for (const e of errors) console.error(`error ${e}`)

console.log(
  `\n${nodes.size} ノード / 全文 ${sutra.length} 字 / グリフ ${glyphs.size} 字 — ` +
    `エラー ${errors.length} 件、警告 ${warnings.length} 件`,
)
if (errors.length > 0) process.exit(1)
