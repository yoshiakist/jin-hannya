import type { Metadata } from 'next'
import { root, nodes, nodeById, ancestryOf } from '../../src/content/loader.ts'
import { labelText } from '../../src/content/schema.ts'
import { StaticDoc } from '../StaticDoc.tsx'

/** 全ノードのパスをビルド時に列挙する。範囲外は 404（ハッシュ時代の「根へ倒す」はやめ、標準に寄せる） */
export const dynamicParams = false

export function generateStaticParams(): { path: string[] }[] {
  return [...nodes.values()]
    .filter((node) => node.id !== root.id)
    .map((node) => ({
      path: ancestryOf(node)
        .filter((n) => n.id !== root.id)
        .map((n) => n.id),
    }))
}

interface Props {
  params: Promise<{ path: string[] }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { path } = await params
  const node = nodeById(path[path.length - 1] ?? '')
  if (!node) return {}

  // 独立ページ（`kind: page`）の大書はサイト名そのものなので、読みを添えると題が二重になる
  const title =
    node.kind === 'page'
      ? `${labelText(node.label)}について`
      : `${labelText(node.label)}（${labelText(node.reading)}） — 深般若`
  return {
    title,
    description: node.summary,
    openGraph: { title, description: node.summary, type: 'article' },
  }
}

/**
 * L1 以深のノード。絵と操作は layout の AppShell が描く。
 * page が持つのは metadata と、GPU レイヤーの写しである隠し文書（大書・行き先）だけ。
 */
export default async function Page({ params }: Props) {
  const { path } = await params
  const node = nodeById(path[path.length - 1] ?? '')
  return node ? <StaticDoc node={node} /> : null
}
