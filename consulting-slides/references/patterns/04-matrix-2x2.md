# 04. 2×2マトリクス｜ポジショニング

**使う場面**：選択肢や手法を2つの評価軸で整理し、推奨案が1つの象限に立つことを示す。
**要点**：推奨する象限のみ `.cell.on`（バーガンディ枠）。軸は「なぜその2軸なのか」が説明できるものにする。右カラムに「なぜこの軸が重要か」を3点置くと、図が主張になる。

```html
<div class="mx">
  <div class="vax"><span class="vt">{縦軸名}</span></div>
  <div>
    <div class="axl" style="margin-bottom:7px"><span>高：{意味}</span></div>
    <div class="g4">
      <div class="cell"><div class="h5">{左上}</div><p class="tx">{説明}</p><p class="nt" style="margin-top:8px">制約：{限界}</p></div>
      <div class="cell on"><div class="kk" style="color:var(--acc)">本提案</div><div class="h5" style="margin-top:6px">{右上＝推奨}</div><p class="tx">{説明}</p><p class="nt" style="margin-top:8px">制約：{限界}</p></div>
      <div class="cell"><div class="h5">{左下}</div><p class="tx">{説明}</p><p class="nt" style="margin-top:8px">制約：{限界}</p></div>
      <div class="cell"><div class="h5">{右下}</div><p class="tx">{説明}</p><p class="nt" style="margin-top:8px">制約：{限界}</p></div>
    </div>
    <div class="axl" style="margin-top:7px"><span>低：{意味}</span></div>
    <div class="hax"><span>{横軸の左端}</span><span class="ln"></span><span>{横軸の右端}</span></div>
  </div>
  <div>
    <div class="kk" style="margin-bottom:10px">{右カラムの問い}</div>
    <div class="side">
      <div class="it"><div class="h5">{論点1}</div><p class="tx">{説明}</p></div>
      <div class="it"><div class="h5">{論点2}</div><p class="tx">{説明}</p></div>
      <div class="it"><div class="h5">{論点3}</div><p class="tx">{説明}</p></div>
    </div>
  </div>
</div>
```
