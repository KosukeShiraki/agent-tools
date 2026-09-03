# 17. 推移｜時系列と転換点

**使う場面**：いつから、どれだけ変化したかを示す。現状分析の起点に置く。
**要点**：**変化の起点に縦の破線と注記を入れる**。折れ線だけでは「下がっている」しか伝わらない。最終点のみアクセントにする。軸を切り出した場合は必ず注記に明記する（切り出し自体は可、黙るのが不可）。

**座標は手計算しない。** `python3 scripts/chart.py line --values 100,97,91,84 --labels 2022,2023,2024,2025 --mark 2 --mark-label "{転換点}" --unit "{単位}"` で下記と同じ座標系のスニペットが出る（棒は `bar`、強調する点は `--on`）。出力をそのまま `.fig` に貼り、注記の `{ }` を埋める。

座標系（固定・chart.py と同じ）：プロット領域は x=74〜1156、y=236（下端）〜26（上端）。値vのy座標は `y = 236 - (v - 最小値) × (210 / 目盛幅)`。点のx座標は `x = 106 + i × (1022 / (点数-1))`。

```html
<div class="chart">
<svg width="1176" height="270" viewBox="0 0 1176 270" aria-hidden="true">
  <!-- 目盛線と目盛ラベル（値ごとに1組） -->
  <line class="g" x1="74" y1="{y}" x2="1156" y2="{y}"/>
  <text class="tk" x="66" y="{y+3.5}" text-anchor="end">{目盛値}</text>
  <!-- 基準線 -->
  <line class="ax" x1="74" y1="236" x2="1156" y2="236"/>
  <!-- 転換点 -->
  <line class="mk" x1="{x}" y1="20" x2="{x}" y2="236"/>
  <text class="mkl" x="{x+8}" y="34">{転換点で何が起きたか}</text>
  <!-- 系列・点・値ラベル・軸ラベル -->
  <polyline class="ser" points="{x1},{y1} {x2},{y2} ..."/>
  <circle class="dot" cx="{x}" cy="{y}" r="4.5"/>           <!-- 最終点は class="dot on" -->
  <text class="vl" x="{x}" y="{y-13}" text-anchor="middle">{値}</text>   <!-- 最終点は class="vl on" -->
  <text class="xl" x="{x}" y="256" text-anchor="middle">{期間ラベル}</text>
</svg></div>
<p class="nt" style="width:1176px;margin:10px auto 0">{単位}。{軸の切り出しの明記}／{母数と期間}</p>
```
