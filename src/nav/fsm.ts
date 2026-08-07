/**
 * 遷移の相（フェーズ）を明示的に持つ小さな状態機械。
 *
 *   idle ──hover──▶ hovered ──click──▶ zooming-in ──▶ focused
 *     ▲                                                 │
 *     └──────────── zooming-out ◀──back / breadcrumb ────┘
 *
 * `zooming-in` / `zooming-out` の間は入力を受けない。
 * ズーム中の多重クリックを殺すのがこの機械の存在理由なので、
 * 「入力を無効化する」判定は必ず `acceptsInput()` を通す。
 */

export type Phase = 'idle' | 'hovered' | 'zooming-in' | 'focused' | 'zooming-out'

export interface NavState {
  phase: Phase
  /** 現在フォーカスしているノード id */
  nodeId: string
  /** hover 中のノード id。hover していなければ null */
  hoveredId: string | null
  /** 遷移中の行き先。演出が終わったら nodeId に反映される */
  pendingId: string | null
}

export type NavEvent =
  | { type: 'hover'; id: string | null }
  | { type: 'enter'; id: string }
  | { type: 'back'; id: string }
  /** 遷移演出の完了通知。scene 側の spring が落ち着いたら送る */
  | { type: 'settled' }
  /** URL 直接指定・リロード時の同期。演出を経由せず状態を差し替える */
  | { type: 'sync'; id: string }

export const initialState = (nodeId: string): NavState => ({
  phase: 'idle',
  nodeId,
  hoveredId: null,
  pendingId: null,
})

/** この相のとき、hover / click を受け付けてよいか */
export function acceptsInput(phase: Phase): boolean {
  return phase !== 'zooming-in' && phase !== 'zooming-out'
}

export function reduce(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case 'sync':
      // 演出を経由しない強制同期。遷移中でも受け付ける
      return { phase: 'idle', nodeId: event.id, hoveredId: null, pendingId: null }

    case 'hover': {
      if (!acceptsInput(state.phase)) return state
      if (state.hoveredId === event.id) return state
      return {
        ...state,
        hoveredId: event.id,
        // focused から hover しても focused のまま。hovered は idle からの相のみ
        phase: state.phase === 'focused' ? 'focused' : event.id ? 'hovered' : 'idle',
      }
    }

    case 'enter': {
      if (!acceptsInput(state.phase)) return state
      if (event.id === state.nodeId) return state
      return { ...state, phase: 'zooming-in', hoveredId: null, pendingId: event.id }
    }

    case 'back': {
      if (!acceptsInput(state.phase)) return state
      if (event.id === state.nodeId) return state
      return { ...state, phase: 'zooming-out', hoveredId: null, pendingId: event.id }
    }

    case 'settled': {
      if (acceptsInput(state.phase)) return state
      const nodeId = state.pendingId ?? state.nodeId
      // 根へ戻りきったかどうかは呼び出し側が判断しない。相だけをここで畳む
      return { phase: 'idle', nodeId, hoveredId: null, pendingId: null }
    }
  }
}

/** いま画面に出すべきノード id。遷移中は行き先ではなく出発点を指す */
export function displayedNodeId(state: NavState): string {
  return state.nodeId
}

/** 遷移の向き。演出の非対称性（散開 ⇄ 凝集）の分岐に使う */
export function direction(state: NavState): 'in' | 'out' | null {
  if (state.phase === 'zooming-in') return 'in'
  if (state.phase === 'zooming-out') return 'out'
  return null
}
