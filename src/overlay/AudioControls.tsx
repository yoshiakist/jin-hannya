/**
 * 音量・ミュート。スライダは 1 本で、BGM と読み上げをそれぞれの上限ゲインへ写す
 * （→ src/audio/index.ts の BGM_CEILING / VOICE_CEILING）。
 * 音がノイズにならないことが最優先の制約なので、**ユーザーが下げ切れる**ことを保証する。
 *
 * ミュートの切り替えは、起動時の断り（overlay/AudioConsent.tsx）への答えを言い直したものとして
 * 同じ記憶に書く。ここで伏せた読者に次も断りから始めさせない（→ src/audio/consent.ts）。
 */

import { useAtom, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { audioConsentAtom, volumeAtom, mutedAtom } from '../nav/atoms.ts'
import { setVolume, setMuted } from '../audio/index.ts'
import { saveConsent } from '../audio/consent.ts'

export function AudioControls() {
  const [volume, setVolumeState] = useAtom(volumeAtom)
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
  // 開始前の setVolume は値を控えるだけ、setMuted は無害な空振りで、AudioContext が起きたときに反映される
  useEffect(() => setVolume(volume), [volume])
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
        onChange={(event) => setVolumeState(Number(event.target.value))}
        aria-label="音量"
        disabled={muted}
      />
    </div>
  )
}
