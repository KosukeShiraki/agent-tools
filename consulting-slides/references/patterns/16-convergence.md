# 16. 収束｜複数要因 → 1つの結論

**使う場面**：複数の独立した事実が、同じ結論を指していることを示す。意思決定を促す最終盤で使う。
**要点**：**左の各箱に情報源を明記する**（実績データ／ヒアリング／外部調査など）。情報源が異なるほど結論の頑健性が上がるため、それ自体が主張になる。結論の箱はアクセント枠。要因は4つまで（SVGの座標は4要因・各76px・間隔14pxを前提）。

```html
<div class="conv">
  <div class="src">
    <div class="bx"><div class="h5">{事実1}</div><p class="tx">{情報源}</p></div>
    <div class="bx"><div class="h5">{事実2}</div><p class="tx">{情報源}</p></div>
    <div class="bx"><div class="h5">{事実3}</div><p class="tx">{情報源}</p></div>
    <div class="bx"><div class="h5">{事実4}</div><p class="tx">{情報源}</p></div>
  </div>
  <svg width="120" height="346" viewBox="0 0 120 346" aria-hidden="true">
    <path d="M0 38 L72 173 M0 128 L72 173 M0 218 L72 173 M0 308 L72 173" fill="none" stroke="#12395b" stroke-width="1"/>
    <path d="M72 173 H110" fill="none" stroke="#12395b" stroke-width="1"/>
    <polygon points="110,169 110,177 118,173" fill="#12395b"/>
  </svg>
  <div class="dst bx s" style="border-color:var(--acc);padding:26px 24px">
    <div class="kk" style="color:var(--acc)">結論</div>
    <div class="h4" style="margin-top:8px">{結論}</div>
    <p class="tx">{なぜこの4つから同じ結論が導かれるか}</p>
  </div>
</div>
```
