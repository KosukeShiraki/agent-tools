# 18. 構成比｜100％積み上げ帯

**使う場面**：量がどこに偏っているかを示す。**2時点を並べると、構成の変化そのものが主張になる。**
**要点**：論点となるカテゴリのみアクセント（`sa`）、それ以外はネイビーの濃淡（`s1`〜`s5`）で階調をつける。円グラフは使わない。凡例は右下に置き、帯の中に数値を直接書く。

```html
<div class="stkw">
  <div class="stkr"><div class="lb">{時点1}</div><div class="stk">
    <div class="sg s1" style="width:38%">{項目} 38</div>
    <div class="sg sa" style="width:24%">{論点の項目} 24</div>
    <div class="sg s3" style="width:18%">{項目} 18</div>
    <div class="sg s4" style="width:12%">{項目} 12</div>
    <div class="sg s5" style="width:8%">{項目} 8</div>
  </div></div>
  <div class="stkr"><div class="lb">{時点2}</div><div class="stk"><!-- 同じ順序・同じ色で --></div></div>
  <div class="lgd">
    <span><i style="background:var(--navy)"></i>{項目}</span>
    <span><i style="background:var(--acc)"></i>{論点の項目}</span>
  </div>
  <p class="nt" style="margin-top:16px">{単位}。母数：{母数}</p>
</div>
```
