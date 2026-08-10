/**
 * 音の断り。BGM が流れることを先に伝え、答えが出てから面を開ける。
 *
 * ロゴ（src/scene/Splash.tsx）を書き上げた、あるいは飛ばされたところで、
 * 書いたばかりの字の下に小さく出す。答えるまで紙面は滲み出さず（→ Paper.tsx の
 * `revealTime`）、ロゴも薄れない。音は**答えを聞いてから**しか起こさない。
 *   承知 … BGM を鳴らして始める
 *   静寂 … 音を一切起こさない。`AudioContext` も `<audio>` も作らないので取得も始まらない。
 *          後からミュートを解けば、そこで初めて鳴り出す（→ src/App.tsx の `useAutoStartAudio`）
 *
 * ロゴを持たない入り方（潜った先を直接開いた・Tier 3・視差を抑える設定）でも同じ断りを出す。
 * 音が流れるのはどの入り方でも同じで、断りだけ省く理由が無い。ただし答えは覚えてあるので、
 * 二度目からはこの面ごと出ない（→ src/audio/consent.ts）。
 * そこには見せる中身が既に出来ているので、**暗幕**を掛けて答えを待つ。
 * ロゴのある入り方（`asking`）で暗幕を掛けないのは、紙面が既に伏せてあり、
 * 幕を掛けるとロゴまで隠れてしまうため（→ Paper.tsx の `paperOpacity`）。
 */

import { useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { audioConsentAtom, mutedAtom, splashAtom } from '../nav/atoms.ts'
import { saveConsent } from '../audio/consent.ts'

export function AudioConsent() {
  const splash = useAtomValue(splashAtom)
  const [consent, setConsent] = useAtom(audioConsentAtom)
  const setMuted = useSetAtom(mutedAtom)
  /**
   * 暗幕が要る入り方だったか。**最初の描画で決める。**
   * 覚えてある答えで入ったときは掛けない（掛けてから開けると、開くぶんだけ面が遅れて出る）
   */
  const [veiled] = useState(() => consent === null && splash === 'done')
  /** 暗幕を畳み終えたか。開き切るまでは掛けたまま置く（外すのは transition の終わり） */
  const [opened, setOpened] = useState(false)

  // 筆を運んでいるあいだは断りも出さない（面は暗闇のまま）。
  // 'fading' に居るのは答えが出たあとだけなので、ここに掛かるのは 'asking' と 'done'
  const asking = consent === null && splash !== 'writing' && splash !== 'fading'
  // ロゴを持たない入り方でだけ暗幕が要る。答えたあとは開き切るまで残す
  const curtain = veiled && !opened

  if (!asking && !curtain) return null

  const answer = (value: 'accepted' | 'silent') => {
    setMuted(value === 'silent')
    setConsent(value)
    // 次に開いたときは聞かない（ロゴを出す入り方でだけは聞き直す。→ src/audio/consent.ts）
    saveConsent(value)
  }

  return (
    <>
      {curtain && (
        <div
          className={`curtain${consent === null ? '' : ' curtain--open'}`}
          // 開き切ってから外す。掛かっているあいだは背後の面を触らせない
          onTransitionEnd={() => setOpened(true)}
          aria-hidden
        />
      )}
      {asking && (
        <div className="consent" role="group" aria-label="音の断り">
          <p className="consent__note">本サイトはBGMが流れます</p>
          <div className="consent__actions">
            {/* 二字は見た目の対称のため。ボタン単体で読み上げられたとき、どちらが鳴る側か分かるよう名前を足す */}
            <button
              type="button"
              className="pill pill--large"
              aria-label="BGMを鳴らして始める"
              onClick={() => answer('accepted')}
              autoFocus
            >
              承知
            </button>
            <button
              type="button"
              className="pill pill--large"
              aria-label="音を鳴らさずに始める"
              onClick={() => answer('silent')}
            >
              静寂
            </button>
          </div>
        </div>
      )}
    </>
  )
}
