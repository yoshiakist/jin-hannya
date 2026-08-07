/**
 * L1 以降の配置。大書と子の図の**寸法だけ**を持つ。
 *
 * 描画（`scene/NodeStage.tsx`）・遷移（`scene/Transition.tsx`）・DOM の組版（`overlay/Overlay.tsx`）が
 * 同じ数値を引けるよう、three に依存しない場所へ置く。位置と大きさの出所はここ 1 箇所だけである
 * （ずれると遷移の継ぎ目で字が跳ね、オーバーレイが大書に重なる）。
 */

import { VIEW_HEIGHT } from './paper.ts'
import { halfWidthFor, unitsPerPixel } from './pan.ts'
import { labelText, type GraphNode } from '../content/schema.ts'

/** 大書の 1 文字あたりの高さ。画面高の 60〜85% を大書が占める（モック分析より） */
const HEADLINE_SIZE = VIEW_HEIGHT * 0.30
/** 大書が 1 列で収まる上限。これを超えたら 2 列に折り返す（img_01 の 2 列組みに相当） */
const HEADLINE_SINGLE_COLUMN_MAX = 7

/** 画面右端の大書の中心 x。ワールド単位 */
const HEADLINE_X = VIEW_HEIGHT * 0.60
/** 大書の行間（列の送り）。1 字の大きさに対する倍率 */
const HEADLINE_COLUMN_PITCH = 1.22

/**
 * 大書の右端と画面の右端のあいだに残す余白（px）。
 * ワールド単位ではなく px で持つ：字の大きさは画面高から決まるので、
 * 横に狭い画面ほど大書は相対的に大きくなり、比で持つと余白が足りなくなる。
 *
 * 読み（かな）はこの帯に入るので、狭めると読みの列数が減る。
 */
const HEADLINE_MARGIN_PX = 150
/** ただし余白が画面幅を食い潰さないよう、幅に対する上限を置く（狭いスマホ向け） */
const HEADLINE_MARGIN_MAX_RATIO = 0.2

export interface HeadlineLayout {
  /** 読む順（右の列の上から、左の列の下へ）に並べた字 */
  chars: string[]
  /** `chars` と同じ順のワールド座標 */
  positions: [number, number, number][]
  /** 1 字の大きさ */
  size: number
}

/**
 * 大書の列の切り方。
 * label の空白・改行を列の切れ目として読むので、どこで折るかはコンテンツ側が決められる。
 * 区切りを持たない label だけ字数から自動で折り返す。
 */
function headlineColumns(label: string): string[][] {
  const parts = label.split(/\s+/u).filter((part) => part.length > 0)
  if (parts.length > 1) return parts.map((part) => Array.from(part))

  const chars = Array.from(parts[0] ?? '')
  if (chars.length <= HEADLINE_SINGLE_COLUMN_MAX) return [chars]
  const perColumn = Math.ceil(chars.length / 2)
  return [chars.slice(0, perColumn), chars.slice(perColumn)]
}

/**
 * 大書の組み方。句のように長い label でも必ず画面高に収まるよう、
 * 1 字の大きさは**いちばん長い列**から決める。Transition もこの結果を使って粒子の出所を決めるので、
 * 配置の計算はここ 1 箇所に集約する。
 */
export function headlineLayout(label: string): HeadlineLayout {
  const columns = headlineColumns(label)
  const longest = Math.max(...columns.map((column) => column.length))
  const size = Math.min(HEADLINE_SIZE, (VIEW_HEIGHT * 0.80) / longest)

  // いちばん長い列を画面の縦中央に置いたときの上端。全列がこの高さから書き出す
  const top = ((longest - 1) / 2) * size

  const chars: string[] = []
  const positions: [number, number, number][] = []
  columns.forEach((column, index) => {
    // 列は上で揃える。長さの違う列が並んでも書き出しの高さが動かない
    for (const [row, char] of column.entries()) {
      chars.push(char)
      positions.push([HEADLINE_X - index * size * HEADLINE_COLUMN_PITCH, top - row * size, 0])
    }
  })
  return { chars, positions, size }
}

/** 大書が占める左右の端（ワールド単位）。字面の外側まで含む */
function headlineEdges(label: string): { left: number; right: number } {
  const { positions, size } = headlineLayout(label)
  const leftmost = Math.min(...positions.map(([x]) => x))
  return { left: leftmost - size / 2, right: HEADLINE_X + size / 2 }
}

/**
 * L1 以降のカメラ x（＝パン）。
 *
 * 大書はワールドの右側に固定してあるので、画面が横に狭いとそのままでは右へはみ出す。
 * はみ出すぶんだけカメラを右へ送り、大書の右端に必ず `HEADLINE_MARGIN_PX` 相当の余白を残す。
 * 大書だけを左へ寄せるのではなく**視野ごと**送るので、大書と図の間隔（右から左への情報の流れ）は変わらない。
 * 収まる画面では 0 を返し、設計どおり図が画面中央に来る。
 */
export function nodePanX(label: string, halfWidth: number): number {
  if (halfWidth <= 0) return 0
  const margin = Math.min(HEADLINE_MARGIN_PX * unitsPerPixel(1), halfWidth * 2 * HEADLINE_MARGIN_MAX_RATIO)
  return Math.max(0, headlineEdges(label).right + margin - halfWidth)
}

/** 子の図の中心 x。左の解説と右の大書に挟まれた帯の中央に置く */
export const DIAGRAM_X = 0

/** 図の中の子ノード 1 つぶんの配置。位置は図の原点（`DIAGRAM_X`）からの相対 */
export interface DiagramItem {
  node: GraphNode
  position: [number, number]
  /** 字面の一辺 */
  size: number
  /** 角丸枠を持つか。枠の中は横組み、無いものは縦組みになる */
  frame: boolean
}

/** 円相レイアウトの外周の直径 */
export const CIRCLE_DIAMETER = VIEW_HEIGHT * 0.58

/**
 * 子の図の配置。
 *
 * 遷移で「子の字がそのまま次の見出しへ移る」ためには、Transition が描画とまったく同じ
 * 位置・大きさを引けなければならない。配置の数値はここ 1 箇所だけが持つ。
 */
export function diagramItems(node: GraphNode, children: GraphNode[]): DiagramItem[] {
  if (node.layout === 'circle') {
    const radius = CIRCLE_DIAMETER * 0.34
    return children.map((child, i) => {
      // 頂点付近から時計回りに 1 つずつ
      const angle = Math.PI / 2 - (i / children.length) * Math.PI * 2
      return {
        node: child,
        position: [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number],
        size: CIRCLE_DIAMETER * 0.17,
        frame: false,
      }
    })
  }

  if (node.layout === 'column') {
    const { pitch, size, top } = columnMetrics(children.length)
    return children.map((child, i) => ({
      node: child,
      position: [0, top - i * pitch] as [number, number],
      size,
      frame: true,
    }))
  }

  return []
}

/** 縦連結レイアウトの寸法。図の描画と連結線が同じ値を読む */
export function columnMetrics(count: number): { pitch: number; size: number; top: number } {
  const pitch = (VIEW_HEIGHT * 0.78) / Math.max(count, 1)
  return {
    pitch,
    size: Math.min(pitch * 0.42, VIEW_HEIGHT * 0.075),
    top: ((count - 1) / 2) * pitch,
  }
}

/** 角丸枠 1 つの寸法。枠線と当たり判定が同じ値を読む */
export function frameSize(chars: number, size: number): { width: number; height: number } {
  return { width: size * (chars * 1.05 + 1.6), height: size * 1.9 }
}

/** 子ノードの `index` 番目の字の、その子の中心からの相対位置 */
export function childCharOffset(index: number, count: number, size: number, frame: boolean): [number, number] {
  return frame
    ? // 枠の中は横組み。左から右へ読む
      [(index - (count - 1) / 2) * size * 1.08, 0]
    : // 図の中の縦組み。上から下へ読む
      [0, ((count - 1) / 2 - index) * size * 1.08]
}

/** 図が占める左端（ワールド単位）。図を持たないノードは null */
function diagramLeftEdge(node: GraphNode, children: GraphNode[]): number | null {
  if (node.layout === 'circle') return DIAGRAM_X - CIRCLE_DIAMETER / 2
  if (node.layout === 'column') {
    const items = diagramItems(node, children)
    const widest = Math.max(
      0,
      ...items.map((item) => frameSize(Array.from(labelText(item.node.label)).length, item.size).width),
    )
    return DIAGRAM_X - widest / 2
  }
  return null
}

/**
 * DOM オーバーレイの位置決めに使う目印。いずれも**画面の右端からの距離（px）**で返す。
 *
 * 読み・サマリー・本文は大書の実寸に合わせて置きたいが、大書は WebGPU レイヤーにあり
 * DOM からは測れない。だからカメラと同じ式（`nodePanX`）でワールド座標を画面座標へ直し、
 * CSS 変数として渡す。組版そのものは CSS 側の役目で、ここは目印を出すだけ。
 */
/**
 * 本文の左に残したい余白（px）。現在位置インジケータと重ねないための下限。
 * L1 以降のパンはここまで本文の左端を引き出せれば十分なので、可動域の基準にもなる。
 *
 * インジケータの幅ぶんではなく、読み切ったところで**空白が開く**だけ取る。
 * 最後の列まで送ったとき左に間ができて、そこにナビゲーションがあると気づける。
 */
export const DOC_EDGE_PX = 200

export interface OverlayInsets {
  /** 大書の右端。ここより右が読み（かな）の帯 */
  headlineRight: number
  /** 大書の左端。ここより左がサマリーと本文 */
  headlineLeft: number
  /** 図の左端。図を持たないノードでは大書の左端と同じ（本文への制約にならない） */
  diagramLeft: number
}

export function overlayInsets(
  node: GraphNode,
  children: GraphNode[],
  width: number,
  height: number,
): OverlayInsets {
  if (width <= 0 || height <= 0) return { headlineRight: 0, headlineLeft: 0, diagramLeft: 0 }
  const pixelsPerUnit = height / VIEW_HEIGHT
  const camera = nodePanX(node.label, halfWidthFor(width, height))
  // 画面右端からの距離。x = camera が画面中央に来る
  const insetOf = (x: number) => width / 2 - (x - camera) * pixelsPerUnit

  const edges = headlineEdges(node.label)
  const headlineLeft = insetOf(edges.left)
  const diagram = diagramLeftEdge(node, children)
  return {
    headlineRight: insetOf(edges.right),
    headlineLeft,
    diagramLeft: diagram === null ? headlineLeft : insetOf(diagram),
  }
}
