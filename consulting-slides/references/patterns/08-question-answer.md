# 08. 問い → 答え｜エグゼクティブサマリー

**使う場面**：2ページ目。資料全体の構成を「3つの問いと答え」で示す。
**要点**：問いは読者が実際に抱く言葉で書く。答えの側にだけ強調を入れる。右端に該当ページ番号を置き、以降のページと対応させる。

```html
<div class="qa">
  <div class="hd2"></div><div class="hd2">問い</div><div class="hd2"></div><div class="hd2">本資料の答え</div><div class="hd2" style="text-align:right">該当</div>
  <div class="qn">Q1</div>
  <div class="bx"><div class="h5">{読者が抱く問い}</div><p class="tx">{補足}</p></div>
  <div style="display:flex;align-items:center;justify-content:center"><div class="ar"></div></div>
  <div class="bx g"><div class="h5">{答え。<b class="key">結論部分だけ太字</b>}</div><p class="tx">{根拠}</p></div>
  <div class="ref">P3–P4</div>
  <!-- Q2, Q3 も同形 -->
</div>
```
