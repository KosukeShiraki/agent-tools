# PPTX への変換（明示的に求められたときだけ）

**読むタイミング**：ユーザーが「pptx で」「パワポで」「PowerPoint に」と明示したとき。求められていないのに作らない。納品の既定は HTML 1ファイル。

## 前提

| 必要なもの | 用途 | 無いとき |
|---|---|---|
| Node.js 18 以上（22 で確認）と npm | `dom-to-pptx` と `puppeteer` による変換 | 変換できない |
| Windows の PowerPoint（WSL から `powershell.exe` が呼べること） | 日本語の禁則・折り返しの調整と確認用 PNG の書き出し | PPTX は出るが折り返しが崩れうる。PowerPoint で開いて目視する |

初回は `scripts/pptx/` に `npm install` が走る（`make_pptx.sh` が自動で行う）。`puppeteer` は Chrome を `~/.cache/puppeteer` に取得する。

## 手順

1. HTML 側を先に完成させ、`render.py` の検査が全ページ OK であること。PPTX は HTML の写しなので、HTML の崩れは PPTX にも出る。
2. 変換する。出力先を省略すると HTML と同じ場所・同じ名前で `.pptx` になる。
   ```bash
   bash <skill>/scripts/pptx/make_pptx.sh <deck.html> [out.pptx]
   ```
3. 出力の最後に出る `wrap off: N / shrink-to-fit: M / unmatched: K` を見る。`unmatched` が 0 以外なら、その番号のスライドのテキストボックスに折り返し調整が当たっていないので、確認用 PNG で該当箇所を見る。
4. 確認用 PNG（一時ディレクトリ `pptx-preview-*/s01.png` …）を Read ツールで全ページ目視し、HTML の PNG と見比べる。見るべき点：見出しの折り返し位置、チップの独立、表の罫線、矢印、配色。
5. ユーザーに伝えること：
   - ファイルの場所とサイズ（フォント埋め込みのため 5〜7MB になる）
   - テキストは編集可能。ただし1行だった文字列は折り返しを切ってあるので、長く書き換えると枠からはみ出す。その場合は PowerPoint 側で「図形内でテキストを折り返す」を戻す
   - macOS の PowerPoint や Google スライドでは埋め込みフォントが使えず、代替フォントで行送りが変わる

## 変換の仕組み（不具合を追うときに読む）

`scripts/pptx/to_pptx.mjs`

- 変換時だけ効く CSS を `</style>` の直後に足す（HTML ファイル自体は変えない）。
  - `font-feature-settings:normal`：詰め組み（palt）を切る。PowerPoint は詰めを再現できず、行末の1文字が次行に落ちる
  - `--ui` を Noto Sans JP に統一：IBM Plex Sans は日本語グリフを持たず、PowerPoint 側で幅がずれる
  - 資料名・ページ番号・Bottom Line ラベルを `nowrap`
  - 比較表のチップを `display:block` にして見出しと別のテキストボックスに分ける
  - 表紙見出しを 37px に落とす（palt 無しで1行に収めるための唯一の文字サイズ変更）
- puppeteer で各テキスト要素の行数を測り、`<out>.lines.json` に「空白を除いた文字列 → 行数」を書く。要素全体・テキストノード単位・`<br>` 区切りの断片の3種類の鍵を持つ
- `dom-to-pptx` の `exportHtmlToPptx` で `.page` ごとに1スライド。`svgAsVector:true`（図はベクター）、`autoEmbedFonts:true`、13.333×7.5 インチ

`scripts/pptx/fix_pptx.ps1`（PowerPoint COM）

- 全テキストに `LanguageID=1041`（日本語）を設定して禁則処理を有効にする
- 行数マップで1行だった文字列は `WordWrap=0`（PowerPoint は Chrome より日本語を広く測るため、放置すると末尾1文字が折れる）
- 複数行だった段落は `AutoSize=2`（枠に収まるよう縮小）
- 保存し、各スライドを 1280×720 の PNG に書き出す

## 既知の制約

- `require('dom-to-pptx/node')` を使う。`dist/…cjs` を直接 require すると `ERR_PACKAGE_PATH_NOT_EXPORTED`
- PowerPoint 側でダイアログが開いていると COM が固まる。閉じてから再実行
- 折れ線・棒グラフ（#17）の SVG はベクターで入るが、文字はアウトライン化されず PowerPoint のフォントで描かれるため、目盛ラベルの位置がわずかに動く
- 変換スクリプトは HTML の見た目を写すだけで、内容の検査はしない。検査は `render.py` で HTML 側に対して行う
