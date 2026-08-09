import type { NextConfig } from 'next'

const config: NextConfig = {
  /** SSR は使わない。全ノードのパスをビルド時に吐く静的ホスティング前提（README） */
  output: 'export',
  /** 静的ホストで `/goun/` → `goun/index.html` と素直に対応させる */
  trailingSlash: true,
  reactStrictMode: true,
  /** 左下の Next アイコン + レンダリングインジケータ（dev 専用）を出さない。画面の一部に見えてしまう */
  devIndicators: false,
}

export default config
