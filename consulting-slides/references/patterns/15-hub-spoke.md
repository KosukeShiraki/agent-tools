# 15. 中央から展開｜ハブ＆スポーク

**使う場面**：1つの中核施策が、複数の領域に同時に波及することを示す。投資対効果を単一部門で評価すべきでない、という主張に使う。
**要点**：**波及先は「誰にとって、何が変わるか」で書く**（機能の列挙にしない）。中心は `bx s`、波及先は通常の `bx`。座標は固定（1176×340）なので、要素数を4から変える場合はパスの終点も合わせて修正する。

```html
<div class="hub">
  <svg width="1176" height="340" viewBox="0 0 1176 340" aria-hidden="true">
    <defs><marker id="hah" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0,0 9,3.5 0,7" fill="#12395b"/></marker></defs>
    <path d="M428 146 L288 76" fill="none" stroke="#12395b" marker-end="url(#hah)"/>
    <path d="M748 146 L888 76" fill="none" stroke="#12395b" marker-end="url(#hah)"/>
    <path d="M428 206 L288 276" fill="none" stroke="#12395b" marker-end="url(#hah)"/>
    <path d="M748 206 L888 276" fill="none" stroke="#12395b" marker-end="url(#hah)"/>
  </svg>
  <div class="node bx s" style="left:428px;top:126px;width:320px;height:100px;display:flex;flex-direction:column;justify-content:center">
    <div class="kk">中核施策</div><div class="h4" style="margin-top:6px">{中心概念}</div></div>
  <div class="node bx" style="left:0;top:34px;width:280px"><div class="h5">{領域}：{何が変わるか}</div><p class="tx">{具体}</p></div>
  <div class="node bx" style="left:896px;top:34px;width:280px"><div class="h5">{領域}：{何が変わるか}</div><p class="tx">{具体}</p></div>
  <div class="node bx" style="left:0;top:234px;width:280px"><div class="h5">{領域}：{何が変わるか}</div><p class="tx">{具体}</p></div>
  <div class="node bx" style="left:896px;top:234px;width:280px"><div class="h5">{領域}：{何が変わるか}</div><p class="tx">{具体}</p></div>
</div>
```
