/**
 * Tier 3（WebGL 不可）の紙面。
 *
 * Canvas を一切マウントせず、DOM だけで L0 を成立させる。
 * 2 レイヤー構成の帰結として「WebGPU レイヤーを外すだけ」で得られる状態がこれ（README「性能ティア」）。
 * 粒子表現は無く、遷移は CSS の transition に委ねる。
 */

import { useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { SUTRA_CHARS, cellOf } from '../content/sutra.ts'
import { navAtom, acceptsInputAtom, completedIdsAtom, recitingIndexAtom } from '../nav/atoms.ts'
import { root, childrenOf } from '../content/loader.ts'
import { isGestureClick } from '../world/pan.ts'

export function PaperFallback() {
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)
  const hoveredId = useAtomValue(navAtom).hoveredId
  /** 読破した語。GPU レイヤーの青白（Paper.tsx）に対応する DOM 側の表現 */
  const completed = useAtomValue(completedIdsAtom)
  /** 通し読経でいま唱えている字。hover と同じ琥珀（is-focused）で灯す */
  const reciting = useAtomValue(recitingIndexAtom)

  /** 文字インデックス → 潜り先ノード id。Paper.tsx と同じ表を DOM 側でも引く */
  const indexToNode = useMemo(() => {
    const table: (string | null)[] = new Array(SUTRA_CHARS.length).fill(null)
    for (const child of childrenOf(root)) {
      if (!child.range) continue
      for (let i = child.range[0]; i < child.range[1] && i < table.length; i++) table[i] = child.id
    }
    return table
  }, [])

  /**
   * 列の切れ目は sutra.txt の改行位置。Paper.tsx と同じ格子を DOM でも組む。
   * 全角スペースの升は字が無いので、row の抜けを空の升で埋める。
   */
  const columns = useMemo(() => {
    const out: ({ index: number; char: string } | null)[][] = []
    SUTRA_CHARS.forEach((char, index) => {
      const { column, row } = cellOf(index)
      const cells = (out[column] ??= [])
      while (cells.length < row) cells.push(null)
      cells.push({ index, char })
    })
    return out
  }, [])

  return (
    <div className="paper-fallback">
      {columns.map((column, c) => (
        <div className="paper-fallback__column" key={c}>
          {column.map((cell, r) => {
            if (!cell) return <span className="paper-fallback__char" key={`gap-${r}`} />
            const { index, char } = cell
            const id = indexToNode[index]
            const focused = (id !== null && id === hoveredId) || index === reciting
            const visited = id != null && completed.has(id)
            return (
              <span
                key={index}
                className={`paper-fallback__char${visited ? ' is-visited' : ''}${focused ? ' is-focused' : ''}${hoveredId && !focused ? ' is-dimmed' : ''}`}
                onPointerEnter={() => accepts && dispatch({ type: 'hover', id: id ?? null })}
                onClick={() => accepts && id && !isGestureClick() && dispatch({ type: 'enter', id })}
              >
                {char}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}
