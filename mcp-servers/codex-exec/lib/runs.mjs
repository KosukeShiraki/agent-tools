// run（codex の1回の実行）の永続化。
//
// MCP の応答が失われても——クライアント側のタイムアウト、サーバの再起動、
// 長時間実行の打ち切り——ここに残った記録から後で報告を取り出せるようにする。

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 既定の置き場は server の隣ではなく home の下。server を git repo で配る場合に、
// 実行記録（数百 MB になる）が clone したディレクトリへ混ざらないようにする。
export const RUNS_ROOT =
  process.env.CODEX_MCP_RUNS_DIR || join(homedir(), ".claude", "codex-exec", "runs");

const MAX_RUNS = Math.max(1, Number.parseInt(process.env.CODEX_MCP_MAX_RUNS ?? "", 10) || 50);
const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// events.jsonl は長い作業だと大きくなる。読むのは末尾だけにする
// （thread_id は meta.json に控えるので、先頭を読み落としても困らない）。
const MAX_EVENTS_READ_BYTES = 2 * 1024 * 1024;
// session_id の索引。run の保持期間とは独立に持つ（run が prune されても
// 会話を継続できるようにするため）。1 ファイルにまとめると read-modify-write が
// 複数サーバ間で衝突して登録が消えるので、session ごとに分ける。
const SESSIONS_DIR = "sessions";
// 完了直後の run は応答を組み立てている最中かもしれないので、この間は消さない。
const PRUNE_GRACE_MS = Math.max(
  0,
  Number.parseInt(process.env.CODEX_MCP_PRUNE_GRACE_MS ?? "", 10) || 120_000,
);
// 報告本文の 1 件あたりの上限。events.jsonl とは別に残す。
const MAX_MESSAGE_CHARS = 256 * 1024;
// codex_verify の workspace は test 成果物で重くなる（実測で 1 run 170MB）。
// 記録（meta / events / messages）は軽いので残し、workspace だけ先に落とす。
const WORKSPACE_TTL_MS = Math.max(
  0,
  Number.parseInt(process.env.CODEX_MCP_WORKSPACE_TTL_MS ?? "", 10) || 24 * 60 * 60 * 1000,
);
// run をまたいで共有する cache の上限。超えたら捨てる（次の run で作り直される）。
const MAX_CACHE_BYTES = Math.max(
  0,
  Number.parseInt(process.env.CODEX_MCP_MAX_CACHE_BYTES ?? "", 10) || 3 * 1024 * 1024 * 1024,
);
// cache のサイズ測定は file 数が多いと重いので、間隔をあける。
const CACHE_CHECK_INTERVAL_MS = Math.max(
  0,
  Number.parseInt(process.env.CODEX_MCP_CACHE_CHECK_INTERVAL_MS ?? "", 10) || 60 * 60 * 1000,
);

// run_id は path の一部になるので、生成形式そのものを検証してから使う。
// ミリ秒まで入れる。listRunIds は名前順に並べるので、ここが粗いと同一秒内の
// 新旧が乱数で決まってしまう。
const RUN_ID_PATTERN = /^\d{8}-\d{6}-\d{3}-[a-z0-9]{4}$/;

export function newRunId() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

export function isValidRunId(value) {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function runDir(runId) {
  if (!isValidRunId(runId)) throw new Error(`run_id の形式が不正です: ${runId}`);
  return join(RUNS_ROOT, runId);
}

// run_id を採番してディレクトリを排他的に作る。同じ秒に採番が衝突しても、
// 既存の run を黙って上書きしない（mkdir は recursive を使わない）。
export function createRun(meta, prompt) {
  mkdirSync(RUNS_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = newRunId();
    try {
      mkdirSync(join(RUNS_ROOT, runId));
    } catch (err) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
    writeFileSync(join(RUNS_ROOT, runId, "prompt.txt"), prompt);
    writeMeta(runId, { ...meta, run_id: runId });
    return runId;
  }
  throw new Error("run_id を採番できませんでした");
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path); // 同一 FS の rename は不可分。読み手は常に完全な JSON を見る
}

export function writeMeta(runId, meta) {
  writeJsonAtomic(join(runDir(runId), "meta.json"), meta);
}

// session_id → 作られた run の情報。run が prune されても resume できるよう、
// 索引だけは別に残す。1 セッション 1 ファイルなので、他プロセスの登録を消さない。
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionPath(sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("session_id の形式が不正です");
  return join(RUNS_ROOT, SESSIONS_DIR, `${sessionId}.json`);
}

export function recordSession(sessionId, info) {
  try {
    const path = sessionPath(sessionId);
    mkdirSync(join(RUNS_ROOT, SESSIONS_DIR), { recursive: true });
    writeJsonAtomic(path, { ...info, session_id: sessionId, last_seen: new Date().toISOString() });
  } catch {
    /* 索引が書けなくても実行は続ける */
  }
}

export function lookupSession(sessionId) {
  try {
    const found = JSON.parse(readFileSync(sessionPath(sessionId), "utf8"));
    return found && typeof found === "object" ? found : undefined;
  } catch {
    return undefined;
  }
}

// 報告本文は events.jsonl とは別に残す。イベントは切り詰めと末尾読みの対象なので、
// そこだけを頼りにすると巨大な報告や長いログで復元できなくなる。
export function appendMessage(runId, text) {
  const trimmed =
    text.length > MAX_MESSAGE_CHARS
      ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n…（全 ${text.length} 文字を切り詰め）`
      : text;
  try {
    appendFileSync(join(runDir(runId), "messages.jsonl"), `${JSON.stringify({ text: trimmed })}\n`);
  } catch {
    /* 記録に失敗しても実行は続ける */
  }
}

export function readMessages(runId) {
  const raw = readArtifact(runId, "messages.jsonl");
  if (!raw) return [];
  const messages = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.text === "string") messages.push(parsed.text);
    } catch {
      /* 書きかけの行は捨てる */
    }
  }
  return messages;
}

export function readMeta(runId) {
  try {
    return JSON.parse(readFileSync(join(runDir(runId), "meta.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function updateMeta(runId, patch) {
  const meta = readMeta(runId);
  if (!meta) return undefined;
  const next = { ...meta, ...patch };
  try {
    writeMeta(runId, next);
  } catch {
    /* ディレクトリが消えている場合は諦める */
  }
  return next;
}

export function appendEvent(runId, line) {
  try {
    appendFileSync(join(runDir(runId), "events.jsonl"), `${line}\n`);
  } catch {
    /* 記録に失敗しても実行は続ける */
  }
}

export function writeArtifact(runId, name, content) {
  try {
    writeFileSync(join(runDir(runId), name), content);
  } catch {
    /* 同上 */
  }
}

export function readArtifact(runId, name) {
  try {
    const path = join(runDir(runId), name);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

// ファイルの末尾 maxBytes だけを読む。先頭が欠けた行は JSON.parse に失敗して捨てられる。
function readTail(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// events.jsonl のうち、パースできた行だけを返す（末尾が書きかけでも壊れない）。
export function readEvents(runId, limit) {
  let raw;
  try {
    raw = readTail(join(runDir(runId), "events.jsonl"), MAX_EVENTS_READ_BYTES);
  } catch {
    return [];
  }
  if (!raw) return [];
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const picked = typeof limit === "number" ? lines.slice(-limit) : lines;
  const events = [];
  for (const line of picked) {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 書きかけの行は捨てる */
    }
  }
  return events;
}

export function listRunIds() {
  try {
    return readdirSync(RUNS_ROOT)
      .filter((name) => isValidRunId(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ディレクトリの合計サイズ。上限を超えた時点で打ち切る（全部数えなくても判定できる）。
function directorySize(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += statSync(full).size;
      } catch (err) {
        // 測っている間に消えたのは想定内。それ以外まで握り潰すと、import 漏れのような
        // 不具合が「サイズ 0」として表に出ないまま回収を止めてしまう。
        if (err?.code !== "ENOENT") {
          process.stderr.write(`warning: サイズ測定に失敗しました (${full}): ${err}\n`);
        }
      }
      if (total > limit) return total;
    }
  }
  return total;
}

let lastCacheCheck = 0;

// 共有 cache が膨らみすぎたら丸ごと捨てる。中身は再取得できるものだけなので、
// 消しても壊れない（次の run で作り直される）。
export function pruneSharedCache(force = false) {
  const now = Date.now();
  if (!force && now - lastCacheCheck < CACHE_CHECK_INTERVAL_MS) return 0;
  lastCacheCheck = now;
  const dir = join(RUNS_ROOT, ".cache");
  if (!existsSync(dir)) return 0;
  const bytes = directorySize(dir, MAX_CACHE_BYTES);
  if (bytes <= MAX_CACHE_BYTES) return 0;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return 0;
  }
  return bytes;
}

// 古い run を捨てる。実際に動いているものは消さない。
// `isRunning` は「meta が running のとき、本当に動いているか」を判定する関数
// （プロセスの生死判定は lib/codex.mjs 側にあるので注入してもらう）。
export function pruneRuns(isRunning = () => true) {
  const ids = listRunIds();
  const now = Date.now();
  let kept = 0;
  for (const runId of ids) {
    const meta = readMeta(runId);
    if (!meta) {
      // 書き込み途中や他プロセスの run かもしれない。消さない側に倒す。
      kept += 1;
      continue;
    }
    if (meta.state === "running" && isRunning(meta)) {
      kept += 1;
      continue;
    }
    // 終わった直後の run は、呼び出し元がまだ報告を読んでいる最中かもしれない。
    const finishedAt = meta.finished_at ? Date.parse(meta.finished_at) : Number.NaN;
    if (Number.isFinite(finishedAt) && now - finishedAt < PRUNE_GRACE_MS) {
      kept += 1;
      continue;
    }
    // 記録より先に workspace を落とす。報告は残したいが、test 成果物は残さなくてよい。
    if (Number.isFinite(finishedAt) && now - finishedAt > WORKSPACE_TTL_MS) {
      try {
        rmSync(join(RUNS_ROOT, runId, "workspace"), { recursive: true, force: true });
      } catch {
        /* 消せなければ次回に持ち越す */
      }
    }
    const startedAt = meta.started_at ? Date.parse(meta.started_at) : Number.NaN;
    const tooOld = Number.isFinite(startedAt) && now - startedAt > MAX_RUN_AGE_MS;
    kept += 1;
    if (kept > MAX_RUNS || tooOld) {
      try {
        rmSync(join(RUNS_ROOT, runId), { recursive: true, force: true });
      } catch {
        /* 消せなければ放置 */
      }
    }
  }
}
