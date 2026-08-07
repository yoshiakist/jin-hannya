/**
 * WebGPU レイヤー。
 *
 * Tier 1 / Tier 2 でのみマウントされる（Tier 3 は Canvas を一切作らない）。
 * WebGPURenderer は WebGPU が無ければ WebGL2 バックエンドへ落ちるので、
 * 2 つのティアで同じシーングラフ・同じ TSL ノードグラフが走る。
 */

import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import * as THREE from 'three/webgpu'
import { Paper } from './Paper.tsx'
import { NodeStage } from './NodeStage.tsx'
import { Transition, StageFade } from './Transition.tsx'
import { loadGlyphs } from './glyphs.ts'
import { cappedDpr, measureFrameBudget } from './tier.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'
import {
  panXAtom,
  panYAtom,
  zoomAtom,
  viewHalfWidthAtom,
  panBoundsFor,
  halfWidthFor,
  INITIAL_PAN_X,
} from '../world/pan.ts'
import { navAtom, isRootAtom, particleScaleAtom, tierAtom } from '../nav/atoms.ts'
import { root } from '../content/loader.ts'

/** 視野高を VIEW_HEIGHT / 拡大率 に保ち、パンと拡大をカメラへ反映する */
function CameraRig() {
  const camera = useThree((state) => state.camera) as THREE.OrthographicCamera
  const size = useThree((state) => state.size)
  const panX = useAtomValue(panXAtom)
  const panY = useAtomValue(panYAtom)
  const zoom = useAtomValue(zoomAtom)
  const setPan = useSetAtom(panXAtom)
  const setZoom = useSetAtom(zoomAtom)
  const setHalfWidth = useSetAtom(viewHalfWidthAtom)
  const isRoot = useAtomValue(isRootAtom)
  const target = useRef({ x: INITIAL_PAN_X, y: 0, zoom: 1 })
  const initialised = useRef(false)
  /** 最初のフレームで読み始めの位置へ飛ばしたか */
  const snapped = useRef(false)

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
    if (!isRoot) setZoom(1)
  }, [isRoot, setZoom])

  useFrame((_, delta) => {
    // L0 ではパンと拡大に追従し、潜ったら中央・等倍へ戻る
    target.current.x = isRoot ? panX : 0
    target.current.y = isRoot ? panY : 0
    target.current.zoom = isRoot ? zoom : 1
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
