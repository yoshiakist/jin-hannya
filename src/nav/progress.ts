/**
 * 読破の記録。
 *
 * 訪れたノードの id だけを localStorage に持ち、「読破した（＝その語はもう下りた）」かどうかは
 * **深さ**で決める。
 *
 *   読破(node) = 配下のどこか一本でも `READ_DEPTH` の深さまで訪れている
 *   ただし配下がそこまで伸びていない語では、その枝の最深に丸める
 *
 * 配下を全部舐めさせない。グラフは長大になる前提なので、全域読破は誰も達成しない目標になる。
 * 深さで測れば「一本でも底まで下りた」で青くなり、紙面ぜんたいを青くする張り合いが残る。
 *
 * 丸めがあるので YAML に鍵は要らない。般若心経のように子を持たない語は L1 に着いた時点で読破、
 * 摩訶般若波羅蜜多心経のように L2 で尽きる語は L2 で読破、五蘊のように深い枝は L3 で読破になる。
 * 深さの違いは既にグラフが持っていて、二重に書けば必ず片方が腐る。
 *
 * 深度の数え方は README と同じ（根 = L0、その子 = L1）。**隣接ノード（`anchor`）は深度を増やさない**
 * ので、帰属先と同じ深さの語として数える。
 */

import { nodes, childrenOf, anchoredOf } from '../content/loader.ts'
import type { GraphNode } from '../content/schema.ts'

const STORAGE_KEY = 'jin-hannya:visited:v1'

/**
 * ここまで下りたら読破とみなす深度。L3（例: 五蘊）。
 * 上げるほど紙面が青くなりにくくなる。1 箇所で決める。
 */
export const READ_DEPTH = 3

/**
 * 訪問済み id の読み書き。localStorage はプライベートモードや容量超過で必ず投げうるので、
 * 失敗しても本編は動き続ける（記録が残らないだけ）ようにする。
 */
export function loadVisited(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    // 消えた id が残っていても判定を狂わせないよう、いま在るノードだけに絞る
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && nodes.has(id)))
  } catch {
    return new Set()
  }
}

export function saveVisited(visited: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...visited].sort()))
  } catch {
    // 記録できない環境では黙って諦める。表示は今回のセッションぶんだけ生きる
  }
}

/**
 * ノード id → 深度（根 = 0）。
 * `anchor` は親ではないので深さを足さない（帰属先と同じ層に居る）。循環は 0 で打ち切る。
 */
const DEPTHS: ReadonlyMap<string, number> = (() => {
  const depths = new Map<string, number>()
  const walking = new Set<string>()

  const depthOf = (node: GraphNode): number => {
    const cached = depths.get(node.id)
    if (cached !== undefined) return cached
    if (walking.has(node.id)) return 0
    walking.add(node.id)
    const parent = node.parent ? nodes.get(node.parent) : null
    const anchor = node.anchor ? nodes.get(node.anchor) : null
    // 木の親なら 1 つ深く、帰属先なら同じ深さ
    const depth = parent ? depthOf(parent) + 1 : anchor ? depthOf(anchor) : 0
    walking.delete(node.id)
    depths.set(node.id, depth)
    return depth
  }

  for (const node of nodes.values()) depthOf(node)
  return depths
})()

export function depthOf(id: string): number {
  return DEPTHS.get(id) ?? 0
}

/**
 * このノードに属するもの（自分・木の子孫・帰属する隣接語）を辿る。
 * 隣接語は深さを持ち込まないが、訪問の記録としては数える。
 */
function membersOf(node: GraphNode): GraphNode[] {
  const out: GraphNode[] = []
  const seen = new Set<string>()
  const walk = (current: GraphNode) => {
    if (seen.has(current.id)) return
    seen.add(current.id)
    out.push(current)
    for (const child of childrenOf(current)) walk(child)
    for (const other of anchoredOf(current)) walk(other)
  }
  walk(node)
  return out
}

/** この語で到達しうる最も深い深度。枝が浅ければ `READ_DEPTH` より小さくなる */
function reachableDepth(node: GraphNode): number {
  return membersOf(node).reduce((max, member) => Math.max(max, depthOf(member.id)), depthOf(node.id))
}

/** この語を読破と認めるのに要る深度。規定の深さと、枝が実際に持つ深さの浅いほう */
export function requiredDepth(node: GraphNode): number {
  return Math.min(READ_DEPTH, reachableDepth(node))
}

/**
 * 訪問済みの集合から、読破した id の集合を導く。
 * ノードは高々数百なので毎回全部を畳んでよい。
 */
export function completedIds(visited: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const node of nodes.values()) {
    const reached = membersOf(node).reduce(
      (max, member) => (visited.has(member.id) ? Math.max(max, depthOf(member.id)) : max),
      -1,
    )
    if (reached >= requiredDepth(node)) out.add(node.id)
  }
  return out
}

/**
 * 読破までの進み具合（0〜1）。いまは表示に使っていないが、記録の中身を読むときの窓口。
 * 「いちばん深く下りた深さ ÷ 要る深さ」で、その語のどこまで潜ったかを表す。
 */
export function progressOf(node: GraphNode, visited: ReadonlySet<string>): number {
  const required = requiredDepth(node)
  if (required <= 0) return 1
  const reached = membersOf(node).reduce(
    (max, member) => (visited.has(member.id) ? Math.max(max, depthOf(member.id)) : max),
    0,
  )
  return Math.min(1, Math.max(0, reached / required))
}
