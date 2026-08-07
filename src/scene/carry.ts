/**
 * 持ち越される字の在処。
 *
 * 深度をまたぐとき、**選んだノードの字だけは薄れも現れもしない**。
 * L0 で選んだ句はそのまま次の見出しになり、図の中の子はそのまま大書になる。
 * その 1 ノードの id をここに置き、
 *   - 紙面・大書（Paper / NodeStage）は「自分の字が持ち越し側か」をフレームごとに引き、
 *   - Transition は同じ字を出発点から行き先へ動かしながら描く。
 *
 * 濃さそのものは `materials.ts` の `stageOpacity` / `carryOpacity` が持つ。
 * こちらは id だけなので、atom にせず素の値で持つ（描画は毎フレーム引き直すので
 * 再レンダーを起こす必要がない）。書き込むのは Transition.tsx の `StageFade` だけ。
 */

let carried: string | null = null

/** いま持ち越されている字が属するノード id。遷移していなければ null */
export function carriedNodeId(): string | null {
  return carried
}

export function setCarriedNodeId(id: string | null): void {
  carried = id
}
