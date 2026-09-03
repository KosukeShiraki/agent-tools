#!/usr/bin/env python3
"""スライドHTMLを1ページずつPNG化し、はみ出し・重なり・文字切れ・ページ番号を検査する。

検証用のPNGは一時ディレクトリに出力する（納品物ではない）。

usage:
    python3 render.py deck.html                    # 全ページ PNG + 検査
    python3 render.py deck.html --pages 3,5-7      # 指定ページだけ再検証
    python3 render.py deck.html -o shots --scale 2

検査項目（1つでも出ると終了コード1）:
    PAGE_OVERFLOW  ページ全体が720pxを縦に超えた
    FIG_OVERFLOW   .fig の中身が .fig の高さを超え、タイトルや Bottom Line に重なっている
    SPILL          テキストを持つ要素の中身がその箱を縦に超えている（固定高さの箱からの文字はみ出し）
    CLIP           overflow:hidden の要素で中身が切れている
    BLEED          要素がページ右端(1280px)を超えている
    PN_MISSING / PN_MISMATCH  .pn の「NN / 全枚数」が無い・ページ位置や総数と合わない

前提: deck.html が1ページを <div class="sheet"><section class="page">...</section></div> で囲んでいること。
Chrome / Chromium（WSLの場合はWindows版Chrome）が必要。
"""
import argparse, glob, os, re, shutil, subprocess, sys, tempfile

CHECK = """<script>window.addEventListener('load',function(){setTimeout(function(){var r=[];
function nm(e){return e.tagName.toLowerCase()+(e.className?'.'+String(e.className).trim().split(/\\s+/).join('.'):'')}
document.querySelectorAll('.page').forEach(function(p){
 if(p.scrollHeight>p.clientHeight+1)r.push('PAGE_OVERFLOW +'+(p.scrollHeight-p.clientHeight)+'px');
 var fig=p.querySelector('.fig');
 if(fig&&fig.scrollHeight>fig.clientHeight+2)r.push('FIG_OVERFLOW +'+(fig.scrollHeight-fig.clientHeight)+'px');
 p.querySelectorAll('*').forEach(function(e){
  var cs=getComputedStyle(e);
  if(e.getBoundingClientRect().right>1281)r.push('BLEED '+nm(e));
  if(cs.display==='inline'||e.closest('svg')||!e.textContent.trim())return;
  if(e.scrollHeight>e.clientHeight+2){
    if(cs.overflow!=='visible')r.push('CLIP '+nm(e));
    else if(e!==fig&&!e.classList.contains('page'))r.push('SPILL '+nm(e)+' +'+(e.scrollHeight-e.clientHeight)+'px');
  }});});
document.title='RESULT::'+(r.length?r.join(' | '):'OK');},400);});</script>"""

WIN_CHROME = [
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
]


def find_chrome():
    """(実行パス, WSLからWindows版を呼ぶか) を返す。"""
    for p in WIN_CHROME:
        if os.path.exists(p):
            return p, True
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return p, False
    sys.exit("Chrome/Chromium が見つかりません。")


def win_workdir():
    """Windows版Chromeから読める、この実行専用の作業ディレクトリを用意する。"""
    for base in glob.glob("/mnt/c/Users/*/AppData/Local/Temp"):
        if os.access(base, os.W_OK):
            d = os.path.join(base, "deckshots", str(os.getpid()))
            os.makedirs(d, exist_ok=True)
            return d
    sys.exit("Windows側の作業ディレクトリを確保できません。")


def wpath(p):
    return subprocess.run(["wslpath", "-w", p], capture_output=True, text=True).stdout.strip()


def parse_pages(spec, n):
    """'3,5-7' → {3,5,6,7}。範囲外は無視。"""
    if not spec:
        return set(range(1, n + 1))
    s = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            s.update(range(int(a), int(b) + 1))
        else:
            s.add(int(part))
    return {i for i in s if 1 <= i <= n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("deck")
    ap.add_argument("-o", "--out", default=None,
                    help="PNG出力先（既定：一時ディレクトリ。プロジェクト内には残さない）")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="PNGの倍率。目視はReadツールで縮小されるので既定の1で十分")
    ap.add_argument("--pages", default=None, help="検証するページ番号（例: 3,5-7）。省略時は全ページ")
    a = ap.parse_args()

    src = os.path.abspath(a.deck)
    html = open(src, encoding="utf-8").read()
    if '<div class="deck">' not in html:
        sys.exit('deck.html に <div class="deck"> がありません。')
    head = html.split('<div class="deck">')[0]
    sheets = re.findall(r'<div class="sheet">.*?</section></div>', html, re.S)
    if not sheets:
        sys.exit(".sheet が見つかりません。")
    total = len(sheets)
    targets = parse_pages(a.pages, total)
    if not targets:
        sys.exit(f"--pages の指定が範囲外です（1〜{total}）。")

    chrome, is_win = find_chrome()
    work = win_workdir() if is_win else tempfile.mkdtemp(prefix="deck-")
    conv = wpath if is_win else (lambda p: p)
    fix = '<style>:root{--s:1}.deck{padding:0}.sheet{margin:0}</style>'

    outdir = os.path.abspath(a.out) if a.out else os.path.join(
        tempfile.gettempdir(), "deck-preview-" + os.path.splitext(os.path.basename(src))[0])
    os.makedirs(outdir, exist_ok=True)
    # 前回の古いPNGを消す（全ページ実行時のみ。部分実行では他ページの結果を残す）
    if not a.pages:
        for old in glob.glob(os.path.join(outdir, "p[0-9][0-9].png")):
            os.remove(old)

    print(f"{total} ページ中 {len(targets)} ページを検証 / chrome: {os.path.basename(chrome)}")

    ng = []
    try:
        for i, sh in enumerate(sheets, 1):
            if i not in targets:
                continue
            page = f"{head}{fix}<div class=\"deck\">{sh}</div>"
            f = os.path.join(work, f"p{i:02d}.html")
            open(f, "w", encoding="utf-8").write(page)
            open(f + ".chk.html", "w", encoding="utf-8").write(page + CHECK)
            png = os.path.join(work, f"p{i:02d}.png")
            subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            f"--force-device-scale-factor={a.scale}", "--window-size=1280,720",
                            "--virtual-time-budget=7000", f"--screenshot={conv(png)}", conv(f)],
                           capture_output=True)
            dom = subprocess.run([chrome, "--headless=new", "--disable-gpu", "--window-size=1280,720",
                                  "--virtual-time-budget=8000", "--dump-dom", conv(f + ".chk.html")],
                                 capture_output=True, text=True).stdout
            m = re.search(r"RESULT::([^<]*)", dom)
            res = m.group(1) if m else "NO_RESULT"

            # ページ番号「NN / 全枚数」の照合
            pm = re.search(r'class="pn">\s*(\d+)\s*/\s*(\d+)\s*<', sh)
            if not pm:
                res += " | PN_MISSING"
            elif int(pm.group(1)) != i or int(pm.group(2)) != total:
                res += f" | PN_MISMATCH {pm.group(1)}/{pm.group(2)} (expected {i:02d}/{total})"
            res = res.replace("OK | ", "", 1)

            if os.path.exists(png):
                shutil.copy(png, os.path.join(outdir, f"p{i:02d}.png"))
            else:
                res += " (SCREENSHOT_FAILED)"
            if res != "OK":
                ng.append((i, res))
            print(f"  p{i:02d}: {res}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"PNG（検証用・一時ファイル）: {outdir}/")
    if ng:
        print("\n要修正:")
        for i, r in ng:
            print(f"  p{i:02d}  {r}")
        sys.exit(1)
    print("検査: 全ページ OK — 次はPNGをReadツールで目視すること")


if __name__ == "__main__":
    main()
