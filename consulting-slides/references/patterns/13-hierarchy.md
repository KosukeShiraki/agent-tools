# 13. 階層｜上位概念 → 下位概念

**使う場面**：目的・戦略・施策のように、抽象度の異なる階層が接続していることを示す。
**要点**：上位は1つ、下に行くほど数が増える（1 → 2 → 4）。**下位の各要素に「どの上位に紐づくか」を明記する**（紐づけを書けない要素は載せない）。最上位のみ `band s`（2px枠）で強調する。層は3つまで。

```html
<div class="lay">
  <div class="lb">上位<br>目的</div>
  <div class="band s"><div><div class="h5">{目的}</div><p class="tx">{位置づけ}</p></div></div>
  <div></div><div class="ldrop"><div class="ard"></div></div>
  <div class="lb">中位<br>戦略</div>
  <div class="band" style="grid-template-columns:repeat(2,1fr)">
    <div><div class="h5">{戦略1}</div><p class="tx">{指標}</p></div>
    <div><div class="h5">{戦略2}</div><p class="tx">{指標}</p></div>
  </div>
  <div></div><div class="ldrop"><div class="ard"></div></div>
  <div class="lb">下位<br>施策</div>
  <div class="band" style="grid-template-columns:repeat(4,1fr)">
    <div><div class="h5">{施策1}</div><p class="tx">上位戦略：{紐づけ}</p></div>
    <!-- 施策2〜4 -->
  </div>
</div>
```
