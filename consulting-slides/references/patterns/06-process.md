# 06. プロセス｜工程 → 価値 → 期間（3層）

**使う場面**：実行計画を示し、各工程が単独で価値を生むことを示す。
**要点**：工程は4つまで。各工程の下に「その工程が生む価値」を必ず置く（置けない工程は工程ではない）。転換点になる工程の価値ボックスにのみアクセントの左罫を入れる。

```html
<div class="pr" style="row-gap:20px">
  <div class="rl">工程</div>
  <div class="pcols">
    <div class="st"><span class="kk">STEP 01</span><div class="h5">{工程名}</div><p class="tx">{内容}</p><i class="tip"></i></div>
    <!-- STEP 02〜04 も同形。最後の要素の tip / ::after は自動で消える -->
  </div>
  <div class="rl">この工程が<br>生む価値</div>
  <div>
    <div class="drops"><div class="ard"></div><div class="ard"></div><div class="ard"></div><div class="ard"></div></div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);column-gap:30px">
      <div class="bx g"><div class="h5">{価値}</div><p class="tx">{説明}</p></div>
      <div class="bx g" style="border-left:3px solid var(--acc)"><div class="h5">{転換点の価値}</div><p class="tx">{説明}</p></div>
      <!-- 残り2つ -->
    </div>
  </div>
  <div class="rl">期間</div>
  <div class="tl">
    <div class="seg">Day 1 – 15</div><div class="seg">Day 16 – 45</div><div class="seg">Day 46 – 75</div><div class="seg">Day 76 – 90</div>
  </div>
</div>
```
