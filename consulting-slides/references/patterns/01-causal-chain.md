# 01. 因果連鎖｜原因 → 問題 → 結果

**使う場面**：なぜその問題が起きているのか、放置すると何が失われるのかを一続きで示す。
**要点**：中央の「問題」を1つに絞り `.bx.s` ＋ `border-color:var(--acc)` で最も強く。左は技術的・構造的な原因、右は事業上の損失。粒度を揃える。

```html
<div class="czh"><span>原因：{分類名}</span><span class="gap"></span><span>問題：{分類名}</span><span class="gap"></span><span>結果：{分類名}</span></div>
<div class="cz">
  <div class="col">
    <div class="bx"><div class="h5">{原因1}</div><p class="tx">{補足}</p></div>
    <div class="bx"><div class="h5">{原因2}</div><p class="tx">{補足}</p></div>
  </div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx s" style="padding:22px 18px;border-color:var(--acc)">
    <div class="kk" style="margin-bottom:8px;color:var(--acc)">CORE ISSUE</div>
    <div class="h4">{中核の問題を<br>3行以内で}</div><p class="tx">{補足}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="col">
    <div class="bx g"><div class="h5">{結果1}</div><p class="tx">{補足}</p></div>
    <div class="bx g"><div class="h5">{結果2}</div><p class="tx">{補足}</p></div>
    <div class="bx g"><div class="h5">{結果3}</div><p class="tx">{補足}</p></div>
  </div>
</div>
```
