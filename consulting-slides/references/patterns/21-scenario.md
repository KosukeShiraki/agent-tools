# 21. シナリオ分析｜3ケース

**使う場面**：**同じ案について前提を変え**、結果の振れ幅を示す。複数の案を比べる#11とは異なる。
**要点**：前提と結果を `r sec` の見出し行で必ず分ける。計画前提とするケースを `on`＋`chip a` で明示する。**悲観ケースでも判断が覆らないこと**を示せると、意思決定を後押しできる。前提は2〜3項目、結果は2項目に絞る。

```html
<div class="cmp">
  <div class="r head">
    <div class="hd">ケース</div>
    <div class="opt">悲観</div>
    <div class="opt on"><span class="chip a" style="margin-right:8px">計画前提</span>基本</div>
    <div class="opt">楽観</div>
  </div>
  <div class="r sec"><div class="sub">前提</div></div>
  <div class="r"><div class="ax">{前提項目}</div><div class="cel"><span>{値}</span></div><div class="cel on"><span>{値}</span></div><div class="cel"><span>{値}</span></div></div>
  <div class="r sec"><div class="sub">結果</div></div>
  <div class="r"><div class="ax">{結果指標}</div><div class="cel"><span>{値}</span></div><div class="cel on"><span>{値}</span></div><div class="cel"><span>{値}</span></div></div>
</div>
<p class="nt" style="margin-top:14px">{どのケースを計画前提とするか}。{悲観ケースでも判断が覆らない理由}</p>
```
