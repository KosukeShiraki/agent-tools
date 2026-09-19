// エージェント CLI の起動・監視・打ち切り・記録。どの CLI を動かすかは知らない。
//
// アダプタから受け取るのは「argv と env をどう組むか」と「イベント 1 行から何が
// 読み取れるか」だけで、永続化（meta / messages / sessions 索引）はすべてここで行う。
// アダプタを純関数に保つと、argv とイベント解釈が spawn 無しでテストできる。

import { spawn } from "node:child_process";

import { readEnvInt } from "./env.mjs";
import {
  canIdentifyProcesses,
  currentBootId,
  isAlive,
  killTree,
  processMarkerMatch,
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

const MAX_STDERR_CHARS = 16_000;
const KILL_GRACE_MS = 3_000; // SIGTERM から SIGKILL までの猶予
const KILL_SETTLE_MS = 2_000; // SIGKILL 後に stdio が閉じるのを待つ上限
const DRAIN_AFTER_EXIT_MS = 1_000; // exit 後、孫が握る stdout を待つ上限
// 改行の来ない巨大な stdout でメモリを食い潰さないための上限。
const MAX_STDOUT_BUFFER_CHARS = 4 * 1024 * 1024;
// events.jsonl に残す 1 行の上限。超えた行は切り詰めて記録する。
const MAX_EVENT_LINE_CHARS = 256 * 1024;
// 放置された run を無限に走らせないための上限。
const HARD_LIMIT_MS = readEnvInt(
  "AGENT_EXEC_HARD_LIMIT_MS",
  "CODEX_MCP_HARD_LIMIT_MS",
  7_200_000,
  1_000,
);

/** run_id -> 実行中レコード */
const activeRuns = new Map();

// run_id -> 確定済みだが、まだプロセス群の停止を待っているレコード。
//
// **「親 CLI が終了した」と「run のプロセス群が止まった」は別物である。** 親が SIGTERM で
// 素直に落ちても、SIGTERM を無視する孫が同じプロセスグループに残ることがある。確定と
// 同時に手放していたので、(1) repo 予約が空いて次の apply が同じ作業ツリーに重なり、
// (2) shutdownAll が activeRuns しか見ないためサーバ終了時の停止対象から漏れていた。
// (2) は meta が既に killed なので次回起動の孤児回収にも拾われず、孫が残り続ける。
const pendingKills = new Map();

// 確定済みの run は返さない（status / result は記録から復元する側へ倒す）。
export function getActive(runId) {
  return activeRuns.get(runId);
}

// 実行枠を握っている run。停止待ちも枠を握ったままなので、ここに含める。
export function activeRunIds() {
  return [...activeRuns.keys(), ...pendingKills.keys()];
}

export { currentBootId, isAlive, processStartTime } from "./platform.mjs";

// meta が指すプロセスが今も生きているか。pid の生存だけでは PID 再利用と区別できないので、
// (1) 起動時の boot_id が現在と一致する (2) pid が生きている (3) そのプロセスの
// コマンドラインにマーカー（run_id）が入っている、の 3 つを重ねる。
//
// 3 値なのが要点。判定できない run に "dead" を返すと、実際には走っている run に対して
// 「報告が記録されていません」と断言してしまう。呼び出し側が失敗と判断して、apply なら
// 破壊的な再実行に走る。判定できないときは "unknown" を返し、呼び出し側に伝えさせる。
//
// "unknown" になる経路は 2 つある。(a) 起動時に argv でマーカーを確認できなかった
// （meta.reclaimable === false）、(b) 起動時は確認できたが、**今の照会に失敗した**。
// (b) は (a) と違って記録からは分からないので、platform 側で 3 値にして受け取る。
//
// @returns {"alive"|"dead"|"unknown"}
export function runLiveness(meta) {
  if (!meta || !Number.isInteger(meta.pid) || !meta.run_id) return "dead";
  const bootId = currentBootId();
  if (bootId && meta.boot_id && meta.boot_id !== bootId) return "dead";
  if (!isAlive(meta.pid)) return "dead";
  // 起動時にマーカーを argv 内に確認できなかった run。pid は生きているが、それが
  // この run のものだと言い切れない。
  if (meta.reclaimable === false) return "unknown";
  const marker = meta.argv_marker ?? meta.run_id;
  // "別プロセスだ" と**確認できたとき**だけ dead。OS への照会自体が失敗した場合
  // （Windows の PowerShell がこけた、Linux の hidepid など）は unknown で、
  // ここを dead に倒すと照会の不調がそのまま記録の削除・誤った失敗応答になる。
  const verdict = processMarkerMatch(meta.pid, marker);
  if (verdict === "match") return "alive";
  return verdict === "mismatch" ? "dead" : "unknown";
}

// prune 用。"unknown" は消さない側（残す側）に倒す。
export function isRunAlive(meta) {
  return runLiveness(meta) !== "dead";
}

// ---------------------------------------------------------------- イベントの適用

function newProgress() {
  return {
    sessionId: undefined,
    itemCounts: {},
    messages: [],
    failure: undefined,
    lastItemType: undefined,
    eventCount: 0,
    usage: undefined,
    extra: {},
  };
}

// アダプタが返した delta を進捗へ反映し、必要なものだけ即時に永続化する。
// 即時に書くのは sessionId / 終端 / failure の 3 つだけ。これらはサーバが落ちても
// 引き継げる必要がある。それ以外（usage など）は finalize でまとめて書く
// （claude の rate_limit_event のように毎秒流れるものがあり、都度 meta を全書き換え
// していると I/O が無駄になる）。
//
// itemTypes / messages が配列なのは、1 イベントに複数の事実が入る CLI があるため
// （claude の assistant イベントは thinking と text と tool_use を同時に持つ）。
function applyDelta(record, delta, runId) {
  if (!delta) return;
  const progress = record.progress;
  if (typeof delta.sessionId === "string") {
    progress.sessionId = delta.sessionId;
    // 完了を待たずに残す。サーバが落ちても session_id を引き継げるようにするため。
    // thread_id は既存の記録が使っているキー。新しい session_id と両方書く。
    updateMeta(runId, { thread_id: delta.sessionId, session_id: delta.sessionId });
    const meta = readMeta(runId);
    if (meta) {
      // run が prune されても resume できるよう、索引は別に持つ。backend もここに
      // 書く。run 本体から引くと、prune で run が消えた後に「どの CLI のセッションか」
      // が分からなくなり、resume が codex 扱いに倒れて拒否される。
      recordSession(delta.sessionId, {
        run_id: runId,
        cwd: meta.cwd,
        tool: meta.tool,
        backend: record.adapter.id,
      });
    }
  }
  for (const itemType of delta.itemTypes ?? []) {
    progress.itemCounts[itemType] = (progress.itemCounts[itemType] ?? 0) + 1;
    progress.lastItemType = itemType;
  }
  for (const message of delta.messages ?? []) {
    progress.messages.push(message);
    appendMessage(runId, message);
  }
  // CLI 自身が最終メッセージをファイルへ書かない場合はここで書く（codex は -o が書く）。
  if (typeof delta.finalMessage === "string") {
    writeArtifact(runId, "last-message.txt", delta.finalMessage);
  }
  if (delta.usage) progress.usage = delta.usage;
  if (delta.extra) Object.assign(progress.extra, delta.extra);
  if (delta.completed) {
    // 終端を見たことを記録に残す。一覧・状態・結果のどこからでも同じ判定ができる。
    // turn_completed は既存の記録が使っているキー。新旧の両方を書く。
    updateMeta(runId, { terminal_seen: true, turn_completed: true });
  }
  if (typeof delta.failure === "string") {
    progress.failure = delta.failure;
    updateMeta(runId, { failure: delta.failure });
  }
  // 続行させてはいけない状態（子が MCP を継承して再帰しかけている等）。
  // 警告で済ませると課金が伸び続けるので、その場で打ち切る。
  if (typeof delta.abort === "string") {
    progress.failure = delta.abort;
    updateMeta(runId, { failure: delta.abort });
    process.stderr.write(`[${runId}] ${delta.abort} — 打ち切ります\n`);
    killRun(runId, delta.abort);
  }
}

// ---------------------------------------------------------------- 起動と監視

// run を手放す。ここで初めて repo 予約と実行枠が返る（onFinish が両方を解放する）。
// 打ち切り中は呼ばない——親の終了で解放すると、孫がまだ触っている作業ツリーへ
// 次の apply が入れてしまう。
function releaseRun(record) {
  if (record.released) return;
  record.released = true;
  pendingKills.delete(record.runId);
  if (record.onFinish) {
    try {
      record.onFinish(record);
    } catch {
      /* 呼び出し側の都合で失敗しても run の確定は済んでいる */
    }
  }
}

export function launch({ runId, adapter, argv, marker, prompt, cwd, env, onFinish }) {
  // アダプタが申告したマーカーが本当に argv に現れるか、起動前に確かめる。
  // ここを信用のままにすると、孤児回収と生死判定が「黙って無効化される」形で壊れる。
  const markerOk = typeof marker === "string" && argv.some((a) => a.includes(marker));
  if (marker && !markerOk) {
    process.stderr.write(
      `[${runId}] マーカー "${marker}" が argv に現れません。この run は孤児回収の対象から外します\n`,
    );
  }

  let child;
  try {
    // detached: true でプロセスグループを作り、打ち切り時に孫ごと落とせるようにする。
    child = spawn(adapter.bin(), argv, {
      cwd,
      env: buildChildEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnExtras(),
    });
  } catch (err) {
    return { spawnError: String(err?.message ?? err) };
  }

  const record = {
    runId,
    adapter,
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
  // 追跡が切れた後でも生死を判定できるよう、子の pid・管理サーバの pid・
  // 起動時の boot_id を残す（PID 再利用と区別するため）。
  updateMeta(runId, {
    pid: child.pid ?? null,
    server_pid: process.pid,
    server_start: processStartTime(process.pid),
    boot_id: currentBootId(),
    backend: adapter.id,
    argv_marker: markerOk ? marker : null,
    reclaimable: markerOk,
  });

  const finalize = ({ code, signal }) => {
    if (record.state !== "running") return;
    // 打ち切り中は SIGKILL の予約を残す。親 CLI が先に終了しても、SIGTERM を
    // 無視した孫が同じプロセスグループに残っていることがあるため（F-02）。
    // 予約が発火するか、打ち切りでない終了なら、ここで解除してよい。
    if (!record.killing) clearTimeout(record.killTimer);
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
      thread_id: record.progress.sessionId ?? null,
      session_id: record.progress.sessionId ?? null,
      item_counts: record.progress.itemCounts,
      usage: record.progress.usage ?? null,
      note: record.spawnFailed ?? record.killReason ?? null,
      spawn_failed: record.spawnFailed ?? null,
      ...record.progress.extra,
    });
    // 応答は今すぐ返してよい。親 CLI の結末はもう分かっているので、呼び出し側を
    // 孫の停止まで待たせる理由が無い。
    for (const waiter of record.waiters) waiter(record.state);
    record.waiters.clear();
    // ただし**手放すのは別**。打ち切り中なら、SIGKILL を撃ち終えるまで repo 予約と
    // 実行枠を握り、サーバ終了時の停止対象にも残す。
    if (record.killing) pendingKills.set(runId, record);
    else releaseRun(record);
  };
  record.finalize = finalize;
  record.onFinish = onFinish;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    record.stdoutBuffer += chunk;
    let index;
    while ((index = record.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = record.stdoutBuffer.slice(0, index).trim();
      record.stdoutBuffer = record.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      // 生ログは残すが、1 行が極端に長いときは縮める。縮め方はアダプタが知っている。
      appendEvent(
        runId,
        line.length > MAX_EVENT_LINE_CHARS ? adapter.shrinkEventLine(line) : line,
      );
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // JSON でない行は生ログにだけ残す
      }
      record.progress.eventCount += 1;
      applyDelta(record, adapter.parseEvent(event), runId);
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
    record.spawnFailed = `${adapter.id} の起動に失敗しました: ${String(err?.message ?? err)}`;
    finalize({ code: null, signal: null });
  });

  // close は stdio が全て閉じるまで来ない。子が stdout を継いだ孫を残すと
  // 永久に来ないため、exit を見て短い猶予で確定させる。
  child.on("exit", (code, signal) => {
    setTimeout(() => finalize({ code, signal }), DRAIN_AFTER_EXIT_MS).unref();
  });
  child.on("close", (code, signal) => finalize({ code, signal }));

  record.hardTimer = setTimeout(() => {
    killRun(runId, `上限 ${HARD_LIMIT_MS} ms に達したため打ち切りました`);
  }, HARD_LIMIT_MS);
  record.hardTimer.unref();

  child.stdin.on("error", () => {}); // 子が先に stdin を閉じても落とさない
  child.stdin.end(prompt);

  return { record };
}

// アダプタが返した env を親の環境に重ねる。値が undefined のキーは「親から削除」を意味する
// （親セッションの環境変数が子を誤動作させる場合に使う）。
function buildChildEnv(env) {
  if (!env || Object.keys(env).length === 0) return process.env;
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
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
  // 打ち切り要求中であることを残す。これが立っている間は、親 CLI が先に終わって
  // finalize が走っても SIGKILL の予約を取り消さない（下記）。
  record.killing = true;
  killTree(record.child.pid, "SIGTERM");
  record.killTimer = setTimeout(() => {
    // 「親 CLI が終了した」と「run のプロセス群が止まった」は別物である。
    // 親が SIGTERM で素直に落ちても、SIGTERM を無視する孫が同じプロセスグループに
    // 残ることがある。以前はここで record.state を見ていたため、親の exit で
    // finalize が走ると（1 秒後）この SIGKILL が撃たれず、孫が生き延びていた。
    // 見るのは run の状態ではなく「打ち切りが完了したか」にする。
    if (!record.killing) return;
    record.killing = false;
    // PID 再利用への誤爆が心配な処理だが、SIGTERM を送ってから 3 秒以内であり、
    // その間に PID が一周して別プロセスに割り当たることは事実上ない。
    killTree(record.child.pid, "SIGKILL");
    // 孫が stdout を握ったままでも必ず確定させる（finalize 済みなら何もしない）。
    // **手放すのはここ。** SIGKILL を撃ち終えて初めて repo 予約と実行枠を返す。
    record.settleTimer = setTimeout(
      () => {
        record.finalize({ code: null, signal: "SIGKILL" });
        releaseRun(record);
      },
      KILL_SETTLE_MS,
    );
    record.settleTimer.unref();
  }, KILL_GRACE_MS);
  record.killTimer.unref();
  return true;
}

// 前回のサーバが SIGKILL などで落ちると、detached の子が孤児として残る。
// 起動時に回収する。ただし別セッションのサーバが管理している run は触らない
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
    // "alive" と確認できたものだけ落とす。"unknown"（マーカーを確認できない起動だった）
    // は触らない。誤爆して他のセッションやビルドを巻き込むより、取り逃がす方を選ぶ。
    if (runLiveness(meta) !== "alive") continue;
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
  // 打ち切りの完了を待っている run も落とす。ここを見ないと、親 CLI が終わった直後に
  // サーバが終了した場合に **SIGKILL の予約ごと消えて孫だけが残る**。meta は既に
  // killed なので次回起動の孤児回収も拾わない（回収は state=running だけを見る）。
  // 状態はもう確定しているので、書き換えずプロセス群だけ確実に止める。
  for (const record of pendingKills.values()) {
    killTree(record.child.pid, "SIGKILL");
  }
  activeRuns.clear();
  pendingKills.clear();
}

export function snapshot(record) {
  return {
    state: record.state,
    elapsed_ms: Date.now() - record.startedAt,
    thread_id: record.progress.sessionId ?? null,
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
    // 自分が抱えている run なので身元は自明。reconstruct と形を揃える。
    liveness: "alive",
  };
}
