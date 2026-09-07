#!/usr/bin/env bash
# HTML スライド → PPTX。references/export-pptx.md の手順から呼ぶ。
#   bash make_pptx.sh <deck.html> [out.pptx]
# 1) node to_pptx.mjs   … PPTX と行数マップ（.lines.json）を書く（初回は npm install を実行）
# 2) fix_pptx.ps1       … Windows の PowerPoint で言語・折り返しを整え、確認用 PNG を書き出す（powershell.exe が無ければ省略）
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 1 ] || { echo "usage: make_pptx.sh <deck.html> [out.pptx]" >&2; exit 2; }
src="$(realpath "$1")"
out="${2:-${src%.html}.pptx}"; out="$(realpath -m "$out")"
lines="${out%.pptx}.lines.json"

if [ ! -d "$here/node_modules" ]; then
  echo "依存パッケージを導入します（初回のみ）: $here" >&2
  (cd "$here" && npm install --no-audit --no-fund --loglevel=error)
fi
node "$here/to_pptx.mjs" "$src" "$out"

if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
  pngdir="$(mktemp -d "${TMPDIR:-/tmp}/pptx-preview-XXXXXX")"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$here/fix_pptx.ps1")" \
    -Pptx "$(wslpath -w "$out")" -Lines "$(wslpath -w "$lines")" -PngDir "$(wslpath -w "$pngdir")" | tr -d '\r'
  echo "確認用PNG（一時ファイル）: $pngdir/"
else
  echo "powershell.exe が無いため後処理（日本語の禁則・折り返し調整・PNG書き出し）は省略しました。PowerPoint で開いて折り返しを目視してください。" >&2
fi
rm -f "$lines"
echo "PPTX: $out ($(stat -c %s "$out") bytes)"
