# 19. KPIツリー｜数式分解

**使う場面**：目標指標を演算子で分解し、**どの変数を動かすかを1つに特定する**。
**要点**：分解は2段まで。各要素に現状値を必ず入れ、動かせない変数にはその理由を書く（「すでに上限」「短期では動かない」）。動かす変数のみアクセント枠＋`chip a`。行クラスは `lv`、演算子は `.kpi .op` を使う（ウォーターフォールの `.wf .op` とは別物。流用しない）。

段1が3ボックス構成のとき、中央ボックスの中心はページ中心（x=588）に一致するため、下段への分岐SVGは下記の座標をそのまま使える。

```html
<div class="kpi">
  <div class="lv">
    <div class="bx s"><div class="kk">目標指標</div><div class="h5" style="margin-top:6px">{目標指標}</div><div class="val">{現状値}</div></div>
    <div class="op">＝</div>
    <div class="bx"><div class="kk">構成要素</div><div class="h5" style="margin-top:6px">{要素1}</div><div class="val">{値}</div></div>
    <div class="op">−</div>
    <div class="bx"><div class="kk">構成要素</div><div class="h5" style="margin-top:6px">{要素2}</div><div class="val">{値}</div></div>
  </div>
  <svg width="1176" height="46" viewBox="0 0 1176 46" aria-hidden="true" style="display:block">
    <path d="M588 0 V14 M181 14 H995 M181 14 V34 M588 14 V34 M995 14 V34" fill="none" stroke="#12395b"/>
    <polygon points="177,34 185,34 181,44" fill="#12395b"/>
    <polygon points="584,34 592,34 588,44" fill="#12395b"/>
    <polygon points="991,34 999,34 995,44" fill="#12395b"/>
  </svg>
  <div class="lv">
    <div class="bx"><div class="h5">{変数1}</div><div class="val">{値}</div><p class="tx">{動かせない理由}</p></div>
    <div class="op">×</div>
    <div class="bx s" style="border-color:var(--acc)"><span class="chip a">打ち手の対象</span><div class="h5" style="margin-top:8px">{変数2}</div><div class="val on">{値}</div><p class="tx">{ここを動かす理由}</p></div>
    <div class="op">×</div>
    <div class="bx"><div class="h5">{変数3}</div><div class="val">{値}</div><p class="tx">{動かせない理由}</p></div>
  </div>
</div>
<p class="nt" style="width:1176px;margin:14px auto 0">{変数2を目標値に戻したときの効果を、他を横ばいと置いて算定}</p>
```
