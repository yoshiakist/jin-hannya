import type { Metadata, Viewport } from 'next'
import { AppShell } from './AppShell.tsx'
import '../src/styles.css'

export const metadata: Metadata = {
  title: '深般若',
  description: '般若心経を文字・句・語・構成要素へと潜っていく、グラフィカルな訳文兼辞書',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

/**
 * アプリ本体（Canvas + オーバーレイ）は layout に置いて全ルートで永続させる。
 * page 側に置くと遷移のたびに再マウントされ、紙面 90 字ぶんの用意を払い直して固まる
 * （CLAUDE.md「面の用意をやり直さない」）。各 page は metadata を出すだけの空要素。
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/*
          1 つのノード = 1 つの記事。見出し語・経文・行き先（page = StaticDoc。GPU レイヤーに
          しか無いので隠しテキスト）と、読み・サマリー・本文（AppShell の中の DOM オーバーレイ）が
          同じ `<article>` に入る。別々の入れ物にすると、可視の本文が見出しを持たない浮いた
          断片になってしまう。
          `.app` は position: fixed、隠しテキストは position: absolute なので、
          包んでも流し込みには何も起きない（見た目は変わらない）。
        */}
        <main>
          <article>
            {children}
            <AppShell />
          </article>
        </main>
      </body>
    </html>
  )
}
