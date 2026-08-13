import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Stage } from './scene/Stage.tsx'
import { StageBoundary } from './scene/StageBoundary.tsx'
import { Overlay } from './overlay/Overlay.tsx'
import { AudioConsent } from './overlay/AudioConsent.tsx'
import { PaperFallback } from './overlay/PaperFallback.tsx'
import { useRouteSync } from './nav/router.ts'
import {
  tierAtom,
  phaseAtom,
  isRootAtom,
  audioStartedAtom,
  volumeAtom,
  mutedAtom,
  currentNodeAtom,
  markVisitedAtom,
  splashAtom,
  audioConsentAtom,
  stageFailedAtom,
  failStageAtom,
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
  // ロゴを書いているあいだと、音の断りに答えを待つあいだ、面は暗闇のまま（`splashing`）。
  // ロゴが薄れ始めた時点でオーバーレイは経文と同じ時間をかけて現れるが、
  // **紙面のクリックはロゴが畳まれるまで通さない**（`closed`）。
  // 薄れかけのロゴ越しに潜られると、書き上げたばかりの字がそのまま散る（→ src/scene/Splash.tsx）
  const splash = useAtomValue(splashAtom)
  /** 音の断りへの答え。null のあいだは音を一切起こさない */
  const consent = useAtomValue(audioConsentAtom)
  const muted = useAtomValue(mutedAtom)
  /** WebGPU レイヤーが立たなかった。ティアの判定とは別に、DOM の紙面へ落とす（→ scene/StageBoundary.tsx） */
  const stageFailed = useAtomValue(stageFailedAtom)
  const fail = useSetAtom(failStageAtom)
  const splashing = splash === 'writing' || splash === 'asking'
  const closed = splash !== 'done'
  const containerRef = useRef<HTMLDivElement>(null)

  useRouteSync()
  // 音を起こすのは断りに答えが出てから。「静寂」で始めた読者には、
  // 後からミュートを解いたときに初めて掛かる（それまで取得も始まらない）
  useAutoStartAudio(containerRef, consent !== null && !muted)
  useWooshOnTransition(phase)
  useVisitLog()

  // Tier 3 の紙面は DOM の段組みなので拡大に追従できない。そこではパンだけを許す。
  // L1 以降（node）は拡大を持たず、左右のパンだけが効く
  usePanZoomGesture(containerRef, isRoot ? 'paper' : 'node', tier !== 3 && !stageFailed)
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
      {/* WebGPU レイヤーが立たない環境（Tier 3）と、立てようとして失敗した場合（`stageFailed`）は
          どちらも DOM の紙面で成立させる。失敗を拾わないと、真っ黒の画面のまま何も起きない */}
      {tier === 3 || stageFailed ? (
        isRoot && <PaperFallback />
      ) : (
        <StageBoundary onFail={fail}>
          <Stage />
        </StageBoundary>
      )}
      <Overlay />
      {/* 断りはオーバーレイの外。ロゴが出ているあいだ `.overlay` は伏せてある */}
      <AudioConsent />
    </div>
  )
}

/**
 * 音を始める。`enabled` が立つのは音の断りに答えが出てから（→ overlay/AudioConsent.tsx）で、
 * それまでは `AudioContext` も `<audio>` も作らない＝BGM の取得も始まらない。
 * 自動再生が許されていない環境では最初の呼びで弾かれるので、
 * そのときだけ次のクリック／タップ／キー入力を待って始め直す。
 */
function useAutoStartAudio(target: React.RefObject<HTMLElement | null>, enabled: boolean): void {
  const setStarted = useSetAtom(audioStartedAtom)
  const volume = useAtomValue(volumeAtom)
  const muted = useAtomValue(mutedAtom)
  const settingsRef = useRef({ volume, muted })
  settingsRef.current = { volume, muted }

  useEffect(() => {
    const element = target.current
    if (!element || !enabled) return
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
  }, [target, setStarted, enabled])
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
