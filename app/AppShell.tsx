'use client'

import dynamic from 'next/dynamic'

/**
 * three/webgpu と Web Audio はブラウザ専用なので、ビルド時のプリレンダから外す。
 * SEO に要るのは各 page の metadata（と、マウント後に DOM レイヤーへ出る本文）で足りる。
 */
const App = dynamic(() => import('../src/App.tsx').then((m) => m.App), { ssr: false })

export function AppShell() {
  return <App />
}
