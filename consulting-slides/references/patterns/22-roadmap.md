# 22. ロードマップ｜ワークストリーム × フェーズ

**使う場面**：全社展開など、**複数の作業の流れとマイルストーン**を粗い粒度で示す。日次の工程は#09のガントで示す。
**要点**：
- 月・四半期ヘッダーの**先頭に空の `<span></span>`**（ラベル列158px分）を入れる。忘れると全列が1つずれる。
- **マイルストーンは専用の最終行に置く。** ワークストリームの行に置くと、その行だけのマイルストーンに見える。
- 判断ゲート後に着手する工程は `bar lt`（薄い帯）にする。

```html
<div class="rm">
  <div class="mh"><span></span><span>Q1</span><span>Q2</span><span>Q3</span><span>Q4</span></div>
  <div class="row"><div class="ws">WS1｜{名称}</div><div class="track">
    <div class="gl" style="left:25%"></div><div class="gl" style="left:50%"></div><div class="gl" style="left:75%"></div>
    <div class="bar" style="left:0;width:46%">{作業}</div>
    <div class="bar lt" style="left:52%;width:48%">{判断後に着手する作業}</div></div></div>
  <!-- WS2, WS3 も同形 -->
  <div class="row" style="height:50px;border-bottom:1px solid var(--navy)">
    <div class="ws" style="font-family:var(--ui);font-size:9.5px;font-weight:600;letter-spacing:.1em;color:var(--ink4)">マイルストーン</div>
    <div class="track">
      <div class="gl" style="left:25%"></div><div class="gl" style="left:50%"></div><div class="gl" style="left:75%"></div>
      <div class="ms" style="left:50%"></div><div class="msl" style="left:calc(50% + 13px)">{判断ゲート}</div>
      <div class="ms" style="left:100%"></div><div class="msl" style="right:15px">{完了}</div>
    </div></div>
</div>
<p class="nt" style="width:1176px;margin:12px auto 0">薄い帯＝判断後に着手する工程。◆＝判断・完了のマイルストーン</p>
```
