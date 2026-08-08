/**
 * 入口の呼び水。
 *
 * L1 以降の画面では、どれが子への入口なのか（大書のどの字を押せるのか、図のどれが押せるのか）が
 * 触ってみるまで分からない。そこで**入口だけを周期的に琥珀へ灯す**。hover の琥珀と同じ色・同じ
 * 滲みを使い、強さだけを落とす。色は増やさない（琥珀 = いま触れられるもの、の意味を延長する）。
 *
 * 灯りは入口ごとに `PULSE_STAGGER` 秒ずつ遅れて回る。一斉に光ると画面が明滅するだけだが、
 * ずらすと「右から左へ順に呼ばれる」動きになり、入口が複数あることまで同時に伝わる。
 *
 * 時計はノードごとに 1 本。潜った先で必ず頭から数え直すので、着いてすぐ 1 巡目が見える。
 * 位相を全体で共有すると、着いた瞬間が周期の谷だったときに 5 秒近く何も光らない。
 */

/** 一巡の長さ（秒）。目に留まるが、読んでいるあいだ気が散らない間隔 */
export const PULSE_PERIOD = 7

/** 入口ごとの遅れ（秒）。読み順（大書は上から、図は先頭から）に灯る */
export const PULSE_STAGGER = 0.8

/** 1 つが灯って消えるまで（秒） */
const PULSE_DURATION = 1.0 

/** 灯りの強さ（1 = hover と同じ）。触れているものが常に一番明るくなるよう控えめに持つ */
const PULSE_PEAK = 0.7

/** 着いてから 1 巡目までの間（秒）。遷移が収まってから灯す */
const PULSE_LEAD_IN = 0.8

/** ノードに着いた時刻（`clock.elapsedTime`） */
let origin = 0
/** 次のフレームで数え直す */
let armed = true
/** 着いてからの経過（秒）。フレームに 1 度だけ進める */
let elapsed = 0

/** 現在ノードが変わったときに呼ぶ。次のフレームから周期を数え直す */
export function restartPulse(): void {
  armed = true
}

/** フレームに 1 度、`NodeStage` が呼ぶ。`pulseAt` はこの値だけを読む */
export function advancePulse(time: number): void {
  if (armed) {
    origin = time
    armed = false
  }
  elapsed = time - origin
}

/**
 * `order` 番目の入口の灯り（0〜1）。順番は大書なら子の並び、図なら項目の並び。
 * 山は正弦の二乗。線形に上げ下げすると点いた瞬間と消えた瞬間に角が見える。
 */
export function pulseAt(order: number): number {
  const t = elapsed - PULSE_LEAD_IN - order * PULSE_STAGGER
  if (t < 0) return 0
  const phase = t % PULSE_PERIOD
  if (phase >= PULSE_DURATION) return 0
  const u = Math.sin((Math.PI * phase) / PULSE_DURATION)
  return u * u * PULSE_PEAK
}
