/**
 * WebGPU レイヤー。
 *
 * Tier 1 / Tier 2 でのみマウントされる（Tier 3 は Canvas を一切作らない）。
 * WebGPURenderer は WebGPU が無ければ WebGL2 バックエンドへ落ちるので、
 * 2 つのティアで同じシーングラフ・同じ TSL ノードグラフが走る。
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import * as THREE from 'three/webgpu'
import { Paper } from './Paper.tsx'
import { NodeStage } from './NodeStage.tsx'
import { nodePanX } from '../world/node-layout.ts'
import { Transition, StageFade, TRANSITION_MS, ease } from './Transition.tsx'
import { loadGlyphs } from './glyphs.ts'
import { cappedDpr, measureFrameBudget } from './tier.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'
import {
  panXAtom,
  panYAtom,
  nodePanXAtom,
  zoomAtom,
  viewHalfWidthAtom,
  panBoundsFor,
  halfWidthFor,
  INITIAL_PAN_X,
} from '../world/pan.ts'
import { navAtom, particleScaleAtom, tierAtom } from '../nav/atoms.ts'
import { nodeById, root } from '../content/loader.ts'

/** 視野高を VIEW_HEIGHT / 拡大率 に保ち、パンと拡大をカメラへ反映する */
function CameraRig() {
  const camera = useThree((state) => state.camera) as THREE.OrthographicCamera
  const size = useThree((state) => state.size)
  const nav = useAtomValue(navAtom)
  const panX = useAtomValue(panXAtom)
  const panY = useAtomValue(panYAtom)
  const nodePan = useAtomValue(nodePanXAtom)
  const zoom = useAtomValue(zoomAtom)
  const halfWidth = useAtomValue(viewHalfWidthAtom)
  const setPan = useSetAtom(panXAtom)
  const setZoom = useSetAtom(zoomAtom)
  const setHalfWidth = useSetAtom(viewHalfWidthAtom)
  const target = useRef({ x: INITIAL_PAN_X, y: 0, zoom: 1 })
  const initialised = useRef(false)
  /** 最初のフレームで読み始めの位置へ飛ばしたか */
  const snapped = useRef(false)
  /** 遷移中のカメラの動き。開始時刻と出発点を握り、持ち越しの字と同じ尺で進める */
  const flight = useRef<{ at: number; x: number; y: number; zoom: number } | null>(null)

  // 画面に出したい紙面／大書は**行き先**のもの。遷移中に nav.nodeId（＝出発点）を見ると、
  // 演出のあいだカメラが出発点に据え置かれ、行き先へ動く字を画面の外へ置き去りにする
  const destinationId = nav.pendingId ?? nav.nodeId
  const toRoot = destinationId === root.id
  const transitioning = nav.phase === 'zooming-in' || nav.phase === 'zooming-out'

  // L1 以降のカメラ x。大書が画面の右へはみ出す幅の画面では、はみ出すぶんだけ右へ送る。
  // 大書の大きさは label の列組みで決まるので、行き先のノードから引く
  const nodeX = useMemo(() => {
    if (toRoot) return 0
    const destination = nodeById(destinationId) ?? root
    return nodePanX(destination.label, halfWidth)
  }, [toRoot, destinationId, halfWidth])

  useEffect(() => {
    // 可動域は画面のアスペクト比で変わる。リサイズのたびに引き直す
    setHalfWidth(halfWidthFor(size.width, size.height))
    // 読み始めは紙面の右上、すなわち第 1 列の先頭。
    // atom の初期値は窓の寸法から出してあるので、ここは Canvas の実測との差を詰めるだけ。
    // 補間を挟むと起動直後に紙面が横へ流れて見えるので、初回はカメラごと飛ばす
    if (initialised.current) return
    // 起動直後は等倍なので可動域は実測の半幅からそのまま出せる
    const start = panBoundsFor(halfWidthFor(size.width, size.height)).max
    initialised.current = true
    setPan(start)
    target.current.x = start
    camera.position.x = start
  }, [camera, size.width, size.height, setHalfWidth, setPan])

  // 潜るあいだは等倍へ戻す。L1 以降は拡大の概念を持たない
  useEffect(() => {
    if (!toRoot) setZoom(1)
  }, [toRoot, setZoom])

  // 遷移の始まりでカメラの出発点を控える。演出と同じ時刻から数え始めることが要点で、
  // 字が動き出してからカメラが追いかけると、そのぶん字が画面の端へ振れて見える
  useEffect(() => {
    if (!transitioning) {
      flight.current = null
      return
    }
    flight.current = {
      at: performance.now(),
      x: camera.position.x,
      y: camera.position.y,
      zoom: camera.zoom,
    }
  }, [transitioning, nav.pendingId, camera])

  useFrame((_, delta) => {
    // L0 ではパンと拡大に追従し、潜ったら等倍で行き先の構図へ戻る。
    // 遷移中は行き先の側の値を見る（根へ戻るなら送っていた位置、潜るなら大書が収まる位置）
    // L1 以降は基準の構図（nodeX）にドラッグのぶん（nodePan）を足す。左へ送ると
    // 画面の左へはみ出した本文が入ってくる
    target.current.x = toRoot ? panX : nodeX + nodePan
    target.current.y = toRoot ? panY : 0
    target.current.zoom = toRoot ? zoom : 1
    // 縦 16 升ぶんが等倍でちょうど画面高に収まる。はみ出すのは横方向のみ
    const targetZoom = (size.height / VIEW_HEIGHT) * target.current.zoom
    // 最初の 1 フレームだけは補間せず読み始めの位置へ置く。
    // 補間すると起動直後に紙面が中央から右へ流れて見える
    if (!snapped.current) {
      snapped.current = true
      camera.position.set(target.current.x, target.current.y, camera.position.z)
      camera.zoom = targetZoom
      camera.updateProjectionMatrix()
      return
    }
    const run = flight.current
    if (run) {
      // 遷移中は持ち越しの字と同じ時計・同じカーブで進める。ワールド座標の動きが揃うので、
      // 画面上でも字は出発点から行き先へまっすぐ動く
      const t = ease(Math.min(1, (performance.now() - run.at) / TRANSITION_MS))
      camera.position.x = run.x + (target.current.x - run.x) * t
      camera.position.y = run.y + (target.current.y - run.y) * t
      camera.zoom = run.zoom + (targetZoom - run.zoom) * t
      camera.updateProjectionMatrix()
      return
    }
    if (!toRoot) {
      // L1 以降のばねは atom（`useNodePanSpring`）が持つ。ここで重ねて補間すると
      // 大書だけが DOM の本文に遅れ、2 つの層がずれて見える
      camera.position.set(target.current.x, target.current.y, camera.position.z)
      if (Math.abs(targetZoom - camera.zoom) > 1e-4) {
        camera.zoom = targetZoom
        camera.updateProjectionMatrix()
      }
      return
    }
    // spring 相当の指数補間。フレームレートに依らないよう delta で減衰させる
    const k = 1 - Math.exp(-delta * 9)
    camera.position.x += (target.current.x - camera.position.x) * k
    camera.position.y += (target.current.y - camera.position.y) * k
    if (Math.abs(targetZoom - camera.zoom) > 1e-4) {
      camera.zoom += (targetZoom - camera.zoom) * k
      camera.updateProjectionMatrix()
    }
  })

  return null
}

/** 実測フレームタイムから粒子数の係数を決め、機種差を吸収する */
function FrameBudget() {
  const setScale = useSetAtom(particleScaleAtom)
  useEffect(() => measureFrameBudget(setScale), [setScale])
  return null
}

function SceneContent() {
  const nav = useAtomValue(navAtom)
  const showPaper = nav.nodeId === root.id
  return (
    <>
      <CameraRig />
      <FrameBudget />
      {showPaper ? <Paper /> : <NodeStage />}
      {/* 字の出入りは粒子と別勘定。Tier 3 でも尺を揃えるため Transition と分けて常に置く */}
      <StageFade />
      <Transition />
    </>
  )
}

export function Stage() {
  const [ready, setReady] = useState(false)
  const setTier = useSetAtom(tierAtom)
  useEffect(() => {
    loadGlyphs().then(() => setReady(true))
  }, [])

  if (!ready) return null

  return (
    <Canvas
      className="stage"
      orthographic
      // position の x は 0 のまま置く。r3f は原点を向く姿勢を初期に与えるので、
      // ここに読み始めの x を書くとカメラが斜めを向き、紙面が横に潰れる。
      // 読み始めの位置は CameraRig が最初のフレームで入れる
      camera={{
        position: [0, 0, 10],
        near: 0.1,
        far: 100,
        zoom: (globalThis.innerHeight || 0) / VIEW_HEIGHT || 40,
      }}
      dpr={cappedDpr()}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer(props as THREE.WebGPURendererParameters)
        await renderer.init()
        // navigator.gpu があってもアダプタが取れず WebGL2 バックエンドへ落ちることがある。
        // 粒子数はバックエンドの実態に合わせる必要があるので、init 後の結果でティアを訂正する
        const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined
        if (!backend?.isWebGPUBackend) setTier(2)
        return renderer
      }}
    >
      <Suspense fallback={null}>
        <SceneContent />
      </Suspense>
    </Canvas>
  )
}
