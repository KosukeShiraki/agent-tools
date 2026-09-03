# 02. 課題分解｜Issue Tree（上位1つ → 下位3つ）

**使う場面**：1つの問題が、性質の異なる複数の損失・論点に分かれることを示す。
**要点**：SVGの座標は3列（各376px・間隔24px・全幅1176px）に対応しており**変更しない**。各枝の下に補足を3点まで。枝ごとに「誰にとっての問題か」を書き分けると粒度が揃う。

```html
<div class="tree">
  <div class="bx s" style="width:560px;text-align:center;padding:16px"><div class="h4">{分解する対象}</div></div>
  <svg width="1176" height="54" viewBox="0 0 1176 54" aria-hidden="true" style="display:block">
    <path d="M588 0 V20 M188 20 H988 M188 20 V42 M588 20 V42 M988 20 V42" fill="none" stroke="#12395b" stroke-width="1"/>
    <polygon points="184,42 192,42 188,52" fill="#12395b"/>
    <polygon points="584,42 592,42 588,52" fill="#12395b"/>
    <polygon points="984,42 992,42 988,52" fill="#12395b"/>
  </svg>
  <div class="tcols">
    <div>
      <div class="bx" style="border-top:2px solid var(--navy)">
        <div class="kk">A｜{分類}</div><div class="h4" style="margin-top:7px">{枝の結論}</div>
        <p class="tx">{誰にとっての問題か}／{必要な粒度}</p></div>
      <div class="lst"><div>{補足1}</div><div>{補足2}</div><div>{補足3}</div></div>
    </div>
    <!-- B, C も同形 -->
  </div>
</div>
```
