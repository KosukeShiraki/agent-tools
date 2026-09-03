# 12. 循環構造｜複数要素の因果関係

**使う場面**：複数の事象が互いを強化し合っており、単独の対策では解決しないことを示す。
**要点**：**起点となる要素を明示し、循環を閉じる戻り矢印を必ず描く。** 戻り矢印がない図はただの横フローで、循環の主張にならない。要素は4つまで。悪循環の最終段（＝最も損失が大きい箱）にのみアクセントを使う。SVGの座標は4要素（各264px・矢印40px・全幅1176px）を前提としている。

```html
<div class="loop">
  <div class="bx"><div class="kk">①</div><div class="h5" style="margin-top:6px">{事象1}</div></div>
  <div style="display:flex;align-items:center;justify-content:center;width:40px"><div class="ar"></div></div>
  <div class="bx"><div class="kk">②</div><div class="h5" style="margin-top:6px">{事象2}</div></div>
  <div style="display:flex;align-items:center;justify-content:center;width:40px"><div class="ar"></div></div>
  <div class="bx"><div class="kk">③</div><div class="h5" style="margin-top:6px">{事象3}</div></div>
  <div style="display:flex;align-items:center;justify-content:center;width:40px"><div class="ar"></div></div>
  <div class="bx" style="border-color:var(--acc)"><div class="kk" style="color:var(--acc)">④</div><div class="h5" style="margin-top:6px">{事象4}</div></div>
</div>
<svg width="1176" height="52" viewBox="0 0 1176 52" aria-hidden="true" style="display:block;margin:0 auto">
  <path d="M1044 0 V34 H132 V10" fill="none" stroke="#12395b" stroke-width="1"/>
  <polygon points="128,10 136,10 132,0" fill="#12395b"/>
</svg>
<p class="nt" style="text-align:center">{循環が強化される条件}。{単独対策では止まらない理由}</p>
```
