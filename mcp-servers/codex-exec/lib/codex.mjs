// codex exec の起動・イベント処理・実行中 run の管理。
//
// `--json` を使うのは、最終メッセージ（-o）が最後に一度しか書かれないためである。
// 長時間の作業では、報告を書き出す前に打ち切られると内容が丸ごと失われる。
// イベントを逐次受け取って蓄積すれば、打ち切っても「そこまでの報告」を返せる。

import { execFileSync, spawn } from "node:child_process";

import {
  canIdentifyProcesses,
  currentBootId,
  isAlive,
  killTree,
  processHasMarker,
  processStartTime,
  spawnExtras,
} from "./platform.mjs";
import {
  appendEvent,
  appendMessage,
  listRunIds,
  readMeta,
  recordSession,
  updateMeta,
  writeArtifact,
} from "./runs.mjs";

const CODEX_BIN = process.env.CODEX_BIN || "codex";

const MAX_STDERR_CHARS = 16_000;
const KILL_GRACE_MS = 3_000; // SIGTERM から SIGKILL までの猶予
const KILL_SETTLE_MS = 2_000; // SIGKILL 後に stdio が閉じるのを待つ上限
const DRAIN_AFTER_EXIT_MS = 1_000; // exit 後、孫が握る stdout を待つ上限
// 放置された run を無限に走らせないための上限。
// 改行の来ない巨大な stdout でメモリを食い潰さないための上限。
const MAX_STDOUT_BUFFER_CHARS = 4 * 1024 * 1024;
// events.jsonl に残す 1 行の上限。超えた行は切り詰めて記録する。
const MAX_EVENT_LINE_CHARS = 256 * 1024;
const HARD_LIMIT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CODEX_MCP_HARD_LIMIT_MS ?? "", 10) || 7_200_000,
);

/** run_id -> 実行中レコード */
const activeRuns = new Map();

export function getActive(runId) {
  return activeRuns.get(runId);
}

export function activeRunIds() {
  return [...activeRuns.keys()];
}

export { currentBootId, isAlive, processStartTime } from "./platform.mjs";

// meta が指す codex が今も生きているか。pid の生存だけでは PID 再利用と区別できないので、
// (1) 起動時の boot_id が現在と一致する (2) pid が生きている (3) そのプロセスの
// コマンドラインに run_id が入っている、の 3 つを重ねる。codex には必ず
// `-o <runs>/<run_id>/last-message.txt` が渡るので、run_id は偶然一致しない目印になる。
export function isRunAlive(meta) {
  if (!meta || !Number.isInteger(meta.pid) || !meta.run_id) return false;
  const bootId = currentBootId();
  if (bootId && meta.boot_id && meta.boot_id !== bootId) return false;
  if (!isAlive(meta.pid)) return false;
  return processHasMarker(meta.pid, meta.run_id);
}

export function buildArgs({
  sandbox,
  cwd,
  model,
  effort,
  resumeSessionId,
  lastMessagePath,
  skipGitRepoCheck,
}) {
  const args = ["exec"];
  if (resumeSessionId) {
    // resume が受け付けるのは --json / -o / -m / -c / --skip-git-repo-check などに限られ、
    // -s / -C / --color は無い（codex 0.154.0 で実測）。sandbox は config override で固定し、
    // 作業ディレクトリは spawn の cwd で与える。"-" で prompt を stdin から読ませる。
    args.push("resume", resumeSessionId, "-", "-c", `sandbox_mode="${sandbox}"`);
  } else {
    args.push("-s", sandbox, "-C", cwd, "--color", "never");
  }
  args.push("--json", "-o", lastMessagePath);
  if (skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (model) args.push("-m", model);
  // model / effort / sandbox はいずれも検証済みの値のみ埋め込む。
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  return args;
}

// codex は API のエラー本文を JSON 文字列のまま載せてくる。読める形にする。
function extractApiMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.error?.message ?? parsed?.message;
    return typeof inner === "string" ? inner : raw;
  } catch {
    return raw;
  }
}

function shrinkEventLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed?.item?.text === "string") {
      const { text } = parsed.item;
      parsed.item.text = `${text.slice(0, 4096)}…（全 ${text.length} 文字。全文は messages.jsonl）`;
      return JSON.stringify(parsed);
    }
    return JSON.stringify({ type: "truncated_event", original_type: parsed?.type ?? null });
  } catch {
    return JSON.stringify({ type: "truncated_line", chars: line.length });
  }
}

function newProgress() {
  return {
    threadId: undefined,
    itemCounts: {},
    messages: [],
    failure: undefined,
    lastItemType: undefined,
    eventCount: 0,
    usage: undefined,
  };
}

// 実測できているのは thread.started / turn.started / item.completed / turn.completed の
// 4 種と、item.type = agent_message の text だけ。未知の item は type を数えるに留め、
// 中身の解釈は生ログ（events.jsonl）に委ねる。
function applyEvent(progress, event, runId) {
  progress.eventCount += 1;
  if (!event || typeof event !== "object") return;
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    progress.threadId = event.thread_id;
    // 完了を待たずに残す。サーバが落ちても session_id を引き継げるようにするため。
    updateMeta(runId, { thread_id: event.thread_id });
    const meta = readMeta(runId);
    if (meta) {
      // run が prune されても resume できるよう、索引は別に持つ。
      recordSession(event.thread_id, { run_id: runId, cwd: meta.cwd, tool: meta.tool });
    }
    return;
  }
  if (event.type === "item.completed") {
    const itemType = typeof event.item?.type === "string" ? event.item.type : "unknown";
    progress.itemCounts[itemType] = (progress.itemCounts[itemType] ?? 0) + 1;
    progress.lastItemType = itemType;
    if (itemType === "agent_message" && typeof event.item?.text === "string") {
      progress.messages.push(event.item.text);
      appendMessage(runId, event.item.text);
    }
    return;
  }
  if (event.type === "turn.completed") {
    if (event.usage) progress.usage = event.usage;
    // 終端を見たことを記録に残す。一覧・状態・結果のどこからでも同じ判定ができる。
    updateMeta(runId, { turn_completed: true });
    return;
  }
  // モデルが使えない等のエラーはここに出る。拾わないと「報告を返しませんでした」
  // としか言えず、原因（例: そのモデルはこのアカウントで使えない）が伝わらない。
  if (event.type === "turn.failed" || event.type === "error") {
    const message =
      typeof event.error?.message === "string"
        ? event.error.message
        : typeof event.message === "string"
          ? event.message
          : JSON.stringify(event);
    progress.failure = extractApiMessage(message);
    updateMeta(runId, { failure: progress.failure });
  }
}

// ---------------------------------------------------------------- git の差分

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

// 実行前後の状態を比べ、「この run で何が変わったか」を構造化して返す。
// codex のイベント形式に依存しないので、打ち切られても取得できる。
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

// ---------------------------------------------------------------- 起動と監視

export function launch({ runId, args, prompt, cwd, env, onFinish }) {
  let child;
  try {
    // detached: true でプロセスグループを作り、打ち切り時に孫ごと落とせるようにする。
    child = spawn(CODEX_BIN, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnExtras(),
    });
  } catch (err) {
    return { spawnError: String(err?.message ?? err) };
  }

  const record = {
    runId,
    child,
    startedAt: Date.now(),
    state: "running",
    progress: newProgress(),
    stderr: "",
    stdoutBuffer: "",
    exit: undefined,
    killReason: undefined,
    waiters: new Set(),
  };
  activeRuns.set(runId, record);
  // 追跡が切れた後でも生死を判定できるよう、codex の pid・管理サーバの pid・
  // 起動時の boot_id を残す（PID 再利用と区別するため）。
  updateMeta(runId, {
    pid: child.pid ?? null,
    server_pid: process.pid,
    server_start: processStartTime(process.pid),
    boot_id: currentBootId(),
  });

  const finalize = ({ code, signal }) => {
    if (record.state !== "running") return;
    clearTimeout(record.killTimer);
    clearTimeout(record.settleTimer);
    record.state = record.spawnFailed
      ? "failed"
      : code === 0
        ? "completed" // 打ち切り要求と正常終了が競合しても、0 で終わったなら成功扱い
        : record.killReason
          ? "killed"
          : "failed";
    record.exit = { code: code ?? null, signal: signal ?? null };
    clearTimeout(record.hardTimer);
    activeRuns.delete(runId);
    writeArtifact(runId, "stderr.log", record.stderr);
    updateMeta(runId, {
      state: record.state,
      finished_at: new Date().toISOString(),
      exit_code: record.exit.code,
      signal: record.exit.signal,
      thread_id: record.progress.threadId ?? null,
      item_counts: record.progress.itemCounts,
      usage: record.progress.usage ?? null,
      note: record.spawnFailed ?? record.killReason ?? null,
      spawn_failed: record.spawnFailed ?? null,
    });
    for (const waiter of record.waiters) waiter(record.state);
    record.waiters.clear();
    if (onFinish) {
      try {
        onFinish(record);
      } catch {
        /* 呼び出し側の都合で失敗しても run の確定は済んでいる */
      }
    }
  };
  record.finalize = finalize;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    record.stdoutBuffer += chunk;
    let index;
    while ((index = record.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = record.stdoutBuffer.slice(0, index).trim();
      record.stdoutBuffer = record.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      // 生ログは残すが、1 行が極端に長いときは縮める。文字列の途中で切ると
      // JSON が壊れて後から読めなくなるので、フィールドを切ってから組み直す。
      appendEvent(runId, line.length > MAX_EVENT_LINE_CHARS ? shrinkEventLine(line) : line);
      try {
        applyEvent(record.progress, JSON.parse(line), runId);
      } catch {
        /* JSON でない行は生ログにだけ残す */
      }
    }
    if (record.stdoutBuffer.length > MAX_STDOUT_BUFFER_CHARS) {
      process.stderr.write(
        `[${runId}] 改行の無い stdout が ${record.stdoutBuffer.length} 文字に達したため破棄しました\n`,
      );
      record.stdoutBuffer = "";
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const combined = record.stderr + chunk;
    record.stderr =
      combined.length > MAX_STDERR_CHARS
        ? combined.slice(combined.length - MAX_STDERR_CHARS)
        : combined;
  });

  // Linux では ENOENT は同期例外ではなく error イベントで来るため、ここで拾う。
  child.on("error", (err) => {
    record.spawnFailed = `codex の起動に失敗しました: ${String(err?.message ?? err)}`;
    finalize({ code: null, signal: null });
  });

  // close は stdio が全て閉じるまで来ない。codex が stdout を継いだ孫を残すと
  // 永久に来ないため、exit を見て短い猶予で確定させる。
  child.on("exit", (code, signal) => {
    setTimeout(() => finalize({ code, signal }), DRAIN_AFTER_EXIT_MS).unref();
  });
  child.on("close", (code, signal) => finalize({ code, signal }));

  record.hardTimer = setTimeout(() => {
    killRun(runId, `上限 ${HARD_LIMIT_MS} ms に達したため打ち切りました`);
  }, HARD_LIMIT_MS);
  record.hardTimer.unref();

  child.stdin.on("error", () => {}); // codex が先に stdin を閉じても落とさない
  child.stdin.end(prompt);

  return { record };
}

// 完了を待つ。timeoutMs を過ぎたら outcome:"timeout" を返すが、run は止めない
// （呼び出し側が detach するか killRun するかを決める）。
export function waitFor(record, timeoutMs) {
  return new Promise((resolve) => {
    if (record.state !== "running") {
      resolve(record.state);
      return;
    }
    const waiter = (outcome) => {
      clearTimeout(timer);
      record.waiters.delete(waiter);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      record.waiters.delete(waiter);
      resolve("timeout");
    }, timeoutMs);
    record.waiters.add(waiter);
  });
}

export function killRun(runId, reason) {
  const record = activeRuns.get(runId);
  if (!record) return false;
  if (record.killTimer) return true; // 二重に呼ばれても一度しか仕掛けない
  record.killReason = reason ?? "打ち切りました";
  killTree(record.child.pid, "SIGTERM");
  // 予約した SIGKILL を完了後に撃つと、PID が再利用された別のプロセスグループを
  // 巻き込む。finalize で必ず解除し、発火時にも状態を確かめる。
  record.killTimer = setTimeout(() => {
    if (record.state !== "running") return;
    killTree(record.child.pid, "SIGKILL");
    // 孫が stdout を握ったままでも必ず確定させる
    record.settleTimer = setTimeout(
      () => record.finalize({ code: null, signal: "SIGKILL" }),
      KILL_SETTLE_MS,
    );
    record.settleTimer.unref();
  }, KILL_GRACE_MS);
  record.killTimer.unref();
  return true;
}

// 前回のサーバが SIGKILL などで落ちると、detached の codex が孤児として残る。
// 起動時に回収する。ただし別セッションの codex-exec が管理している run は触らない
// （同じ runs/ を複数の Claude Code セッションが共有しうるため）。
export function reclaimOrphans() {
  const reclaimed = [];
  // 身元確認ができない環境では、誤って無関係なプロセスを殺すより回収を見送る。
  if (!canIdentifyProcesses()) return reclaimed;
  const bootId = currentBootId();
  for (const runId of listRunIds()) {
    const meta = readMeta(runId);
    if (!meta || meta.state !== "running") continue;
    // 再起動をまたいだ run の pid は、まず別プロセスに再利用されている。触らない。
    if (bootId && meta.boot_id && meta.boot_id !== bootId) continue;
    // 他のサーバが見ている run は触らない。ただし server_pid も再利用されうるので、
    // 起動時刻まで一致した場合だけ「同じサーバ」とみなす。
    if (meta.server_pid && isAlive(meta.server_pid)) {
      const sameServer =
        !meta.server_start || processStartTime(meta.server_pid) === meta.server_start;
      if (sameServer) continue;
    }
    if (!isAlive(meta.pid)) continue; // 既に終わっている。状態は記録から判定させる
    // pid の生存だけでは足りない。無関係なプロセスグループを巻き込まないよう、
    // argv に run_id が入っていることを確かめてから落とす。
    if (!processHasMarker(meta.pid, runId)) continue;
    try {
      killTree(meta.pid, "SIGKILL");
    } catch {
      /* すでに居ない */
    }
    reclaimed.push(runId);
    updateMeta(runId, {
      state: "killed",
      finished_at: new Date().toISOString(),
      note: "前回のサーバが落ちたため回収しました",
    });
  }
  return reclaimed;
}

// サーバ終了時。放置すると課金が続くので、detach 済みの run も含めて落とす。
export function shutdownAll() {
  for (const record of activeRuns.values()) {
    killTree(record.child.pid, "SIGKILL");
    try {
      updateMeta(record.runId, {
        state: "killed",
        finished_at: new Date().toISOString(),
        note: "サーバ終了により打ち切り",
      });
    } catch {
      /* 書けなければ諦める */
    }
  }
  activeRuns.clear();
}

export function snapshot(record) {
  return {
    state: record.state,
    elapsed_ms: Date.now() - record.startedAt,
    thread_id: record.progress.threadId ?? null,
    event_count: record.progress.eventCount,
    item_counts: { ...record.progress.itemCounts },
    last_item_type: record.progress.lastItemType ?? null,
    messages: [...record.progress.messages],
    usage: record.progress.usage ?? null,
    stderr_tail: record.stderr,
    exit: record.exit ?? null,
    kill_reason: record.killReason ?? null,
    failure: record.progress.failure ?? null,
    spawn_failed: record.spawnFailed ?? null,
    alive: true,
  };
}
