#!/usr/bin/env python3
"""パターン#17（推移）の折れ線・棒グラフSVGを、値から生成する。座標を手計算しない。

usage:
    python3 chart.py line --values 100,97,91,84 --labels 2022,2023,2024,2025 \\
        --mark 2 --mark-label "新モデル導入" --unit "指数（2022年＝100）"
    python3 chart.py bar  --values 120,135,98,142 --labels Q1,Q2,Q3,Q4 --on 2

    --mark N        転換点（0始まりの点番号）に縦の破線を引く。--mark-label で注記
    --on N          強調する点／棒（0始まり。既定は最終点。-1 で強調なし）
    --min/--max/--step  縦軸の目盛を手動指定（省略時は自動）
    --unit          注記に入れる単位や指数の定義
    --note          注記に追記する母数・期間など

出力は `.fig` にそのまま貼れる HTML スニペット（標準出力）。
座標系は references/patterns/17-time-series.md と同一：
    プロット領域 x=74〜1156, y=236（下端）〜26（上端）
    折れ線の点  x = 106 + i × (1022 / (点数−1))
    値 v の y   y = 236 − (v − 目盛下限) × (210 / 目盛幅)
"""
import argparse, math, sys

W, H = 1176, 270
X0, X1 = 74, 1156          # プロット領域
YB, YT = 236, 26           # 基準線 y / 上端 y
PX0, PW = 106, 1022        # 折れ線の点の x 始点と幅


def fmt(v, decimals):
    if decimals == 0:
        return f"{int(round(v)):,}"
    return f"{v:,.{decimals}f}"


def nice_ticks(lo, hi, allow_trunc):
    """(下限, 上限, 刻み) を返す。allow_trunc=False なら下限は0以下に固定。"""
    if not allow_trunc:
        lo = min(lo, 0)
    span = hi - lo if hi > lo else abs(hi) or 1
    raw = span / 4
    mag = 10 ** math.floor(math.log10(raw))
    step = next(s * mag for s in (1, 2, 2.5, 5, 10) if s * mag >= raw)
    tmin = math.floor(lo / step) * step
    tmax = math.ceil(hi / step) * step
    if tmax <= tmin:
        tmax = tmin + step
    return tmin, tmax, step


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["line", "bar"])
    ap.add_argument("--values", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--mark", type=int, default=None)
    ap.add_argument("--mark-label", default="")
    ap.add_argument("--on", type=int, default=None, help="強調する点（0始まり）。既定は最終点、-1 で無し")
    ap.add_argument("--min", type=float, default=None)
    ap.add_argument("--max", type=float, default=None)
    ap.add_argument("--step", type=float, default=None)
    ap.add_argument("--unit", default="{単位}")
    ap.add_argument("--note", default="{母数と期間}")
    a = ap.parse_args()

    vals = [float(x) for x in a.values.split(",") if x.strip()]
    labels = [x.strip() for x in a.labels.split(",")]
    n = len(vals)
    if n < 2:
        sys.exit("点は2つ以上必要です。")
    if len(labels) != n:
        sys.exit(f"values と labels の数が違います（{n} vs {len(labels)}）。")
    decimals = 0 if all(float(v).is_integer() for v in vals) else 1
    on = (n - 1) if a.on is None else a.on
    if a.mark is not None and not 0 <= a.mark < n:
        sys.exit("--mark は 0〜点数-1 で指定してください。")

    # 目盛
    tmin, tmax, step = nice_ticks(min(vals), max(vals), allow_trunc=(a.kind == "line"))
    if a.min is not None: tmin = a.min
    if a.max is not None: tmax = a.max
    if a.step is not None: step = a.step
    if tmax <= tmin or step <= 0:
        sys.exit("--min/--max/--step の指定が不正です。")
    if a.kind == "bar" and tmin > 0:
        print("警告: 棒グラフの基準線が0でありません。長さの比較が歪むので --min 0 を推奨します。", file=sys.stderr)
    tdec = 0 if float(step).is_integer() and float(tmin).is_integer() else 1

    def y(v):
        return YB - (v - tmin) * ((YB - YT) / (tmax - tmin))

    out = ['<div class="chart">',
           f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}" aria-hidden="true">']
    # 目盛線
    t = tmin
    while t <= tmax + 1e-9:
        yy = round(y(t), 1)
        out.append(f'  <line class="g" x1="{X0}" y1="{yy}" x2="{X1}" y2="{yy}"/>'
                   f'<text class="tk" x="{X0 - 8}" y="{yy + 3.5}" text-anchor="end">{fmt(t, tdec)}</text>')
        t += step
    out.append(f'  <line class="ax" x1="{X0}" y1="{YB}" x2="{X1}" y2="{YB}"/>')

    if a.kind == "line":
        xs = [round(PX0 + i * (PW / (n - 1)), 1) for i in range(n)]
    else:
        band = (X1 - X0) / n
        xs = [round(X0 + band * (i + 0.5), 1) for i in range(n)]
        bw = round(min(72, band * 0.55), 1)

    # 転換点
    if a.mark is not None:
        mx = xs[a.mark]
        out.append(f'  <line class="mk" x1="{mx}" y1="20" x2="{mx}" y2="{YB}"/>')
        if a.mark_label:
            if mx > X1 - 200:
                out.append(f'  <text class="mkl" x="{mx - 8}" y="34" text-anchor="end">{a.mark_label}</text>')
            else:
                out.append(f'  <text class="mkl" x="{mx + 8}" y="34">{a.mark_label}</text>')

    if a.kind == "line":
        pts = " ".join(f"{x},{round(y(v), 1)}" for x, v in zip(xs, vals))
        out.append(f'  <polyline class="ser" points="{pts}"/>')
        for i, (x, v) in enumerate(zip(xs, vals)):
            yy = round(y(v), 1)
            c = " on" if i == on else ""
            out.append(f'  <circle class="dot{c}" cx="{x}" cy="{yy}" r="4.5"/>'
                       f'<text class="vl{c}" x="{x}" y="{round(yy - 13, 1)}" text-anchor="middle">{fmt(v, decimals)}</text>')
    else:
        for i, (x, v) in enumerate(zip(xs, vals)):
            yy = round(y(v), 1)
            c = " on" if i == on else ""
            out.append(f'  <rect class="bar{c}" x="{round(x - bw / 2, 1)}" y="{yy}" width="{bw}" height="{round(YB - yy, 1)}"/>'
                       f'<text class="vl{c}" x="{x}" y="{round(yy - 8, 1)}" text-anchor="middle">{fmt(v, decimals)}</text>')

    for x, lb in zip(xs, labels):
        out.append(f'  <text class="xl" x="{x}" y="256" text-anchor="middle">{lb}</text>')
    out.append("</svg></div>")

    trunc = f"縦軸は{fmt(tmin, tdec)}から表示（切り出し）／" if tmin > 0 else ""
    out.append(f'<p class="nt" style="width:1176px;margin:10px auto 0">{a.unit}。{trunc}{a.note}</p>')
    print("\n".join(out))


if __name__ == "__main__":
    main()
