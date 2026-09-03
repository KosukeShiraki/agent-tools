# 14. 仮説 → 分析 → 示唆

**使う場面**：現場の認識や通説を仮説に分解し、データで検証した結果と、そこから導かれる行動を示す。
**要点**：グリッドはパターン7と共通（`.cae`）。**中央のセルには必ず判定チップと定量的な結果を入れる**（`chip f`＝支持／`chip`＝一部支持／`chip a`＝棄却）。検証方法（母数・期間・手法）を `.tx` に書き、事実と解釈を分離する。棄却された仮説を必ず1つは載せると、検証の客観性が伝わる。

```html
<div class="cae">
  <div class="hd2"></div><div class="hd2">仮説</div><div class="hd2"></div><div class="hd2">分析（検証方法と結果）</div><div class="hd2"></div><div class="hd2">示唆</div>
  <div class="no">H1</div>
  <div class="bx c"><div class="h5">{仮説}</div><p class="tx">{その仮説を置いた理由}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx c g"><span class="chip f">支持</span><div class="h5" style="margin-top:8px">{定量的な結果}</div><p class="tx">{母数・期間・検証手法}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx c s"><div class="h5">{とるべき行動}</div></div>
  <!-- H2, H3 も同形。チップは chip / chip a に差し替える -->
</div>
```
