/**
 * 読み上げボタン（画面右上）。
 *
 * 収録音声のみを扱い、TTS は使わない。
 * 音源が未収録のノードでは**ボタンを出さない**（無効状態で置かない）。
 */

import { useAtom, useAtomValue } from 'jotai'
import { currentNodeAtom, speakingNodeIdAtom } from '../nav/atoms.ts'
import { playVoice, stopVoice } from '../audio/index.ts'

export function SpeakButton() {
  const node = useAtomValue(currentNodeAtom)
  const [speaking, setSpeaking] = useAtom(speakingNodeIdAtom)

  if (!node.audio) return null

  const active = speaking === node.id

  const onClick = () => {
    if (active) {
      stopVoice()
      setSpeaking(null)
      return
    }
    setSpeaking(node.id)
    void playVoice(node.audio!, () => setSpeaking(null)).catch(() => setSpeaking(null))
  }

  return (
    <button type="button" className="pill" onClick={onClick} aria-pressed={active}>
      <SpeakerIcon />
      <span>{active ? '停止' : '読み上げ'}</span>
    </button>
  )
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
