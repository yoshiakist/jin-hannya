/**
 * Jotai atoms。現在ノード・遷移フェーズ・設定（音量等）を持つ。
 * FSM の遷移そのものは src/nav/fsm.ts が持ち、ここは器に徹する。
 */

import { atom } from 'jotai'
import { atomWithReducer } from 'jotai/utils'
import { reduce, initialState, acceptsInput, direction, type NavState, type NavEvent } from './fsm.ts'
import { root, nodeById, ancestryOf, childrenOf, docById } from '../content/loader.ts'
import { detectTier, type Tier } from '../scene/tier.ts'
import type { GraphNode } from '../content/schema.ts'

/** ナビゲーション状態。書き込みは NavEvent を dispatch する形に限定する */
export const navAtom = atomWithReducer<NavState, NavEvent>(initialState(root.id), reduce)

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

/** 初回のユーザー操作で音声を開始したか（自動再生制限への対応） */
export const audioStartedAtom = atom(false)

/** 読み上げ再生中のノード id。ボタンの状態表示に使う */
export const speakingNodeIdAtom = atom<string | null>(null)
