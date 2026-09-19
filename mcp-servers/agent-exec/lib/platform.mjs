// OS ごとに違うプロセス操作を 1 か所へ集める。
//
// ここで扱うのは「その pid は本当にこの run の codex か」を判定する材料と、
// プロセスツリーの止め方である。PID は再利用されるので、生存確認だけでは
// 無関係なプロセスを掴む。特にマシン再起動をまたぐと PID は低位から振り直される。
//
// Linux は /proc を直接読むのが速くて確実。macOS と Windows は外部コマンドに頼るため、
// 1 プロセスずつ問い合わせると prune のように全 run を走査する処理で遅くなる。
// そこで全プロセスを一度に取って短時間だけキャッシュする。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MAC = process.platform === "darwin";

const TABLE_TTL_MS = 1_000;
const COMMAND_TIMEOUT_MS = 5_000;

let table = { at: 0, byPid: new Map() };

function runCommand(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 生存確認

// シグナル 0 は実際には送らず、存在だけを調べる。Windows でも Node が対応している。
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // 権限が無いだけなら生きている
  }
}

// ---------------------------------------------------------------- 再起動の識別

// 再起動ごとに変わる値。これが違う run の pid は、まず別プロセスに再利用されている。
export function currentBootId() {
  if (IS_LINUX) {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return null;
    }
  }
  if (IS_MAC) {
    // `{ sec = 1758000000, usec = 123456 } Sat Sep 13 ...`
    const out = runCommand("sysctl", ["-n", "kern.boottime"]);
    const sec = out?.match(/sec\s*=\s*(\d+)/)?.[1];
    return sec ? `boottime-${sec}` : null;
  }
  if (IS_WINDOWS) {
    const out = runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')",
    ]);
    const value = out?.trim();
    return value ? `boottime-${value}` : null;
  }
  return null;
}

// ---------------------------------------------------------------- プロセス情報

function linuxProcessInfo(pid) {
  let commandLine;
  let startTime;
  try {
    // /proc/<pid>/cmdline は引数を NUL 区切りで並べる
    commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return undefined;
  }
  try {
    // comm には空白や括弧が入りうるので、最後の ')' 以降を見る。
    // starttime は 22 番目のフィールド（state から数えて 20 番目）。
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    startTime = null;
  }
  return { pid, commandLine, startTime };
}

function macProcessTable() {
  // lstart は「曜日 月 日 時刻 年」の 5 トークン。args は残り全部。
  const out = runCommand("ps", ["-Awwo", "pid=,lstart=,args="]);
  const byPid = new Map();
  if (!out) return byPid;
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    byPid.set(pid, { pid, startTime: match[2], commandLine: match[3] });
  }
  return byPid;
}

function windowsProcessTable() {
  const script =
    "ConvertTo-Json -Compress -Depth 2 @(Get-CimInstance Win32_Process | " +
    "ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; " +
    "start = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }; " +
    "cmd = $_.CommandLine } })";
  const out = runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const byPid = new Map();
  if (!out) return byPid;
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    return byPid;
  }
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const pid = Number(row?.pid);
    if (!Number.isInteger(pid)) continue;
    byPid.set(pid, {
      pid,
      startTime: typeof row.start === "string" ? row.start : null,
      commandLine: typeof row.cmd === "string" ? row.cmd : "",
    });
  }
  return byPid;
}

function processTable() {
  if (Date.now() - table.at < TABLE_TTL_MS) return table.byPid;
  const byPid = IS_WINDOWS ? windowsProcessTable() : macProcessTable();
  table = { at: Date.now(), byPid };
  return byPid;
}

// 指定 pid の起動時刻とコマンドラインを返す。取れなければ undefined。
export function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) return linuxProcessInfo(pid);
  return processTable().get(pid);
}

// その pid のコマンドラインに marker が含まれるか。判定できない場合は false
// （「自分のものではない」と扱う）。殺す前の身元確認に使うので、迷ったら止めない。
export function processHasMarker(pid, marker) {
  const info = processInfo(pid);
  return typeof info?.commandLine === "string" && info.commandLine.includes(marker);
}

export function processStartTime(pid) {
  return processInfo(pid)?.startTime ?? null;
}

// ---------------------------------------------------------------- 停止

// 子プロセス「ツリー」を止める。codex は内部でシェル等を起こすので、
// 本体だけを止めても孫が残る。
export function killTree(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (IS_WINDOWS) {
    // Windows にシグナルは無い。taskkill の /T が子孫を辿る。
    // SIGTERM 相当は穏当な終了要求、SIGKILL 相当は /F で強制する。
    const args = signal === "SIGKILL" ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    runCommand("taskkill", args);
    return;
  }
  try {
    // detached: true で作ったプロセスグループごと送る（pid の符号を反転）
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* すでに終了している */
    }
  }
}

// spawn に渡す OS 依存のオプション。
export function spawnExtras() {
  // detached は POSIX では新しいプロセスグループ、Windows では
  // CREATE_NEW_PROCESS_GROUP になる。どちらも「親と道連れにしない」ために要る。
  return IS_WINDOWS ? { detached: true, windowsHide: true } : { detached: true };
}

// この OS でプロセスの身元確認ができるか。できない環境では孤児の回収を見送る
// （無関係なプロセスを殺すより、回収しない方が安全）。
export function canIdentifyProcesses() {
  if (IS_LINUX) return true;
  if (IS_MAC || IS_WINDOWS) return processTable().size > 0;
  return false;
}
