/**
 * BGM の音量・ミュート。
 * 音がノイズにならないことが最優先の制約なので、**ユーザーが下げ切れる**ことを保証する。
 */

import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { bgmVolumeAtom, mutedAtom } from '../nav/atoms.ts'
import { setBgmVolume, setMuted } from '../audio/index.ts'

export function AudioControls() {
  const [volume, setVolume] = useAtom(bgmVolumeAtom)
  const [muted, setMutedState] = useAtom(mutedAtom)

  // 音が始まる前から出しておく（自動再生が弾かれた環境でも操作の在り処が判る）。
  // 開始前の setBgmVolume / setMuted は無害な空振りで、値は startAudio が改めて反映する
  useEffect(() => setBgmVolume(volume), [volume])
  useEffect(() => setMuted(muted), [muted])

  return (
    <div className="audio-controls">
      <button
        type="button"
        className="pill pill--icon"
        onClick={() => setMutedState((m) => !m)}
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
