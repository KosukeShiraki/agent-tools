# 03. 加算分解｜ウォーターフォール（基準値 → 寄与 → 結果）

**使う場面**：ある数値が、どの要因で何ポイント動いたのかを分解する。
**要点**：`up`（＝押し上げ）はバーガンディ、`dn`（＝押し下げ）は白＋ネイビー枠、両端の `anchor` はネイビー枠＋淡色地。**合計が必ず結果値と一致すること**を確認する。凡例を必ず添える。

```html
<div class="wf">
  <div class="cell"><div class="cap">{基準値の名前}</div><div class="val anchor">{値}</div><p class="nt" style="margin-top:7px">{注}</p></div>
  <div class="op">+</div>
  <div class="cell"><div class="cap">{要因名}<br>{条件}</div><div class="val up">+{値}</div><p class="nt" style="margin-top:7px">{注}</p></div>
  <div class="op">+</div>
  <div class="cell"><div class="cap">{要因名}<br>{条件}</div><div class="val dn">-{値}</div><p class="nt" style="margin-top:7px">{注}</p></div>
  <div class="op">=</div>
  <div class="cell"><div class="cap">{結果の名前}</div><div class="val anchor">{値}</div><p class="nt" style="margin-top:7px">{注}</p></div>
</div>
<div class="lg">
  <span class="nt"><i class="a"></i>{濃色の意味}</span>
  <span class="nt"><i class="b"></i>{白の意味}</span>
  <span class="nt" style="margin-left:auto">{読み方の例}</span>
</div>
```
