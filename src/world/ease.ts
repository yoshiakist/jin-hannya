/**
 * 深度をまたぐ動きに共通の緩急。
 *
 * 演出（Transition.tsx）・カメラ（Stage.tsx）・L1 以降のパン（pan.ts）が同じ曲線を読むことで、
 * 同じ尺で動くものが画面上でずれない。カメラは world/ を読み、world/ は scene/ を読まないので、
 * 定義はここに置く（scene/ に置くと world/ ↔ scene/ の循環になる）。
 */

/**
 * 5 次（smootherstep）。3 次と違って両端で加速度も 0 になるので、動き出しに角が立たず、
 * 終わりはぐっと減速しながら行き先へ着地する
 */
export function ease(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}
