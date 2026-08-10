/**
 * Jotai atoms。現在ノード・遷移フェーズ・設定（音量等）を持つ。
 * FSM の遷移そのものは src/nav/fsm.ts が持ち、ここは器に徹する。
 */

import { atom } from 'jotai'
import { atomWithReducer } from 'jotai/utils'
import { reduce, initialState, acceptsInput, direction, type NavState, type NavEvent } from './fsm.ts'
import {
  root,
  nodeById,
  ancestryOf,
  childrenOf,
  relatedOf,
  docById,
  SUTRA_INDEX_TO_NODE,
} from '../content/loader.ts'
import { initialNodeId } from './url.ts'
import { loadVisited, saveVisited, completedIds } from './progress.ts'
import { loadConsent, type AudioConsent } from '../audio/consent.ts'
import { detectTier, type Tier } from '../scene/tier.ts'
import type { GraphNode } from '../content/schema.ts'

/**
 * ナビゲーション状態。書き込みは NavEvent を dispatch する形に限定する。
 * 初期ノードは URL から引く（深いパスの直接ロードで、マウント後の sync を待たない）
 */
export const navAtom = atomWithReducer<NavState, NavEvent>(initialState(initialNodeId()), reduce)

export const phaseAtom = atom((get) => get(navAtom).phase)
export const acceptsInputAtom = atom((get) => acceptsInput(get(navAtom).phase))
export const directionAtom = atom((get) => direction(get(navAtom)))

/** いま大書されているノード */
export const currentNodeAtom = atom<GraphNode>((get) => nodeById(get(navAtom).nodeId) ?? root)

/** 遷移の行き先。遷移していなければ null */
export const pendingNodeAtom = atom<GraphNode | null>((get) => {
  const id = get(navAtom).pendingId
  return id ? (nodeById(id) ?? null) : null
})

/** 根から現在ノードまでの経路。現在位置インジケータが使う */
export const ancestryAtom = atom<GraphNode[]>((get) => ancestryOf(get(currentNodeAtom)))

/** 現在ノードの子。円相・縦連結の配置対象 */
export const childNodesAtom = atom<GraphNode[]>((get) => childrenOf(get(currentNodeAtom)))

/**
 * 現在ノードの隣接語。図には出さず、本文のさらに左に「関連語句」として散らす。
 * 木の子（`childNodesAtom`）とは別の関係なので、両方に出ることはない。
 */
export const relatedNodesAtom = atom<GraphNode[]>((get) => relatedOf(get(currentNodeAtom)))

/** hover 中のノード。琥珀グローの対象 */
export const hoveredNodeAtom = atom<GraphNode | null>((get) => {
  const id = get(navAtom).hoveredId
  return id ? (nodeById(id) ?? null) : null
})

/**
 * いま光らせるべき全文の文字インデックス範囲。
 * L0 では「一定範囲の文字だけが光る」表現になるため、hover 中のノードの range をそのまま使う。
 * range を持たない概念ノードでは null（格子上にハイライトできない）。
 */
export const highlightRangeAtom = atom<readonly [number, number] | null>((get) => {
  return get(hoveredNodeAtom)?.range ?? null
})

/** 現在ノードの長文解説 */
export const currentDocAtom = atom((get) => docById(get(currentNodeAtom).id) ?? null)

/** 現在ノードが根か。左矢印や戻る操作の可否に使う */
export const isRootAtom = atom((get) => get(currentNodeAtom).id === root.id)

/**
 * 遷移のあいだ、いま出ているテキストはもう用済み。潜るときも戻るときも次の面に持ち越さない。
 * `nodeId` は `settled` まで出発点を指し続けるので、それを待つと退場が演出の終わりまで遅れ、
 * 字が散っていくあいだ本文だけが残ってから消えることになる。相の開始と同時に引く。
 */
export const leavingAtom = atom((get) => {
  const phase = get(navAtom).phase
  return phase === 'zooming-out' || phase === 'zooming-in'
})

/**
 * 戻る先が根か。現在位置インジケータは深さの表示なので、まだ深いところへ戻るあいだは
 * 出しっぱなしにし（中身だけ差し替える）、根へ戻るときだけ他のテキストと同時に引く。
 */
export const leavingToRootAtom = atom((get) => {
  const state = get(navAtom)
  if (state.phase !== 'zooming-out') return false
  const target = state.pendingId ? nodeById(state.pendingId) : null
  return !target || ancestryOf(target).length <= 1
})

// --- 読破の記録 -------------------------------------------------------------

/** 訪れたノード id。localStorage から復元し、書くたびに焼き直す（→ src/nav/progress.ts） */
export const visitedAtom = atom<ReadonlySet<string>>(loadVisited())

/** 1 ノードを訪問済みにする。既に入っていれば何もしない（再描画を起こさない） */
export const markVisitedAtom = atom(null, (get, set, id: string) => {
  const current = get(visitedAtom)
  if (current.has(id)) return
  const next = new Set(current)
  next.add(id)
  set(visitedAtom, next)
  saveVisited(next)
})

/**
 * 読破したノード id。規定の深さ（`READ_DEPTH`、枝が浅ければその最深）まで下りた語だけが入る。
 * L0 はこれを引いて、その語の `range` の字を青白く灯す。
 */
export const completedIdsAtom = atom<ReadonlySet<string>>((get) => completedIds(get(visitedAtom)))

/**
 * 全文の文字インデックス → その字が読破済みの語に属するか。
 * hover の光り方（`highlightRangeAtom`）と同じく、L0 で見えるのは根の子の `range` だけ。
 */
export const visitedIndicesAtom = atom<Float32Array>((get) => {
  const completed = get(completedIdsAtom)
  const array = new Float32Array(SUTRA_INDEX_TO_NODE.length)
  for (let i = 0; i < array.length; i++) {
    const id = SUTRA_INDEX_TO_NODE[i]
    array[i] = id != null && completed.has(id) ? 1 : 0
  }
  return array
})

// --- 実行環境 ---------------------------------------------------------------

/** 性能ティア。起動時に 1 度だけ判定する */
const TIER = detectTier()
export const tierAtom = atom<Tier>(TIER)

/**
 * 実測フレームタイムから動的に下げる粒子数の係数（0〜1）。
 * 起動後数秒の計測で機種差を吸収する（README「性能ティア」）。
 */
export const particleScaleAtom = atom(1)

/**
 * WebGPU レイヤーが立たなかった（グリフの bin が取れない・レンダラの初期化に失敗した・
 * 描画中に落ちた）。**Tier 1/2 でも DOM の紙面へ落とすための旗**で、
 * ティアの判定とは別勘定にしてある（能力はあるのに個別の事情で立たない場合がある）。
 */
export const stageFailedAtom = atom(false)

/** 立たなかったと決める。ロゴは書けないので畳んだ状態にしておく（`.splashing` が面を伏せたままになる） */
export const failStageAtom = atom(null, (_get, set) => {
  set(stageFailedAtom, true)
  set(splashAtom, 'done')
})

// --- 起動のロゴ -------------------------------------------------------------

/**
 * ロゴ（深般若）を書いている相。
 *   writing … 暗闇に筆を運んでいる。紙面は伏せたまま
 *   asking  … 書き上がり、音の断り（`audioConsentAtom`）に答えを待っている。ロゴは出したまま
 *   fading  … ロゴが薄れ、入れ替わりに経文が滲み出す
 *   done    … ロゴは畳まれ、以後この面には戻らない
 */
export type SplashPhase = 'writing' | 'asking' | 'fading' | 'done'

/**
 * ロゴを出すか。**根を直接開いたときの 1 回だけ**で、
 * L1 以降からリンクで戻ってきても（同じページのまま相が進むので）二度と 'writing' には戻らない。
 */
function initialSplashPhase(): SplashPhase {
  if (typeof window === 'undefined') return 'done'
  // 潜った先を直接開いた読者に、名乗りは要らない
  if (initialNodeId() !== root.id) return 'done'
  // Tier 3 は Canvas を持たない。筆を運ぶ層そのものが無い
  if (TIER === 3) return 'done'
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'done'
  return 'writing'
}

/** 相の初期値は 2 か所（ロゴ本体と、断りを聞き直すかの判断）で要る。数えるのは 1 度でよい */
const INITIAL_SPLASH = initialSplashPhase()

export const splashAtom = atom<SplashPhase>(INITIAL_SPLASH)

/**
 * 音の断りへの答え。**`null` のあいだは面を開けない**
 * （経文は滲み出さず＝ src/scene/Paper.tsx、ロゴを持たない入り方では暗幕が掛かる）。
 *
 * 答えは localStorage に残す（→ src/audio/consent.ts）。二度目からは聞かないが、
 * **ロゴを出す入り方でだけは毎回聞く**。ロゴを書き上げたところで断りが出るのが一続きの流れで、
 * そこだけ抜くと筆を置いた先が宙に浮く。
 */
export type { AudioConsent }
const INITIAL_CONSENT: AudioConsent | null = INITIAL_SPLASH === 'writing' ? null : loadConsent()
export const audioConsentAtom = atom<AudioConsent | null>(INITIAL_CONSENT)

// --- 設定 -------------------------------------------------------------------

/** BGM 音量。控えめな既定値から始め、0 まで下げ切れる */
export const bgmVolumeAtom = atom(0.35)
/** 「静寂」で始めた（あるいは前回そう答えた）読者は伏せた状態から始める */
export const mutedAtom = atom(INITIAL_CONSENT === 'silent')

/** BGM が実際に鳴り始めたか。自動再生が弾かれた環境では最初の操作まで false のまま */
export const audioStartedAtom = atom(false)

/** 読み上げ再生中のノード id。ボタンの状態表示に使う */
export const speakingNodeIdAtom = atom<string | null>(null)
