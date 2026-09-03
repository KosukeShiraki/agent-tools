# 23. 体制図｜組織と役割

**使う場面**：承認を求める直前に「**誰が責任を持ち、誰が手を動かすのか**」を示す。
**要点**：**人数と所属を必ず入れる**。兼務か専任か、社内か外部かを明記する（外部は点線でつなぐ）。階層は3段まで。分岐SVGは#02と同じ座標（188 / 588 / 988）を使う。

```html
<div class="tree" style="position:relative;width:1176px">
  <div class="bx s" style="width:400px;text-align:center;padding:14px"><div class="kk">責任者</div><div class="h4" style="margin-top:5px">{役職}</div><p class="tx">{何に責任を持つか}</p></div>
  <svg width="1176" height="34" viewBox="0 0 1176 34" aria-hidden="true" style="display:block">
    <path d="M588 0 V24" fill="none" stroke="#12395b"/><polygon points="584,24 592,24 588,34" fill="#12395b"/>
  </svg>
  <div style="position:relative;width:1176px;height:78px">
    <div class="bx" style="position:absolute;left:388px;top:0;width:400px;height:78px"><div class="kk">事務局</div><div class="h4" style="margin-top:5px">{組織名} {人数}名</div><p class="tx">{役割}</p></div>
    <div style="position:absolute;left:788px;top:38px;width:128px;border-top:1px dashed var(--rule)"></div>
    <div class="bx g" style="position:absolute;left:916px;top:8px;width:260px"><div class="h5">外部支援（{人数}名）</div><p class="tx">{関与範囲}</p></div>
  </div>
  <svg width="1176" height="52" viewBox="0 0 1176 52" aria-hidden="true" style="display:block">
    <path d="M588 0 V20 M188 20 H988 M188 20 V40 M588 20 V40 M988 20 V40" fill="none" stroke="#12395b"/>
    <polygon points="184,40 192,40 188,50" fill="#12395b"/><polygon points="584,40 592,40 588,50" fill="#12395b"/><polygon points="984,40 992,40 988,50" fill="#12395b"/>
  </svg>
  <div class="tcols">
    <div class="bx"><div class="kk">チーム A</div><div class="h4" style="margin-top:6px">{役割}　{人数}名</div><p class="tx">{担当範囲}／{所属}</p></div>
    <!-- B, C -->
  </div>
</div>
<p class="nt" style="width:1176px;margin:14px auto 0">計{N}名。{兼務・専任の別}（点線＝外部リソース）</p>
```
