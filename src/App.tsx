import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Stage } from './scene/Stage.tsx'
import { Overlay } from './overlay/Overlay.tsx'
import { PaperFallback } from './overlay/PaperFallback.tsx'
import { useRouteSync } from './nav/router.ts'
import {
  tierAtom,
  phaseAtom,
  isRootAtom,
  audioStartedAtom,
  bgmVolumeAtom,
  mutedAtom,
  currentNodeAtom,
  markVisitedAtom,
  splashAtom,
} from './nav/atoms.ts'
import { usePanZoomGesture, useNodePanSpring, panXAtom, panBoundsAtom } from './world/pan.ts'
import { VIEW_HEIGHT } from './world/paper.ts'
import { startAudio, playWoosh } from './audio/index.ts'

export function App() {
  const tier = useAtomValue(tierAtom)
  const phase = useAtomValue(phaseAtom)
  const isRoot = useAtomValue(isRootAtom)
  const panX = useAtomValue(panXAtom)
  const bounds = useAtomValue(panBoundsAtom)
  // ロゴを書いているあいだ、面は暗闇のまま（`splashing`）。薄れ始めた時点でオーバーレイは
  // 経文と同じ時間をかけて現れるが、**紙面のクリックはロゴが畳まれるまで通さない**（`closed`）。
  // 薄れかけのロゴ越しに潜られると、書き上げたばかりの字がそのまま散る（→ src/scene/Splash.tsx）
  const splash = useAtomValue(splashAtom)
  const splashing = splash === 'writing'
  const closed = splash !== 'done'
  const containerRef = useRef<HTMLDivElement>(null)

  useRouteSync()
  useAutoStartAudio(containerRef)
  useWooshOnTransition(phase)
  useVisitLog()

  // Tier 3 の紙面は DOM の段組みなので拡大に追従できない。そこではパンだけを許す。
  // L1 以降（node）は拡大を持たず、左右のパンだけが効く
  usePanZoomGesture(containerRef, isRoot ? 'paper' : 'node', tier !== 3)
  // L1 以降のパンのばね。GPU レイヤーと DOM が同じ値を読むよう、補間は atom 側で 1 度だけ掛ける
  useNodePanSpring()

  return (
    <div
      ref={containerRef}
      className={`app tier-${tier} phase-${phase}${splashing ? ' splashing' : ''}${closed ? ' splash-closed' : ''}`}
      // WebGPU レイヤーと DOM レイヤーが同じ変換を読むことで両者が同期する。
      // カメラの x をピクセルへ直したものを CSS 変数に流し、Tier 3 の紙面もこれで動く
      style={
        {
          '--pan-px': `${((bounds.max - panX) * (globalThis.innerHeight || 0)) / VIEW_HEIGHT}px`,
        } as React.CSSProperties
      }
    >
      {tier === 3 ? isRoot && <PaperFallback /> : <Stage />}
      <Overlay />
    </div>
  )
}

/**
 * 開いた時点で音を始める。自動再生が許されていない環境ではここで弾かれるので、
 * そのときだけ最初のクリック／タップ／キー入力を待って始め直す。
 */
function useAutoStartAudio(target: React.RefObject<HTMLElement | null>): void {
  const setStarted = useSetAtom(audioStartedAtom)
  const volume = useAtomValue(bgmVolumeAtom)
  const muted = useAtomValue(mutedAtom)
  const settingsRef = useRef({ volume, muted })
  settingsRef.current = { volume, muted }

  useEffect(() => {
    const element = target.current
    if (!element) return
    let disposed = false

    const attempt = async () => {
      const { volume, muted } = settingsRef.current
      const ok = await startAudio(volume, muted)
      if (ok && !disposed) {
        setStarted(true)
        detach()
      }
      return ok
    }
    const onGesture = () => void attempt()
    const detach = () => {
      element.removeEventListener('pointerdown', onGesture)
      element.removeEventListener('keydown', onGesture)
    }

    // まず無条件に試す。弾かれた場合だけ操作待ちに落とす
    element.addEventListener('pointerdown', onGesture)
    element.addEventListener('keydown', onGesture)
    void attempt()

    return () => {
      disposed = true
      detach()
    }
  }, [target, setStarted])
}

/**
 * 読破の記録。演出が終わって面が落ち着いたところ（`idle`）で、いま出ているノードを訪問済みにする。
 * 遷移中に書くと、途中で引き返した行き先まで訪れたことになる。
 */
function useVisitLog(): void {
  const phase = useAtomValue(phaseAtom)
  const current = useAtomValue(currentNodeAtom)
  const mark = useSetAtom(markVisitedAtom)

  useEffect(() => {
    if (phase !== 'idle') return
    mark(current.id)
  }, [phase, current, mark])
}

/** ズーム遷移に woosh を重ねる。BGM は止めない */
function useWooshOnTransition(phase: string): void {
  useEffect(() => {
    if (phase === 'zooming-in' || phase === 'zooming-out') playWoosh()
  }, [phase])
}
