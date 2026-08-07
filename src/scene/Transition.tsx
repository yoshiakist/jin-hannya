/**
 * 深度をまたぐ演出の指揮。
 *
 * 潜る … フォーカス外の字が粒子となって散開する。生き残る字はメッシュのまま移動する
 * 戻る … 現在の字はそのまま再配置され、それと並行して粒子が凝集して周囲の字を形作る
 *
 * どちらも「メッシュのまま動くもの」と「粒子になるもの」を分けるのが要点で、
 * ここはその振り分けと進行度の管理だけを持つ。粒子の運動そのものは Particles.tsx。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { TransitionParticles, type ParticleSource } from './Particles.tsx'
import { headlineLayout, headlinePosition } from './NodeStage.tsx'
import { navAtom, tierAtom } from '../nav/atoms.ts'
import { nodeById, root, childrenOf } from '../content/loader.ts'
import { SUTRA_CHARS } from '../content/sutra.ts'
import { gridPosition, GLYPH_SIZE, VIEW_HEIGHT } from '../world/paper.ts'
import type { GraphNode } from '../content/schema.ts'

/** 遷移演出の尺（ミリ秒）。ふんわりと滑らかに接続する */
export const TRANSITION_MS = 900

/**
 * あるノードを表示しているとき、画面上に存在する字とその位置。
 * 根なら紙面の格子、それ以外なら大書 + 子の図。
 * 「どの字が生き残るか」の判定に使うので、NodeStage の配置とは独立に持つ。
 */
function visibleGlyphs(node: GraphNode): ParticleSource[] {
  if (node.kind === 'sutra') {
    return SUTRA_CHARS.map((char, index) => {
      const [x, y] = gridPosition(index)
      return { char, position: [x, y] as [number, number], size: GLYPH_SIZE }
    })
  }

  const { chars, perColumn, size } = headlineLayout(node.label)
  const headline: ParticleSource[] = chars.map((char, i) => {
    const [x, y] = headlinePosition(i, perColumn, chars.length, size)
    return { char, position: [x, y] as [number, number], size }
  })

  const kids = childrenOf(node).flatMap((child, i, all) => {
    const childSize = VIEW_HEIGHT * (node.layout === 'circle' ? 0.102 : 0.06)
    const angle = Math.PI / 2 - (i / all.length) * Math.PI * 2
    const radius = VIEW_HEIGHT * 0.204
    const base: [number, number] =
      node.layout === 'circle'
        ? [Math.cos(angle) * radius, Math.sin(angle) * radius]
        : [0, ((all.length - 1) / 2 - i) * ((VIEW_HEIGHT * 0.78) / all.length)]
    return Array.from(child.label).map((char, k, label) => ({
      char,
      position: [base[0], base[1] + ((label.length - 1) / 2 - k) * childSize] as [number, number],
      size: childSize,
    }))
  })

  return [...headline, ...kids]
}

export function Transition() {
  const nav = useAtomValue(navAtom)
  const tier = useAtomValue(tierAtom)
  const dispatch = useSetAtom(navAtom)
  const startedAt = useRef(0)

  const active = nav.phase === 'zooming-in' || nav.phase === 'zooming-out'
  const mode = nav.phase === 'zooming-in' ? 'disperse' : 'converge'

  const sources = useMemo<ParticleSource[]>(() => {
    if (!active || !nav.pendingId) return []
    const from = nodeById(nav.nodeId) ?? root
    const to = nodeById(nav.pendingId) ?? root
    const before = visibleGlyphs(from)
    const after = visibleGlyphs(to)

    if (mode === 'disperse') {
      // 行き先に現れない字が散る。生き残る字は粒子化せずメッシュのまま移動する
      const surviving = new Set(after.map((s) => s.char))
      return before.filter((s) => !surviving.has(s.char))
    }
    // 戻るときは、行き先で新たに現れる字を無から凝集させる
    const existing = new Set(before.map((s) => s.char))
    return after.filter((s) => !existing.has(s.char))
  }, [active, mode, nav.nodeId, nav.pendingId])

  // 演出の終了で FSM を次の相へ進める。Tier 3 は粒子を出さないが尺は揃える
  useEffect(() => {
    if (!active) return
    startedAt.current = performance.now()
    const timer = setTimeout(() => dispatch({ type: 'settled' }), TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [active, nav.pendingId, dispatch])

  if (!active || tier === 3 || sources.length === 0) return null

  return (
    <TransitionParticles
      sources={sources}
      mode={mode}
      progress={() => Math.min(1, (performance.now() - startedAt.current) / TRANSITION_MS)}
    />
  )
}
