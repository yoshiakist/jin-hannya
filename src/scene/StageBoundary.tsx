/**
 * WebGPU レイヤーの受け皿。
 *
 * 描画の途中で投げられた例外（グリフの索引と bin の食い違い、シェーダのコンパイル失敗など）を
 * ここで止め、DOM の紙面（PaperFallback）へ落とす。境界が無いと React はツリーごと畳むので、
 * 経文もオーバーレイも消えて真っ黒の画面だけが残る。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  onFail: () => void
  children: ReactNode
}

export class StageBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
    this.props.onFail()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
