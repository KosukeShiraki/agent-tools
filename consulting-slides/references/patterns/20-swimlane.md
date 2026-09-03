# 20. 業務フロー｜スイムレーン

**使う場面**：部門をまたぐ業務の流れと、**どこで滞留しているか**を示す。「誰の問題でもない状態」の可視化に使う。
**要点**：レーンは4つ・工程は5つまで。滞留点のみ `st acc`（アクセント枠）。各工程に所要日数や工数比などの実測値を添える。接続線のSVGは固定座標に依存するため、レーン数・工程数を変える場合は下記の式で再計算する。

座標系：列幅 `CW = (1176 - 118) / 工程数`、列の左端 `colX(i) = 118 + CW × i`、箱の左右は `colX+20` と `colX+CW-20`、レーンjの中心は `y = 30 + 78j + 39`。

```html
<div class="swim">
  <div class="grid">
    <div class="hd c0"></div><div class="hd">① {工程}</div><div class="hd">② {工程}</div><!-- … -->
    <div class="ln">{レーン名}</div>
    <div class="cl"><div class="st">{作業}<span class="sb">{実測値}</span></div></div>
    <div class="cl"></div><!-- 空セルも必ず置く -->
    <!-- レーンごとに（ラベル1つ＋工程数分のセル） -->
  </div>
  <svg class="ov" width="1176" height="342" viewBox="0 0 1176 342" aria-hidden="true">
    <defs><marker id="swa" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0,0 9,3.5 0,7" fill="#12395b"/></marker></defs>
    <path d="M{x1} {y1} H{中間点} V{y2} H{x2-2}" fill="none" stroke="#12395b" marker-end="url(#swa)"/>
  </svg>
</div>
<p class="nt" style="width:1176px;margin:14px auto 0">赤枠＝滞留点。{そこで何が起きているか}</p>
```
