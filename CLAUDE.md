# CLAUDE.md — 深般若（jin-hannya）

般若心経を「文字 → 句 → 語 → 構成要素」と潜っていくグラフィカル訳文兼辞書。
**設計の正典は `README.md`。** ここは毎回の起動時に要る情報だけを抜いた索引で、判断の根拠が要るときは README の該当節を読むこと。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | グリフ前計算 → 開発サーバ |
| `npm run build` | グラフ検証 → グリフ前計算 → `tsc --noEmit` → 本番ビルド |
| `npm run content:validate` | `content/` の静的検証のみ |
| `npm run content:build` | グリフ前計算のみ（`src/generated/` と `public/glyphs/` を出す） |
| `npm run typecheck` | `tsc --noEmit` |

- テストランナーは無い。検証は `content:validate` と型検査、あとは画面で確認する。
- `src/generated/` と `public/glyphs/` は**生成物でコミットしない**（`.gitignore` 済み）。clone 直後や生成物が無い状態では `npm run content:build` を先に走らせる。

## スタック

Vite 8 + TypeScript + React 19 / @react-three/fiber v9 / three 0.185（`WebGPURenderer` + TSL）/ Jotai / motion / zod。
SSR 無し・静的ホスティング前提。`drei` は使わない（WebGL 前提のコンポーネントが混ざるため）。

## 構成の要点

```
src/
  scene/    Stage.tsx(Canvas+ティア訂正) Paper.tsx(L0格子) NodeStage.tsx(L1以降/3レイアウト)
            Transition.tsx(遷移演出) Particles.tsx glyphs.ts tier.ts materials.ts
  overlay/  Overlay.tsx PaperFallback.tsx SpeakButton.tsx AudioControls.tsx LeftArrow.tsx
  nav/      fsm.ts atoms.ts router.ts
  content/  schema.ts loader.ts sutra.ts
  world/    paper.ts(格子寸法・index→(column,row)) pan.ts(可動域・ドラッグ・拡大)
  audio/    index.ts
scripts/    build-glyphs.ts svg-path.ts sdf.ts(グロー用距離場) validate-graph.ts
content/    sutra.txt / graph/*.yaml(15) / docs/*.md(15)
assets/     svg/(筆文字118) pattern/circle.svg bgm/ sfx/ voice/(未収録)
```

**2 レイヤー合成: 組版は DOM、絵は GPU。** 縦組みの長文は `writing-mode: vertical-rl` の DOM オーバーレイ、
筆文字グリフ・粒子・ゆらぎ・発光・描線は WebGPU レイヤー。パンは 1 つの atom に集約し、カメラと CSS 変数 `--pan-px` が同じ値を読む。

## 触るときの固定事項

- **経文本文・解説文をコードや README、コミットメッセージに複製しない。** 出所は `content/graph/*.yaml` の `summary` と `content/docs/*.md` だけ。
- **`COLS_PER_LINE = 16`**（`src/content/sutra.ts`）は 1 列に収まる字数の**上限**。L0 の列の切れ目は `content/sutra.txt` の**改行位置**に従う（1 行 = 1 列、20 列）。格子座標は割り算で求めず `GRID_CELLS` / `cellOf()` / `indexAt(column, row)` を引く。
- `content/sutra.txt` は**文字インデックスの唯一の基準**。ローダが空白を除去して正規形を作り、`range` はその正規形に対する半開区間 `[start, end)`。文字の増減は全 `range` の見直しとセット。行の追加・移動は `range` を動かさないが紙面の見え方を変える。
- **ランタイムで SVG を触らない。** メッシュ・粒子サンプル・グロー用の符号付き距離場はビルド時に `scripts/build-glyphs.ts` が前計算する。
- 発光の滲みは**字ごとの距離場**（`createGlowMaterial`）で出す。板の中心から放射させると、どの字でも同じ丸い光になる。
- 用語を混ぜない: **深度** `L0/L1/L2…`（ユーザーの階層）と **性能ティア** `Tier 1(WebGPU)/2(WebGL2)/3(WebGL不可)`（描画能力）。「Tier」は性能の話にのみ使う。
- 遷移は相を持つ FSM（`idle → hovered → zooming-in → focused → zooming-out`）。`zooming-*` の間は入力を殺す。
- 演出は**潜ると戻るで非対称**。潜る = 非フォーカス字が散開・生存字はメッシュのまま連続移動／戻る = 現在字が再配置されつつ粒子がフェードインして凝集。逆再生にはしない。
- `layout`（`none` / `circle` / `column`）は**ノード側の YAML が持つ**。描画側で決めない。
- `label` の空白・改行は**大書の列の切れ目**（`headlineLayout`）。字だけが要る場所は `labelText()` を通す（`range` の突き合わせ・グリフ在庫・図の中の子・現在位置インジケータ）。
- 円相は `assets/pattern/circle.svg` を使う。手続き的生成はしない。断片パス約 40 本も間引かない。
- 色は `src/scene/materials.ts` と `src/styles.css` のトークンから引く。琥珀（`--focus`）以外の有彩色を足さない。

## 既知の落とし穴（実装時に踏んだもの）

- `navigator.gpu` があってもアダプタが無い環境がある。**`renderer.init()` 後に実バックエンドを見てティアを訂正する**。
- hover 発光に `instanceColor` は使わない（`WebGPURenderer` のノードマテリアル経路で効かない）。インスタンス属性 + TSL で書く。
- 当たり判定用オブジェクトを `visible={false}` にしない（レイキャスト対象から外れる）。透明マテリアルで置く。
- ドラッグの `setPointerCapture` は `pointerdown` 即時ではなく **6px 動いてから**（即時だとクリックが成立しない）。
- 紙面の可動域は**ビューポート依存**。縦長スマホでは必ず左へはみ出し、16:9 PC では収まる。定数化せずリサイズごとに実測する。

## いまの状態（詳細は README「実装状況」）

- `npm run build` は通る。確認環境は headless Chromium（Tier 2 / WebGL2）1440x810。
- **残作業の本体は遷移演出。** 相の管理と粒子データまではあるが、生存字の連続移動が繋がっておらず（`Transition.tsx` の `visibleGlyphs()` から spring 補間へ）、粒子が画面に出ない（`PointsNodeMaterial` の点サイズを疑っている）。
- 未確認: BGM / SFX / ダッキング、Tier 3 の `PaperFallback`、パン同期、ホイール／ピンチ拡大、`column` の hover グロー、読み上げ（音源未収録）。
- 未決: BGM 配信方式（案 A 短尺ループ全長デコード / 案 B 2 要素クロスフェード。**現状は案 B 既定**、`BGM_STRATEGY` 1 定数で切替）、字の大きさの実機基準。
- 完了条件のチェックは**画面で確認できたものだけ**に付ける。実装しただけのものは外したまま「実装済みだが未確認」に書く。
