/**
 * 読み上げボタン（画面右上）。
 *
 * 収録音声のみを扱い、TTS は使わない。
 * 音源が未収録のノードでは**ボタンを出さない**（無効状態で置かない）。
 *
 * 根（L0）だけは 1 本の音源ではなく**全文の通し読経**になる。句の音源が全部揃っている
 * ときだけ出し、再生中は音の時計から「いま唱えている字」を引いて紙面のハイライトを駆動する。
 */

import { useEffect } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { currentNodeAtom, navAtom, recitingIndexAtom, speakingNodeIdAtom } from '../nav/atoms.ts'
import { playVoice, stopVoice, playSutra, stopSutra, recitingIndex } from '../audio/index.ts'
import { sutraChain } from '../audio/recitation.ts'
import { root } from '../content/loader.ts'

export function SpeakButton() {
  const node = useAtomValue(currentNodeAtom)
  const [speaking, setSpeaking] = useAtom(speakingNodeIdAtom)

  const isRoot = node.id === root.id
  const reciting = speaking === root.id
  useRecitationHighlight(reciting)
  useStopOnDive(reciting, setSpeaking)

  // 根は通し（全句が揃っているときだけ）、それ以外は自分の音源
  if (isRoot ? sutraChain() === null : !node.audio) return null

  const active = speaking === node.id

  const onClick = () => {
    if (active) {
      if (isRoot) stopSutra()
      else stopVoice()
      setSpeaking(null)
      return
    }
    setSpeaking(node.id)
    const play = isRoot
      ? playSutra(() => setSpeaking(null))
      : playVoice(node.audio!, () => setSpeaking(null))
    void play.catch(() => setSpeaking(null))
  }

  return (
    <button type="button" className="pill" onClick={onClick} aria-pressed={active}>
      <SpeakerIcon />
      <span>{active ? '停止' : '読み上げ'}</span>
    </button>
  )
}

/**
 * 通し読経のハイライト駆動。rAF で音の時計を読み、字の変わり目でだけ atom に書く
 * （毎フレーム書くと紙面側が無駄に再計算する。変わるのは 1 拍 ≈ 0.56 秒に 1 度）。
 * 背面タブでは rAF ごと止まるが、音は `source.start(when)` の予約で進み続けるので、
 * 戻ってきたフレームで時計から正しい字に追いつく。
 */
function useRecitationHighlight(active: boolean) {
  const setReciting = useSetAtom(recitingIndexAtom)
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last: number | null = null
    const tick = () => {
      const index = recitingIndex()
      if (index !== last) {
        last = index
        setReciting(index)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      setReciting(null)
    }
  }, [active, setReciting])
}

/**
 * 通し読経は L0 の体験なので、紙面を離れたら止める。
 * 行き先が決まった時点（`pendingId`）で切る —— 演出の間だけ鳴り続けても、
 * 潜った先にハイライトすべき紙面はもう無い。
 */
function useStopOnDive(reciting: boolean, setSpeaking: (id: string | null) => void) {
  const nav = useAtomValue(navAtom)
  const destination = nav.pendingId ?? nav.nodeId
  useEffect(() => {
    if (reciting && destination !== root.id) {
      stopSutra()
      setSpeaking(null)
    }
  }, [reciting, destination, setSpeaking])
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
      <path
        d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M15.5 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
