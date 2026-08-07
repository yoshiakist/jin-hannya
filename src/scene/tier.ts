/**
 * 性能ティアの判定。README「性能ティア」より。
 *
 * Tier は**実行環境の描画能力**のみを指す。深度（L0 / L1 …）とは無関係。
 * 判定順は `navigator.gpu` → WebGL2 コンテキスト取得試行。
 */

export type Tier = 1 | 2 | 3

export function detectTier(): Tier {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) return 1

  try {
    const canvas = document.createElement('canvas')
    if (canvas.getContext('webgl2')) return 2
  } catch {
    // getContext が投げる環境もある。その場合は WebGL 不可として扱う
  }
  return 3
}

/** devicePixelRatio の上限キャップ。README「1.5〜2 で上限キャップ」 */
export function cappedDpr(): [number, number] {
  return [1, Math.min(globalThis.devicePixelRatio ?? 1, 2)]
}

/** ティアごとの基準粒子数（1 文字あたり）。実測でさらに下げる */
export const PARTICLE_BUDGET: Record<Tier, number> = {
  1: 4000,
  2: 400,
  3: 0,
}

/**
 * 起動後数秒のフレームタイムを測り、粒子数の係数（0〜1）を返す。
 * 機種差を吸収するための後追い調整で、初期表示はティアの既定値で始める。
 */
export function measureFrameBudget(onSettle: (scale: number) => void, sampleMs = 3000): () => void {
  if (typeof requestAnimationFrame !== 'function') return () => {}

  let frames = 0
  let start = -1
  let raf = 0
  let cancelled = false

  const tick = (now: number) => {
    if (cancelled) return
    if (start < 0) start = now
    frames++
    if (now - start >= sampleMs) {
      const fps = (frames * 1000) / (now - start)
      // 60fps を基準に、落ちているぶんだけ粒子を削る。上げ方向へは伸ばさない
      onSettle(Math.max(0.15, Math.min(1, fps / 55)))
      return
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    cancelled = true
    cancelAnimationFrame(raf)
  }
}
