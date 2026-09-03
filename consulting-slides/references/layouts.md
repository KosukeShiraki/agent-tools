# 図解パターン索引

各パターンは `.fig` の中に置く。**このファイルは索引と共通ルールだけ**で、各パターンの使う場面・要点・HTMLスニペットは `patterns/NN-*.md` に1パターン1ファイルで置いてある。

**選び方：まず「このページの論理構造は何か」を1つに決め、下表から対応するパターンを1つだけ選ぶ。** 2つ以上を1ページに混ぜない。
**読み方：全ファイルを読まない。** ストーリーラインで決めたパターンのファイルだけを Read する（10枚の資料なら通常5〜8ファイル）。

| 伝えたい論理構造 | # | パターン | ファイル |
|---|---|---|---|
| なぜ起きているか（因果） | 1 | 因果連鎖 | `patterns/01-causal-chain.md` |
| 1つの問題が何に分かれるか（分解） | 2 | Issue Tree | `patterns/02-issue-tree.md` |
| 数値が何で動いたか（加算分解） | 3 | ウォーターフォール | `patterns/03-waterfall.md` |
| 2軸のどこに位置するか（位置づけ） | 4 | 2×2マトリクス | `patterns/04-matrix-2x2.md` |
| 何を変えるべきか（転換） | 5 | Before → After | `patterns/05-before-after.md` |
| どう進めるか（順序） | 6 | プロセス3層 | `patterns/06-process.md` |
| 課題にどう対処するか（対策） | 7 | 課題 → 対応策 → 効果 | `patterns/07-issue-action-effect.md` |
| 資料全体で何を言うか（要約） | 8 | 問い → 答え | `patterns/08-question-answer.md` |
| 何を決めてほしいか（意思決定） | 9 | 決定事項＋ガント | `patterns/09-decision-gantt.md` |
| 仕組みはどう動くか（機序） | 10 | 入力 → 処理 → 出力 | `patterns/10-input-process-output.md` |
| どの案を選ぶか（比較） | 11 | 比較表 | `patterns/11-comparison-table.md` |
| なぜ解決しないのか（循環） | 12 | 循環構造 | `patterns/12-loop.md` |
| どこに接続しているか（階層） | 13 | 上位 → 下位 | `patterns/13-hierarchy.md` |
| 通説は正しいのか（検証） | 14 | 仮説 → 分析 → 示唆 | `patterns/14-hypothesis-analysis.md` |
| 何に波及するか（展開） | 15 | ハブ＆スポーク | `patterns/15-hub-spoke.md` |
| なぜその結論なのか（収束） | 16 | 複数要因 → 結論 | `patterns/16-convergence.md` |
| いつから変わったか（推移） | 17 | 時系列と転換点 | `patterns/17-time-series.md` |
| どこに偏っているか（構成比） | 18 | 100％積み上げ帯 | `patterns/18-stacked-bar.md` |
| どの変数を動かすか（数式分解） | 19 | KPIツリー | `patterns/19-kpi-tree.md` |
| どこで止まっているか（業務の流れ） | 20 | スイムレーン | `patterns/20-swimlane.md` |
| 前提が変わると結果はどうなるか | 21 | シナリオ分析 | `patterns/21-scenario.md` |
| 全体をどう進めるか（中長期） | 22 | ロードマップ | `patterns/22-roadmap.md` |
| 誰がやるのか（体制） | 23 | 体制図 | `patterns/23-org-chart.md` |
| なぜそう言えるのか（論証） | 24 | ピラミッド | `patterns/24-pyramid.md` |

**全24パターンの実物は `pattern-catalog.html` にある**（1ページ1パターン、同一の架空事例で統一）。構図を目で確かめたいときは `scripts/render.py references/pattern-catalog.html --pages 18` のように該当ページだけPNG化して Read する（表紙が p01 なので、パターン#Nは p(N+1)）。
`example-deck.html` は、パターン1〜10を実際のストーリーの中で使った完成資料の例。

---

## 共通の注意

- 矢印は `.ar`（横）と `.ard`（縦）のみ。グリッドセル内で使うときは `<div style="display:flex;align-items:center;justify-content:center">` で包む。
- ボックス内の文章は1〜2行。長い説明は `.nt` でボックスの外に小さく置く。
- 同じレベルの概念は、フォントサイズ・箱サイズ・位置を揃える。
- 図の高さの目安は約430px（`.fig` の実効高）。超えると上下の要素に重なる。`render.py` が `FIG_OVERFLOW` として検出するので、出たら行間・パディングを詰めるか情報を減らす。
- SVGを使うパターン（2・12・15・16・17・19・20・23・24）は、**幅1176px（＝1280 − 左右マージン52px×2）を前提に座標を固定**している。要素数や箱のサイズを変える場合は、SVGのパス座標も合わせて計算し直す。
- **折れ線・棒グラフ（#17）は座標を手計算せず `scripts/chart.py` で生成する。** 値と期間ラベルを渡すとスニペットが出る。
- `.chip` をフレックスの子として置く場合、`align-self:flex-start` が効いて横幅いっぱいに伸びない（CSS側で対応済み）。
- **CSSの扱い**：`<style>` 内の既存ルールとトークンは書き換えない。調整は要素の `style=""` による上書きか、`<style>` 末尾への**新しいクラスの追記**で行う。
- **既存クラス名との衝突に注意する。** 新しい構図を作るときは、`row`、`bar`、`hd`、`op`、`on` など既存の短いクラス名を再利用しない。衝突すると `width` や `flex` を継承して要素が潰れる。
