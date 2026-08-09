# CLAUDE.md — 深般若（jin-hannya）

般若心経を「文字 → 句 → 語 → 構成要素」と潜っていくグラフィカル訳文兼辞書。
**README.md** がプロジェクトの概要と貫く方針、**観点ごとの設計は `.claude/skills/` の各 skill が正典**。
ここは毎回の起動時に要る情報だけを抜いた索引で、判断の根拠が要るときは下の対応表から該当 skill を読むこと。

| 観点 | skill |
|---|---|
| コンテンツモデル（`sutra.txt` / YAML / `range` / 検証） | `sutra-content` |
| 原稿の深度別の役割・語り口（L1 簡訳 → L4 原義 → L5 教学） | `doc-writing` |
| L0 の紙面・格子 | `paper-grid` |
| L1 以降の画面文法・3 レイアウト・`overlayInsets` | `node-screen` |
| 遷移演出（持ち越し・散開・凝集・尺） | `transition-fx` |
| パンと拡大 | `pan-zoom` |
| 色・墨・ゆらぎ・グロー・グリフ前計算 | `ink-visuals` |
| FSM・URL・インジケータ・左矢印 | `navigation-fsm` |
| 読破の記録（青白く灯る紙面） | `reading-progress` |
| 音 | `audio-design` |
| 2 レイヤー合成・性能ティア・技術スタック | `perf-tier` |

実装状況・未決事項は `docs/status.md`。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | コンテンツ JSON + グリフ前計算 → 開発サーバ（`content/` を監視し、YAML・MD の保存で JSON を作り直す） |
| `npm run host` | 同上を LAN に公開（実機確認用。WSL は `networkingMode=mirrored`） |
| `npm run build` | グラフ検証 → 前計算 → `tsc --noEmit` → `next build`（`out/` に静的出力） |
| `npm run preview` | `out/` を静的サーバで配信（本番挙動の確認） |
| `npm run content:validate` | `content/` の静的検証のみ |
| `npm run content:build` | 前計算のみ（`src/generated/` と `public/glyphs/` `public/glyph-svg/` `public/audio/` を出す） |
| `npm run typecheck` | `tsc --noEmit` |

- `content/*.yaml` `*.md` `sutra.txt` の保存は `src/generated/content.json` の作り直し（`scripts/watch-content.ts`）を経て HMR に乗る。**`assets/` の SVG・音源はグリフ前計算が要るので監視の外**（`npm run content:build` を打ち直すか dev を立て直す）。
- テストランナーは無い。検証は `content:validate` と型検査、あとは画面で確認する。
- `src/generated/` と `public/glyphs/` `public/glyph-svg/` `public/audio/` は**生成物でコミットしない**（`.gitignore` 済み）。clone 直後や生成物が無い状態では `npm run content:build` を先に走らせる。

## スタック

Next.js 16（App Router、`output: 'export'`）+ TypeScript + React 19 / @react-three/fiber v9 / three 0.185（`WebGPURenderer` + TSL）/ Jotai / motion / zod。
SSR 無し・全ルート SSG・静的ホスティング前提。`drei` は使わない（WebGL 前提のコンポーネントが混ざるため）。

## 構成の要点

```
app/        layout.tsx(アプリ本体を全ルートで永続) AppShell.tsx(ssr:false の境界)
            page.tsx / [...path]/page.tsx(metadata・generateStaticParams だけを担う空ページ)
src/
  scene/    Stage.tsx(Canvas+ティア訂正) Paper.tsx(L0格子) NodeStage.tsx(L1以降/3レイアウト)
            Transition.tsx(遷移演出) Particles.tsx glyphs.ts tier.ts materials.ts
  overlay/  Overlay.tsx PaperFallback.tsx SpeakButton.tsx AudioControls.tsx LeftArrow.tsx
  nav/      fsm.ts atoms.ts router.ts(useRouteSync) url.ts(id⇄パスの写像・初期ノード)
  content/  schema.ts loader.ts sutra.ts source.ts(生成 JSON への唯一の入口)
  world/    paper.ts(格子寸法・index→(column,row)) pan.ts(可動域・ドラッグ・拡大)
            node-layout.ts(L1 以降の大書・図の寸法／DOM 用の目印 overlayInsets)
  audio/    index.ts
scripts/    build-content.ts(YAML/MD→content.json・assets を public/ へ)
            build-glyphs.ts svg-path.ts sdf.ts(グロー用距離場) validate-graph.ts
content/    sutra.txt / graph/*.yaml / docs/*.md
assets/     svg/(筆文字127) pattern/circle.svg bgm/ sfx/ voice/(未収録)
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
- **面の用意をやり直さない。** 紙面は畳まず（潜っている間は描かず・計算せず・当たり判定にも出さないだけ）、マテリアルは紙面で 1 本。マウントし直すと 90 字ぶんの用意を 1 フレームで払って固まる。遷移中に固まったり固まらなかったりしたら、まずマテリアルを作り直している所を疑う（TSL の吐くソースが毎回変わり、プログラムキャッシュに当たらない）。同じ理由で**アプリ本体は `app/layout.tsx` に置く**。page 側に置くとルート遷移のたびに再マウントされる。
- **URL は実パス、history は Next に任せる。** 自前の pushState はしない。潜る・戻るとも idle で `router.push`、ブラウザバックは pathname の変化として演出付きで取り込む。初期ノードは atom 初期値が URL から引く（→ skill: `navigation-fsm`）。
- 遷移中の濃さは**深度ごとに 1 本ずつ**（`paperOpacity` / `nodeOpacity`）。戻りぎわは大書と紙面が同時に画面へ居る。
- `layout`（`none` / `circle` / `column`）は**ノード側の YAML が持つ**。描画側で決めない。
- **エッジは関係の種類で選ぶ。深さの都合で選ばない。** 包含は `parent`/`children`（図に出る・1 段深くなる）、隣接は `anchor`/`related`（関連語句として本文の左に散る・深度は増えない）。`related` は向きを持たないので片側にだけ書き、逆向きはローダの隣接表が張る。関連語句の散らし位置は `id` から引く（実行のたびに振り直すと、戻ったとき同じ語を掴み直せない）。
- `label` の `/` は**大書の列の切れ目**（`headlineLayout`）。列の中に空白は置けない。字だけが要る場所は `labelText()` を通す（`range` の突き合わせ・グリフ在庫・図の中の子・現在位置インジケータ）。
- `reading` の切れ目も **`/`**（`label` と同じ約束。列の中の空白はそのまま出る）。読みは大書の右、サマリーは大書の左、本文はさらにその左に置く。x は `overlayInsets()` が出す 3 つの目印（大書の左右端・図の左端）から CSS が組むので、間合いを変えるときは `.overlay` の `--reading-gap` / `--summary-gap` / `--doc-gap` を触る。
- パンは深度で別勘定。L0 は `panXAtom`（＋拡大・縦送り）、**L1 以降は `nodePanXAtom` の左右だけ**。L1 以降のばねは atom 側に 1 つだけ置き、カメラは値をそのまま読む（カメラでも補間すると大書が DOM の本文に遅れてずれる）。本文は `max-width` で切り詰めず、はみ出したぶんはパンで補う。可動域は本文・サマリーの `offsetLeft` の実測から引く。
- 円相は `assets/pattern/circle.svg` を使う。手続き的生成はしない。断片パス約 40 本も間引かない。
- 色は `src/scene/materials.ts` と `src/styles.css` のトークンから引く。有彩色は**琥珀（`--focus`）と青白（`--visited`）の 2 つだけ**で、これ以上足さない。琥珀 = いま触れている一時的な状態、青白 = もう下りた残り続ける痕跡（→ skill: `reading-progress`）。
- **読破の判定はグラフから導く。YAML に完了条件の鍵を書かない。** 「L3（`READ_DEPTH`）まで下りたら読破、枝が浅ければその最深に丸める」で、深さの違いはグラフが既に持っている。保存するのは訪れた id だけで、読破したかどうかは保存しない。

## 既知の落とし穴（実装時に踏んだもの）

- `navigator.gpu` があってもアダプタが無い環境がある。**`renderer.init()` 後に実バックエンドを見てティアを訂正する**。
- hover 発光に `instanceColor` は使わない（`WebGPURenderer` のノードマテリアル経路で効かない）。インスタンス属性 + TSL で書く。
- 当たり判定用オブジェクトを `visible={false}` にしない（レイキャスト対象から外れる）。透明マテリアルで置く。
- ドラッグの `setPointerCapture` は `pointerdown` 即時ではなく **6px 動いてから**（即時だとクリックが成立しない）。
- 紙面の可動域は**ビューポート依存**。縦長スマホでは必ず左へはみ出し、16:9 PC では収まる。定数化せずリサイズごとに実測する。
- `router.push` は**非同期**で、`usePathname` への反映まで数フレームの窓がある。push したパスを控えずに pathname とだけ突き合わせると、窓の間の再実行で外部遷移と誤認して逆再生が起きる（`useRouteSync` の `pushing` ref。→ skill: `navigation-fsm`）。

## いまの状態（詳細は `docs/status.md`）

- `npm run build` は通り、`out/` に全ルートの静的 HTML（title / description / OGP 付き）が出る。確認環境は headless Chromium（Tier 2 / WebGL2）1440x810。
- **Next.js 化済み（2026-08-09）。** 実パスルーティング・深いパスの直接ロード・ブラウザバック／フォワードの演出付き同期を headless と実機ブラウザで確認。OGP 画像（`opengraph-image`）は未着手。
- **遷移演出は繋がった。** 持ち越し字の連続移動も粒子も出る（点サイズは `Sprite` のインスタンシングで解決）。残るのは値の詰めと Tier 1 実機での見え方。
- L1 以降の左右パンは 900x700 の画面で確認済み（GPU レイヤーと DOM が同じばねで動く）。
- 未確認: BGM / SFX / ダッキング、Tier 3 の `PaperFallback`、**L0 の**パン同期（16:9 では紙面が収まりパンが起きない）、ホイール／ピンチ拡大、`column` の hover グロー、読み上げ（音源未収録）。
- 未決: BGM 配信方式（案 A 短尺ループ全長デコード / 案 B 2 要素クロスフェード。**現状は案 B 既定**、`BGM_STRATEGY` 1 定数で切替）、字の大きさの実機基準。
- 完了条件のチェックは**画面で確認できたものだけ**に付ける。実装しただけのものは外したまま「実装済みだが未確認」に書く。
