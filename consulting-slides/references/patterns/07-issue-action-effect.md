# 07. 課題 → 対応策 → 効果（3列 × 3行）

**使う場面**：限界・リスクを先に開示し、運用で管理できることを示す。
**要点**：1行につき1論点。効果の列は `.bx.s`（ネイビー枠）で1行に収め、「それにより得られる状態」を書く。対応策が課題に対応していない行を作らない。

```html
<div class="cae">
  <div class="hd2"></div><div class="hd2">論点</div><div class="hd2"></div><div class="hd2">対応策</div><div class="hd2"></div><div class="hd2">それにより得られる状態</div>
  <div class="no">01</div>
  <div class="bx c"><div class="h5">{課題}</div><p class="tx">{補足}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx c g"><div class="h5">{対応策}</div><p class="tx">{具体化}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx c s"><div class="h5">{効果}</div></div>
  <!-- 02, 03 も同形 -->
</div>
```
