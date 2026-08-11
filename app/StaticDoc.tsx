/**
 * 記事の見出しと、GPU レイヤーにしか無い字。
 *
 * 画面の主役（紙面の全文・大書）は WebGPU レイヤーが描くので DOM には 1 字も無く、
 * オーバーレイが持つのは読み・サマリー・本文だけだった。肝心の**見出し語と経文**が
 * 読み上げにも索引にも渡らないので、ここで隠しテキストとして出す。
 *
 * 役割分担: **ここは GPU レイヤーの写し**（見出し語・経文・行き先）で、
 * 読み・サマリー・本文は `overlay/Overlay.tsx` が可視の DOM として既に出している。
 * 同じ字を二重に読ませないため、ここではそれらを持たない。
 * 両者は `app/layout.tsx` の `<main><article>` が 1 つの記事として包む
 * （h1 = 大書 → 可視の読み・サマリー・本文、という並びになる）。
 *
 * 全ルート SSG なので、これは各パスの静的 HTML にそのまま焼かれる。
 * クライアント遷移でも page が差し替わるため、潜っても見出しは現在のノードに追従する。
 */

import Link from 'next/link'
import { childrenOf, relatedOf, ancestryOf, nodeById, root } from '../src/content/loader.ts'
import { ABOUT_ID } from '../src/nav/about.ts'
import { SUTRA_LINES } from '../src/content/sutra.ts'
import { labelText, type GraphNode } from '../src/content/schema.ts'
import { pathOf } from '../src/nav/url.ts'

export function StaticDoc({ node }: { node: GraphNode }) {
  const isRoot = node.id === root.id
  const children = childrenOf(node)
  const related = relatedOf(node)
  const ancestry = ancestryOf(node).slice(0, -1)
  const about = nodeById(ABOUT_ID)

  return (
    <div className="visually-hidden">
      {/* 見出し語 = 大書。読みは括弧で添える（オーバーレイの読みは筆文字ではなく素の DOM
          なので既に読み上がるが、見出しだけで意味が取れるようここにも置く） */}
      <h1>
        {labelText(node.label)}（{labelText(node.reading)}）
      </h1>
      {node.sanskrit && (
        <p>
          梵語 <span lang="sa-Latn">{node.sanskrit.text}</span>（{node.sanskrit.kana}）
        </p>
      )}

      {isRoot && (
        <section aria-labelledby="static-doc-sutra">
          <h2 id="static-doc-sutra">経文全文</h2>
          {/* 1 行 = 紙面の 1 列（content/sutra.txt の改行）。格子は視覚の都合なので
              読み上げでは行の並びとしてそのまま渡す */}
          {SUTRA_LINES.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </section>
      )}

      {/* L0 の左上に据えたリンク（`overlay/AboutLink.tsx`）は ssr:false のオーバーレイの中に
          あり、静的 HTML には焼かれない。クローラと読み上げのために行き先だけをここに置く */}
      {isRoot && about && <NodeLinks label="サイト情報" nodes={[about]} />}

      <NodeLinks label="上の階層" nodes={ancestry} />
      <NodeLinks label={isRoot ? '句の一覧' : '構成要素'} nodes={children} />
      <NodeLinks label="関連語句" nodes={related} />
    </div>
  )
}

/**
 * 行き先の一覧。クローラの辿る線であり、読み上げでの目次でもある。
 *
 * `tabIndex={-1}` を付けるのは、この文書が視覚的に隠れているため。Tab で回ってくると
 * 見えない所へフォーカスが落ちる。スクリーンリーダーの読み上げカーソルからは通常どおり
 * 辿れるので、隠れた行き先が失われるわけではない。
 */
function NodeLinks({ label, nodes }: { label: string; nodes: GraphNode[] }) {
  if (nodes.length === 0) return null
  return (
    <nav aria-label={label}>
      <ul>
        {nodes.map((node) => (
          <li key={node.id}>
            <Link href={pathOf(node.id)} tabIndex={-1}>
              {labelText(node.label)}（{labelText(node.reading)}）
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
