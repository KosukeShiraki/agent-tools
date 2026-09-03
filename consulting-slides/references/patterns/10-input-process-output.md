# 10. 入力 → 処理 → 出力

**使う場面**：手法や仕組みの原理を1行で示す。単独でも、パターン3の上段としても使う。
**要点**：中央の「処理」だけ `.bx.s`。3つの箱の粒度を揃える。

```html
<div class="flow3">
  <div class="bx"><div class="kk">INPUT</div><div class="h5" style="margin-top:6px">{入力}</div><p class="tx">{内訳}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx s"><div class="kk">PROCESS</div><div class="h5" style="margin-top:6px">{処理}</div><p class="tx">{何をしているか}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx"><div class="kk">OUTPUT</div><div class="h5" style="margin-top:6px">{出力}</div><p class="tx">{性質}</p></div>
</div>
```
