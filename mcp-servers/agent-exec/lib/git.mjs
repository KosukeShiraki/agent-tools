// git の状態取得と差分。どの CLI を動かしたかに依存しない。
//
// 実行前後の状態を比べて「この run で何が変わったか」を返す。エージェントの
// イベント形式に依存しないので、打ち切られた run でも取得できる。

import { execFileSync } from "node:child_process";

// 生の stdout を返す。`git status --porcelain` は行頭の空白が意味を持つ（" M path" は
// 未ステージの変更）ため、ここで trim すると 1 行目だけ 1 文字ずれてパスが壊れる。
function gitRaw(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000, // 同期実行なので、長く待つとイベントループ全体が止まる
      stdio: ["ignore", "pipe", "ignore"], // git の fatal を server の stderr へ流さない
    });
  } catch {
    return undefined;
  }
}

// 1行の値（rev-parse など）を取る用。
function git(cwd, args) {
  const out = gitRaw(cwd, args);
  return out === undefined ? undefined : out.trim();
}

// `--porcelain -z` は NUL 区切りで、パスのクォートやエスケープが起きない。
function parsePorcelainZ(raw) {
  if (!raw) return [];
  const entries = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === "") continue;
    const code = field.slice(0, 2);
    entries.push({ status: code.trim(), path: field.slice(3) });
    // rename / copy はもう1フィールド（変更前のパス）が続く。X 列だけでなく Y 列にも出る。
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i += 1;
  }
  return entries;
}

// `.git` の存在だけを見ると、空の .git ディレクトリ（実際に /tmp に存在した）を
// git リポジトリと誤判定する。git 自身に判定させる。
export function gitRoot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return root ? root : null;
}

export function captureGitState(cwd) {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const status = gitRaw(cwd, ["status", "--porcelain", "-z"]);
  if (head === undefined && status === undefined) return undefined;
  return { head: head ?? null, status: status ?? "" };
}

export function diffGitState(cwd, before) {
  const after = captureGitState(cwd);
  if (!after) return undefined;
  // 「この run の変更」を厳密に出すには開始時の内容そのものを保存する必要がある。
  // ここでは終了時点の状態を全部出し、開始前から dirty だったものに印を付けるに留める。
  const beforePaths = new Set(parsePorcelainZ(before?.status ?? "").map((entry) => entry.path));
  const changed = parsePorcelainZ(after.status).map((entry) => ({
    ...entry,
    pre_existing: beforePaths.has(entry.path),
  }));
  return {
    head_before: before?.head ?? null,
    head_after: after.head,
    head_moved: Boolean(before?.head) && before.head !== after.head,
    changed_files: changed,
    diff_stat: (gitRaw(cwd, ["diff", "--stat", "HEAD"]) ?? "").replace(/\n+$/, ""),
  };
}
