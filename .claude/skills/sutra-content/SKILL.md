---
name: sutra-content
description: 深般若のコンテンツモデル（content/sutra.txt・graph/*.yaml・docs/*.md）を読み書きするときに使う。文字インデックス range、id 命名規約、label/reading の列の切れ目 `/`、ビルド時検証の条件を扱う。経文の字を増減する・ノードを足す・検証エラーを直す作業で必ず参照する。
---

# コンテンツモデル

グラフ構造は YAML、解説文は Markdown + frontmatter。**経文本文・解説文本文はすべてここに置き、コード側に埋め込まない。**
README・コード・コミットメッセージに複製しない。唯一の出所は `content/graph/*.yaml` の `summary` と `content/docs/*.md`。

## `content/sutra.txt`

全文のプレーンテキスト。**文字インデックスの唯一の基準**となるため、以下を厳守する。

- **改行は L0 の列の切れ目**として使う。1 行 = 1 列（現在 20 列）。1 行は `COLS_PER_LINE = 16`（`src/content/sutra.ts`）字以内に収める。この定数は 1 列に収まる字数の**上限**であって分割規則ではない。
- 行の途中に空白・約物を入れない（ローダが除去するため `range` はずれないが、その升は空かずに詰まる）。真言行の全角スペースは `content:validate` が警告 1 件として知らせる。
- **ローダが空白を除去して正規形を作り、`range` はその正規形に対する半開区間**。ファイルを手で整形しても `range` がずれないようにするための約束。
- 文字を追加・削除するとすべての `range` がずれるため、変更は `range` の一括見直しとセットで行う。行の追加・移動は `range` を動かさないが紙面の見え方を変える。
- 含まれる文字種は `assets/svg/` の 118 字に限る（ビルド時に検証）。在庫に無い字は、在庫のある異体字へ正規化する（`舍`→`舎`、`声`→`聲` はこの理由で置換済み。字数が変わらないので `range` はずれていない）。

## `content/graph/*.yaml`

```yaml
id: goun                 # 一意のスラッグ（ローマ字）
kind: term               # sutra | phrase | term
label: 五蘊              # 表示ラベル（大書に使う文字列）
reading: ごうん
sanskrit:
  text: pañca-skandha    # ラテン翻字
  kana: パンチャ・スカンダ
summary: …               # 右中段の短い定義（数十字）
parent: shoken-to-kaiku
children: [shiki-rupa, ju, so, gyo, shiki-vijnana]
related: [juuhachi-kai]  # 隣接ノード（将来用・UI 未設計）
layout: circle           # none | circle | column
range: [12, 17]          # 全文に対する文字インデックス範囲（半開区間 [start, end)）
audio: goun.m4a          # 読み上げ音源（assets/voice/ 配下のファイル名）
```

- **`layout` はノード側が持つ。** 円相か縦連結かは概念ごとに異なるため、描画側で決めない。

### 包含（`parent` / `children`）と隣接（`anchor` / `related`）

**関係の種類でエッジを選ぶ。深さの都合で選ばない。**

| | `parent` / `children` | `anchor` / `related` |
|---|---|---|
| 意味 | 包含・下位分類（「〜の一種」） | 同じ理論の中の別概念・相互参照 |
| 画面 | 子の図（`circle` / `column`）または大書の中 | 本文のさらに左に「関連語句」として散らす（→ `node-screen`） |
| 深度 | 1 段深くなる | **深くならない**（`anchor` と同じ層に居る） |
| 例 | 識 → 前五識、前五識 → 眼識 | 阿頼耶識 ⇄ 種子 ⇄ 薫習 ⇄ 現行、行 ⇄ 種子 |

```yaml
id: shuji
anchor: araya-shiki        # 帰属する層。parent と排他。これ自体が隣接エッジ 1 本になる
related: [kunju, genko, gyo]  # 横の線。片側にだけ書けばよい
layout: none               # 隣接ノードは子の図を持たない
```

- **`related` は向きを持たない。片側にだけ書く。** 逆向きは `loader.ts` の隣接表が張る（両側に手書きさせると片方が腐る）。
- `anchor` を持つノードは `parent`・`children` を持てず、`layout: none` に限る。`range` も持たない（経文に現れる語なら木の子として置く）。
- **同じ 2 ノードを包含と隣接の両方で結ばない。** どちらの関係なのかが曖昧になるので検証で落とす。
- 隣接ノードの `id` 命名は `term` と同じ（語の読み）。`docs/*.md` と `label` のグリフ在庫も同じく必須。
- URL と現在位置インジケータは `parent ?? anchor` を辿るので、隣接ノードもアンカーの経路の先に並ぶ。
  **深度としては数えない**が、経路は 1 つ伸びる。原稿の水準はアンカーに合わせる（→ `doc-writing`）。
- `label` に含まれる各文字は `assets/svg/` に対応する SVG が存在しなければならない。
- **`label` の `/` は大書の列の切れ目**（`headlineLayout`）。区切りを入れれば折り返し位置をコンテンツ側で決められ、入れなければ字数から自動で 1〜2 列に組む。字の大きさはいちばん長い列から決まる。`/` の前後の半角空白は読みやすさのために落ちるが、**列の中に空白は置けない**（スキーマが弾く。大書に空白のグリフは無い）。
- 列の切れ目は大書だけのもの。**字だけが要る場所は `labelText()` を通す**（`range` との突き合わせ・グリフ在庫の検査・図の中の子の組版・現在位置インジケータ）。
- **`reading` の列の切れ目も `/`**（`label` と同じ約束）。列の中の半角・全角スペースはそのまま出るので、読みの間合いに使える。

### `id` の命名規約

`id` は一意のスラッグ（ローマ字・小文字・ハイフン区切り）で、**ファイル名は `<id>.yaml` / `<id>.md` と一致させる**（`content/graph/` と `content/docs/` の両方）。

| `kind` | 形 | 例 |
|---|---|---|
| `sutra` | 経の名 | `shingyo` |
| `phrase` | **`<start>-to-<end>`** | `kanjizai-to-issaikuyaku` |
| `term` | 語そのものの読み | `goun`・`shiki-rupa` |

`phrase` の `start` / `end` は、その句の**先頭の語**と**末尾の語**の読みをローマ字にしたもの。
句は数文字から数十文字まで長さがまちまちで、`label` 全体をスラッグにすると破綻するため、両端で挟んで示す。
両端の語は文法上の切れ目で取る（`観自在菩薩` の `菩薩`、`度一切苦厄` の `度` のような接辞は落としてよい）。
句が短く両端が同じ語になる場合は `-to-` を使わず、その語の読みだけを `id` にする。

### `range` — 全文に対する文字インデックス範囲

- `content/sutra.txt` の正規形（空白除去後）の先頭を `0` とする**半開区間 `[start, end)`**。`end - start` が文字数になる。
- `kind: phrase` は必須。`kind: term` も、全文中に対応する連続文字列があれば持つ。
- 全文中に現れない概念ノード（`前五識`・`阿頼耶識` など、経文に登場しない用語）は `range` を**持たない**。`range` の有無が「格子上にハイライトできるか」を決める。
- ルート（`kind: sutra`）は `range: [0, <全文長>]` とする。

## `content/docs/*.md`

```markdown
---
id: goun
---

（長文解説の本文。DOM レイヤーで縦書き組版される）
```

## ビルド時検証（zod + 自作チェック）

`npm run content:validate`（`scripts/validate-graph.ts`）で落とすべき条件：

- `parent` / `children` / `related` の参照切れ
- 親子関係の非対称（`a.children` に `b` があるのに `b.parent` が `a` でない）
- 到達不能な孤立ノード
- `id` に対応する `docs/*.md` の欠落
- `label` の構成文字に対応する SVG の欠落
- `sutra.txt.slice(start, end) === labelText(label)`（`range` を持つノードのみ）
- 親が `range` を持つなら、子の `range` は親の範囲に**内包**されていること
- `range` が全文長を超えないこと
- **`layout: none` のノード（根を除く）の子が `range` を持つこと。** 図が無いノードの入口は大書の中なので（→ `node-screen`）、`range` を持たない子はどの字にも当たらず潜れなくなる
- **`term` が `layout: none` で子を持つ**場合のみ落とす
- `anchor` の参照切れ・自己参照、`anchor` を持つノードの `range`
- 同じ 2 ノードが包含（`parent`/`children`/`anchor`）と `related` の両方で結ばれていること
- 到達不能な孤立ノード（`children` に加えて `anchor` の辺も辿る。`related` だけで繋がったノードはどの層にも属さないので孤立とみなす）

### 検証で意図的にゆるめてある点

| 判断 | 理由 |
|---|---|
| **`layout: none` でも `phrase` は子を持ってよい** | `layout` が支配するのは「子の**関係図**」であって遷移そのものではない。初期スコープの経路自体が句 → 句の下降を含むため、ここで落とすと成立しない。図が無いノードでは**大書の中の子の範囲**が入口になる（→ `node-screen`） |
| **根（`kind: sutra`）は `range` と `label` を突き合わせない** | 根の `range` は全文を指すが、`label` は大書用の題名であって全文ではない |

## 現在のグラフ（21 ノード）

初期スコープは次の 1 経路。

```
般若心経 全文                                （L0 / kind: sutra）
  └─ 観自在菩薩行深般若波羅蜜時 …            （L1 / 句 / layout: none）
       └─ 照見五蘊皆空                        （L2 / 句 / layout: none）
            └─ 五蘊                           （L3 / 語 / layout: circle）
                 └─ 識                        （L4 / 語 / layout: column）
                      ├─ 前五識               （L5 / layout: circle）
                      │    └─ 眼耳鼻舌身識 5 ノード（L6 / layout: none）
                      ├─ 意識                 （L5 / layout: none）
                      ├─ 末那識               （L5 / layout: none）
                      └─ 阿頼耶識             （L5 / layout: none）
                           ┊ 種子・薫習・現行 （隣接 / anchor: araya-shiki）
```

隣接（`┊`）は深度を持たない。`種子` はさらに `行`（L4）とも横で結ばれており、木の枝をまたぐ線になっている。

**識の子は八識の四つの層**（前五識・意識・末那識・阿頼耶識）。眼耳鼻舌身の五識は前五識の下に置く。
`前五識`・`末那識`・`阿頼耶識` の字は `assets/svg/` に後から足したもの（`前`・`末`・`那`・`頼`・`耶`）。

深度が原稿の役割を決める（L1 簡訳 / L2 訳注 / L3 詳細な訳注 / L4 原義 / L5 教学 → `doc-writing`）。

## 関連

- 解説文と `summary` を深度ごとにどう書き分けるか → `doc-writing`
- L0 の格子座標と `range` のハイライト → `paper-grid`
- `label` / `reading` の列の切れ目が組版でどう効くか → `node-screen`
