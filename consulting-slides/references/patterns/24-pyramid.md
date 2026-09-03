# 24. ピラミッド｜主張 → 根拠 → 事実

**使う場面**：論証構造そのものを示す。「なぜそう言えるのか」を問われたときの1枚。
**要点**：**矢印は下から上（事実が根拠を、根拠が主張を支える）**。#02のIssue Treeは上から下への分解であり、向きも意味も逆になる。根拠は3本、各根拠を支える事実は3点まで。事実には出所や数値を入れる。主張のみアクセント枠。

```html
<div class="tree">
  <div class="bx s" style="width:640px;text-align:center;padding:16px;border-color:var(--acc)">
    <div class="kk" style="color:var(--acc)">主張</div><div class="h4" style="margin-top:6px">{主張}</div></div>
  <svg width="1176" height="46" viewBox="0 0 1176 46" aria-hidden="true" style="display:block">
    <path d="M188 46 V22 M988 46 V22 M188 22 H988 M588 22 V10" fill="none" stroke="#12395b"/>
    <polygon points="584,10 592,10 588,0" fill="#12395b"/>
  </svg>
  <div class="tcols">
    <div class="bx" style="border-top:2px solid var(--navy)"><div class="kk">根拠 A</div><div class="h5" style="margin-top:6px">{根拠}</div></div>
    <!-- B, C -->
  </div>
  <svg width="1176" height="34" viewBox="0 0 1176 34" aria-hidden="true" style="display:block">
    <path d="M188 34 V10 M588 34 V10 M988 34 V10" fill="none" stroke="#12395b"/>
    <polygon points="184,10 192,10 188,0" fill="#12395b"/><polygon points="584,10 592,10 588,0" fill="#12395b"/><polygon points="984,10 992,10 988,0" fill="#12395b"/>
  </svg>
  <div class="tcols">
    <div><div class="kk" style="margin-bottom:8px">事実</div><div class="lst"><div>{事実（数値・出所つき）}</div><div>{事実}</div><div>{事実}</div></div></div>
    <!-- B, C -->
  </div>
</div>
```
