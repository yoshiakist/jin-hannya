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
export const tierAtom = atom<Tier>(detectTier())

/**
 * 実測フレームタイムから動的に下げる粒子数の係数（0〜1）。
 * 起動後数秒の計測で機種差を吸収する（README「性能ティア」）。
 */
export const particleScaleAtom = atom(1)

// --- 設定 -------------------------------------------------------------------

/** BGM 音量。控えめな既定値から始め、0 まで下げ切れる */
export const bgmVolumeAtom = atom(0.35)
export const mutedAtom = atom(false)

/** BGM が実際に鳴り始めたか。自動再生が弾かれた環境では最初の操作まで false のまま */
export const audioStartedAtom = atom(false)

/** 読み上げ再生中のノード id。ボタンの状態表示に使う */
export const speakingNodeIdAtom = atom<string | null>(null)
