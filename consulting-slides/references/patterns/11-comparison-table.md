# 11. 複数案の比較｜比較表（ハーヴェイボール）

**使う場面**：2〜4案を複数の評価軸で比較し、推奨案を1つに絞る。
**要点**：推奨列は全セルに `on` を付けて淡色地にし、ヘッダーにのみアクセントの上罫と `chip a` を置く。**各軸とも「望ましい側を●」に統一**し、凡例を必ず添える。評価は記号だけにせず、実数値や一言を併記する。案が2つなら `.cmp.c2`、4つなら `.cmp.c4` を付ける（CSSは書き換えない）。

```html
<div class="cmp">
  <div class="r head">
    <div class="hd">評価軸</div>
    <div class="opt">A：{案名}</div>
    <div class="opt on"><span class="chip a" style="margin-right:8px">推奨</span>B：{案名}</div>
    <div class="opt">C：{案名}</div>
  </div>
  <div class="r">
    <div class="ax">{評価軸}</div>
    <div class="cel"><span class="hb"></span><span>{実数値や一言}</span></div>
    <div class="cel on"><span class="hb f"></span><span>{実数値や一言}</span></div>
    <div class="cel"><span class="hb h"></span><span>{実数値や一言}</span></div>
  </div>
  <!-- 評価軸の行を3〜5行 -->
</div>
<p class="nt" style="margin-top:14px">●＝優　◑＝可　○＝劣（各軸とも望ましい側を●とする）／{数値の前提}</p>
```

`hb f`＝● / `hb h`＝◑ / `hb`＝○
