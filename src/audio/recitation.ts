/**
 * 通し読経のタイムライン。
 *
 * 収録音声は BPM 108・1 字 1 拍の格子に乗せてある（→ skill: audio-design）。
 * 各ファイルの頭には 0.3 秒の空白があり、最初の字の発声（アタック）が 0.3s 地点に来る。
 * ファイルの切れ目は根の子（句）の `range` 境界と一致するので、句の音源を拍の目盛りへ
 * 順に並べるだけで全文が途切れず繋がる —— **開始間隔は「拍 × 字数」ちょうど**
 * （先行の 0.3 秒は全ファイルが同じだけ持つので相殺される）。
 *
 * 等拍で読まない箇所（題の結びの引き伸ばし・真言の 2 字 1 拍）は
 * YAML の `audio_beats` が字ごとの拍数として持つ。ここはそれを積むだけで、
 * 拍割りの知識をコードに書かない。
 */

import { childrenOf, root } from '../content/loader.ts'
import { SUTRA_LENGTH } from '../content/sutra.ts'
import { contentSource } from '../content/source.ts'

/** 1 拍の長さ（秒）。555ms と概数にすると全文で 150ms ほど先走るので割り切らない */
export const BEAT_SEC = 60 / 108

/** 各ファイル頭の空白（秒）。アタックはこの地点に来るよう収録時に切ってある */
export const LEAD_SEC = 0.3

/** 句 1 つぶんの音源と、その最初の字が鳴る拍 */
export interface ChainSource {
  file: string
  startBeat: number
}

/** 字が鳴る瞬間。`atSec` は最初の字のアタックを 0 とした秒 */
export interface CharEvent {
  index: number
  atSec: number
}

export interface SutraChain {
  sources: ChainSource[]
  /** 全文インデックス順。ハイライトはこの表を時刻で引く */
  events: CharEvent[]
  totalBeats: number
}

let cached: SutraChain | null | undefined

/**
 * 全文の連結表。**1 句でも音源が欠ければ null**（歯抜けの無音を挟んでまで通しはしない。
 * ボタンごと出さない判断に使う）。中身は静的なので 1 度だけ組む。
 */
export function sutraChain(): SutraChain | null {
  return (cached ??= build())
}

function build(): SutraChain | null {
  const inventory = new Set(contentSource.voiceFiles)
  const phrases = childrenOf(root)
    .filter((node) => node.range)
    .sort((a, b) => a.range![0] - b.range![0])

  const sources: ChainSource[] = []
  const events: CharEvent[] = []
  let beat = 0
  let cursor = 0
  for (const node of phrases) {
    const [start, end] = node.range!
    if (!node.audio || !inventory.has(node.audio) || start !== cursor) return null
    const beats = node.audio_beats
    // 長さ違いは validate-graph が落とすが、ずれた表で鳴らすと全句が狂うので二重に守る
    if (beats && beats.length !== end - start) return null
    sources.push({ file: node.audio, startBeat: beat })
    for (let i = 0; i < end - start; i++) {
      events.push({ index: start + i, atSec: beat * BEAT_SEC })
      beat += beats?.[i] ?? 1
    }
    cursor = end
  }
  if (cursor !== SUTRA_LENGTH || sources.length === 0) return null
  return { sources, events, totalBeats: beat }
}
