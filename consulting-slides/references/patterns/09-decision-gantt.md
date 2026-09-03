# 09. 意思決定｜決定事項 ＋ ガントチャート

**使う場面**：最終ページ。何を承認してほしいのかと、その期間・判断ゲートを示す。
**要点**：
- 月ヘッダーの**先頭に必ず空の `<span></span>`**（ラベル列172px分）を入れる。忘れると全列が1つずれる。
- 判断ゲート `.gmark` は `left:calc(50% + 86px)`（＝ラベル列を除いたトラックの中央）。位置を変える場合は `calc(ラベル列幅 + (100% - ラベル列幅) × 比率)` で計算する。
- **ゲートより右の工程は薄い帯（`.bar.lt`）にし、ゲートをまたぐバーを作らない。** 本文の「Day◯◯で判断」と矛盾させない。

```html
<div class="dec">
  <div>
    <div class="kk" style="margin-bottom:12px">本日ご決定いただきたい{N}点</div>
    <div class="list">
      <div class="bx s"><div class="h5"><span class="num">01｜</span>{決定事項}</div><p class="tx">{選択肢と根拠}</p></div>
      <!-- 02, 03 -->
    </div>
    <p class="nt" style="margin-top:14px">※ {投資規模と後戻りのしやすさ}</p>
  </div>
  <div>
    <div class="kk" style="margin-bottom:12px">{期間}スケジュールと判断ポイント</div>
    <div class="gantt">
      <div class="mh"><span></span><span>MONTH 1</span><span>MONTH 2</span><span>MONTH 3</span></div>
      <div class="gwrap">
        <div class="grow"><span class="lbl">{工程}</span><span class="track"><span class="bar" style="left:0;width:17%"></span></span></div>
        <div class="grow"><span class="lbl">{工程}</span><span class="track"><span class="bar" style="left:33%;width:17%"></span></span></div>
        <div class="grow" style="border-bottom:1px solid var(--navy)"><span class="lbl">{決定後の工程}</span><span class="track"><span class="bar lt" style="left:50%;width:33%"></span></span></div>
        <div class="gmark" style="left:calc(50% + 86px)"><span style="position:absolute;left:6px;top:0;font-family:var(--ui);font-size:9px;font-weight:600;letter-spacing:.06em;color:var(--acc);background:#fff;padding:1px 4px;white-space:nowrap">Day 45 — Go / No-Go</span></div>
      </div>
      <div class="gnote">{ゲートの意味と薄い帯の意味}</div>
    </div>
  </div>
</div>
```
