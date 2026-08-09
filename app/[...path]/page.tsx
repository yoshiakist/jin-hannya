import type { Metadata } from 'next'
import { root, nodes, nodeById, ancestryOf } from '../../src/content/loader.ts'
import { labelText } from '../../src/content/schema.ts'

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

  const title = `${labelText(node.label)}（${labelText(node.reading)}） — 深般若`
  return {
    title,
    description: node.summary,
    openGraph: { title, description: node.summary, type: 'article' },
  }
}

/** L1 以深のノード。本体は layout の AppShell が描く。この page は metadata だけを担う */
export default function Page() {
  return null
}
