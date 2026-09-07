// HTMLスライド → PPTX（dom-to-pptx）。
// 1) ブラウザで各テキスト要素の行数を測って <out>.lines.json に出す（後処理 fix_pptx.ps1 が折り返しの判定に使う）
// 2) dom-to-pptx で .page ごとに 1 スライドの PPTX を書く（テキストは編集可能、SVG はベクター、フォント埋め込み）
//
// usage: node to_pptx.mjs <deck.html> <out.pptx>
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { exportHtmlToPptx } = require('dom-to-pptx/node');
const puppeteer = require('puppeteer');

const [,, src, out] = process.argv;
if (!src || !out) {
  console.error('usage: node to_pptx.mjs <deck.html> <out.pptx>');
  process.exit(2);
}
let html = fs.readFileSync(src, 'utf8');

// PPTX 変換時だけ効かせる CSS。HTML 側のファイルは変えない。
//  - palt（プロポーショナル詰め）を切る：PowerPoint は詰め組みを再現できず、行末の1文字が落ちる
//  - 英字フォント（IBM Plex Sans）を Noto Sans JP に統一：PowerPoint 側で和欧混植の幅がずれる
//  - 資料名・ページ番号・Bottom Line ラベルは折り返さない
//  - 比較表のチップは見出し文字と別のテキストボックスに分ける
//  - 表紙の見出しは palt 無しだと1行に収まらないため 37px に落とす（唯一の文字サイズ変更）
const override = `<style id="pptx-mode">
body{font-feature-settings:normal}
:root{--ui:"Noto Sans JP",sans-serif}
.brand,.pn,.bl .k{white-space:nowrap}
.cmp .opt .chip{display:block;width:max-content;margin:0 0 4px}
.cover h1{font-size:37px}
</style>`;
html = html.replace('</style>', '</style>' + override);
const tmpHtml = path.resolve(path.dirname(out), '.pptx-src.html');
fs.writeFileSync(tmpHtml, html);

try {
  // 1) 行数の地図
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 800 });
  await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle0' });
  const lines = await page.evaluate(() => {
    const norm = t => t.replace(/\s+/g, '');
    const map = {};
    const put = (key, n) => { if (key) map[key] = Math.max(map[key] || 0, n); };
    const countLines = (range) => {
      const tops = new Set(Array.from(range.getClientRects()).filter(x => x.width > 0).map(x => Math.round(x.top)));
      return Math.max(1, tops.size);
    };
    document.querySelectorAll('.page *').forEach(el => {
      if (el.closest('svg')) return;
      const ownNodes = Array.from(el.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim());
      if (!ownNodes.length) return;
      // (a) 要素全体
      const r = document.createRange(); r.selectNodeContents(el);
      const brs = el.querySelectorAll('br').length;
      let n = countLines(r);
      if (n === brs + 1) n = 1;
      put(norm(el.textContent), n);
      // (b) テキストノード単位（チップなどと同居する場合）
      ownNodes.forEach(t => { const rr = document.createRange(); rr.selectNodeContents(t); put(norm(t.textContent), countLines(rr)); });
      // (c) <br> で区切った断片単位
      if (brs) {
        let seg = '';
        Array.from(el.childNodes).forEach(c => {
          if (c.nodeName === 'BR') { put(norm(seg), 1); seg = ''; } else seg += c.textContent;
        });
        put(norm(seg), 1);
      }
    });
    return map;
  });
  await browser.close();
  fs.writeFileSync(out.replace(/\.pptx$/, '.lines.json'), JSON.stringify(lines));

  // 2) PPTX 生成（16:9 = 13.333 × 7.5 インチ）
  const buf = await exportHtmlToPptx(html, {
    selector: '.page',
    browserWidth: 1400, browserHeight: 800,
    pptxOptions: { svgAsVector: true, width: 13.333, height: 7.5, autoEmbedFonts: true },
  });
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes), line map: ${Object.keys(lines).length} entries`);
} finally {
  if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);
}
