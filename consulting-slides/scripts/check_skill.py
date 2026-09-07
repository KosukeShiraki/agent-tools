#!/usr/bin/env python3
"""スキル自体の整合チェック。雛形・パターン・索引・カタログ・SKILL.md を変えたら通す。

    python3 scripts/check_skill.py

検査項目（1つでも出ると終了コード1）:
    INDEX      layouts.md の索引 ↔ references/patterns/NN-*.md の1対1対応、番号の連続、見出し番号の一致
    CATALOG    pattern-catalog.html のページ数 ＝ パターン数 + 1（表紙）
    CLASS      パターンのHTMLスニペット・雛形・カタログ・実例で使うクラスが、雛形の <style> に定義されている
    CSS_SYNC   assets/template.html・references/example-deck.html・references/pattern-catalog.html の <style> が同一
    LINK       SKILL.md・layouts.md が参照するファイルパスが存在する
    SIZE       SKILL.md が上限バイト数（毎回読み込まれるため）を超えていない
    FIXTURE    render.py の自己テスト用フィクスチャに data-expect が揃っている

過去に実際に起きた食い違い（未使用クラス `.eq` の残存、`.cmp.c2` の定義漏れ、部分コピーによる雛形の欠落）を再発させないためのもの。
"""
import glob, os, re, sys

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_SKILL_BYTES = 20000

errors, warnings = [], []


def rel(p):
    return os.path.relpath(p, SKILL)


def read(p):
    return open(p, encoding="utf-8").read()


def style_of(p):
    m = re.search(r"<style>(.*?)</style>", read(p), re.S)
    return m.group(1) if m else None


def css_classes(css):
    """CSSテキストからセレクタに現れるクラス名を集める（数値の .5px などは除く）。"""
    # 宣言ブロックの中身を落としてセレクタ部分だけにする
    sel = re.sub(r"\{[^{}]*\}", " ", css)
    return set(re.findall(r"\.([A-Za-z_][\w-]*)", sel))


def html_classes(html):
    out = set()
    for m in re.finditer(r'class="([^"]*)"', html):
        out.update(t for t in m.group(1).split() if not t.startswith("{"))
    return out


# --- INDEX -----------------------------------------------------------------
layouts = os.path.join(SKILL, "references", "layouts.md")
idx_text = read(layouts)
idx_files = re.findall(r"`patterns/(\d\d-[\w-]+\.md)`", idx_text)
pattern_dir = os.path.join(SKILL, "references", "patterns")
actual = sorted(os.path.basename(p) for p in glob.glob(os.path.join(pattern_dir, "*.md")))
if sorted(idx_files) != actual:
    errors.append(f"INDEX 索引とファイルが一致しない: 索引のみ={sorted(set(idx_files)-set(actual))} ファイルのみ={sorted(set(actual)-set(idx_files))}")
nums = sorted(int(f[:2]) for f in actual)
if nums != list(range(1, len(nums) + 1)):
    errors.append(f"INDEX パターン番号が連続していない: {nums}")
for f in actual:
    head = read(os.path.join(pattern_dir, f)).splitlines()[0]
    m = re.match(r"# (\d\d)\.", head)
    if not m or m.group(1) != f[:2]:
        errors.append(f"INDEX {f} の見出し番号がファイル名と合わない: {head!r}")
# 索引行に上限列があるか
for line in idx_text.splitlines():
    if re.match(r"\| .* \| \d+ \| .* \| `patterns/", line) and len([c for c in line.split("|") if c.strip()]) < 5:
        errors.append(f"INDEX 上限の列が無い行: {line.strip()[:60]}")

# --- CATALOG ---------------------------------------------------------------
catalog = os.path.join(SKILL, "references", "pattern-catalog.html")
n_sheets = read(catalog).count('<div class="sheet">')
if n_sheets != len(actual) + 1:
    errors.append(f"CATALOG ページ数 {n_sheets} がパターン数+1（{len(actual)+1}）と合わない")

# --- CSS_SYNC --------------------------------------------------------------
template = os.path.join(SKILL, "assets", "template.html")
example = os.path.join(SKILL, "references", "example-deck.html")
tcss = style_of(template)
for p in (example, catalog):
    if style_of(p) != tcss:
        errors.append(f"CSS_SYNC {rel(p)} の <style> が雛形と異なる（雛形を直したら3ファイルに同じ変更を入れる）")

# --- CLASS -----------------------------------------------------------------
defined = css_classes(tcss)
# HTML側だけで意味を持つ（CSSに無くてよい）クラス
ALLOW = {"page", "sheet", "deck", "cover"}
sources = {}
for f in actual:
    md = read(os.path.join(pattern_dir, f))
    snippets = "\n".join(re.findall(r"```html\n(.*?)```", md, re.S))
    sources[f"patterns/{f}"] = html_classes(snippets)
for p in (template, example, catalog):
    body = read(p).split("</style>", 1)[-1]
    sources[rel(p)] = html_classes(body)
for name, used in sources.items():
    missing = sorted(c for c in used if c not in defined and c not in ALLOW)
    if missing:
        errors.append(f"CLASS {name} が使うクラスが雛形CSSに無い: {missing}")

# --- LINK ------------------------------------------------------------------
for doc in (os.path.join(SKILL, "SKILL.md"), layouts):
    text = read(doc)
    for m in re.finditer(r"`?((?:references|scripts|assets)/[\w./-]+)`?", text):
        path = m.group(1).rstrip(".")
        if "*" in path or "NN" in path:
            continue
        if not os.path.exists(os.path.join(SKILL, path)):
            errors.append(f"LINK {rel(doc)} が参照する {path} が無い")
    for m in re.finditer(r"`patterns/(\d\d-[\w-]+\.md)`", text):
        if not os.path.exists(os.path.join(pattern_dir, m.group(1))):
            errors.append(f"LINK {rel(doc)} が参照する patterns/{m.group(1)} が無い")

# --- SIZE ------------------------------------------------------------------
size = os.path.getsize(os.path.join(SKILL, "SKILL.md"))
if size > MAX_SKILL_BYTES:
    errors.append(f"SIZE SKILL.md が {size} バイト（上限 {MAX_SKILL_BYTES}）。本文を references/ に移す")

# --- FIXTURE ---------------------------------------------------------------
fixture = os.path.join(SKILL, "scripts", "fixtures", "selftest-sheets.html")
if not os.path.exists(fixture):
    errors.append("FIXTURE scripts/fixtures/selftest-sheets.html が無い")
else:
    fx = read(fixture)
    n_pages = fx.count('<div class="sheet">')
    n_exp = len(re.findall(r'data-expect="', fx))
    if n_pages != n_exp:
        errors.append(f"FIXTURE ページ数 {n_pages} と data-expect の数 {n_exp} が合わない")
    for cls in ("PAGE_OVERFLOW", "FIG_OVERFLOW", "SPILL", "CLIP", "BLEED", "PN_MISMATCH", "OK"):
        if f'data-expect="{cls}"' not in fx:
            errors.append(f"FIXTURE {cls} を期待するページが無い")

# --- report ----------------------------------------------------------------
errors = list(dict.fromkeys(errors))  # 同じ指摘の重複を落とす
print(f"パターン {len(actual)} 件 / カタログ {n_sheets} ページ / SKILL.md {size} バイト / 雛形CSSのクラス {len(defined)} 個")
for w in warnings:
    print("警告:", w)
if errors:
    print("\n要修正:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("check_skill: OK")
