/**
 * BGM の音量・ミュート。
 * 音がノイズにならないことが最優先の制約なので、**ユーザーが下げ切れる**ことを保証する。
 *
 * ミュートの切り替えは、起動時の断り（overlay/AudioConsent.tsx）への答えを言い直したものとして
 * 同じ記憶に書く。ここで伏せた読者に次も断りから始めさせない（→ src/audio/consent.ts）。
 */

import { useAtom, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { audioConsentAtom, bgmVolumeAtom, mutedAtom } from '../nav/atoms.ts'
import { setBgmVolume, setMuted } from '../audio/index.ts'
import { saveConsent } from '../audio/consent.ts'

export function AudioControls() {
  const [volume, setVolume] = useAtom(bgmVolumeAtom)
  const [muted, setMutedState] = useAtom(mutedAtom)
  const setConsent = useSetAtom(audioConsentAtom)

  const toggleMuted = () => {
    const next = !muted
    setMutedState(next)
    // 伏せたら「静寂」、戻したら「承知」。解いた側では、まだ音を起こしていなければここで起き出す
    const answer = next ? 'silent' : 'accepted'
    setConsent(answer)
    saveConsent(answer)
  }

  // 音が始まる前から出しておく（自動再生が弾かれた環境でも操作の在り処が判る）。
  // 開始前の setBgmVolume / setMuted は無害な空振りで、値は startAudio が改めて反映する
  useEffect(() => setBgmVolume(volume), [volume])
  useEffect(() => setMuted(muted), [muted])

  return (
    <div className="audio-controls">
      <button
        type="button"
        className="pill pill--icon"
        onClick={toggleMuted}
        aria-pressed={muted}
        aria-label={muted ? 'ミュート解除' : 'ミュート'}
      >
        {muted ? '♪̸' : '♪'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(event) => setVolume(Number(event.target.value))}
        aria-label="BGM の音量"
        disabled={muted}
      />
    </div>
  )
}
