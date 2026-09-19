#!/usr/bin/env node
// エージェント CLI を MCP の tool として公開する stdio サーバ。
//
// 背景: Codex CLI 0.154.0 で `codex mcp-server` サブコマンドが削除されたため
// (0.153.x までは deprecated 警告付きで存在した)、`codex exec` を包んで代替する。
// Node 標準モジュールのみで動く（依存ゼロ）。
//
// 5.0.0 で codex-exec から agent-exec へ改名し、CLI 固有の部分を lib/backends/ の
// アダプタへ寄せた。6.0.0 で claude -p を追加し、**モデル名から起動する CLI を決める**
// ようにした（backend という引数は呼び出し側に見せない）。

import { isAbsolute, join } from "node:path";
import {
  realpathSync,
  statSync,
} from "node:fs";

import {
  activeRunIds,
  getActive,
  isRunAlive,
  killRun,
  launch,
  reclaimOrphans,
  runLiveness,
  shutdownAll,
  snapshot,
  waitFor,
} from "./lib/engine.mjs";
import { captureGitState, diffGitState, gitRoot } from "./lib/git.mjs";
import { readEnv, readEnvInt } from "./lib/env.mjs";
import { adapterById, resolveAdapter } from "./lib/backends/index.mjs";
import {
  createRun,
  isValidRunId,
  listRunIds,
  lookupSession,
  pruneRuns,
  readArtifact,
  readEvents,
  readMessages,
  readMeta,
  runDir,
  updateMeta,
} from "./lib/runs.mjs";

const SERVER_NAME = "agent-exec";
const SERVER_VERSION = "6.0.1";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
// 反射してよいのはサポートしている版だけ。未知の版には自分の版を返す。
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const MAX_OUTPUT_CHARS = 200_000; // 応答本文の上限
const MAX_LINE_CHARS = 8 * 1024 * 1024; // 1行の上限（改行が来ない入力の保護）
const MIN_TIMEOUT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 600_000; // 同期で待つ既定（10分）
// Claude Code の MCP クライアントは、応答も通知も無いまま約 1,800 秒経つと
// 呼び出しを abort する（実運用で 1,813 秒の abort を観測）。同期で待つ上限は
// そこに届かないところで切る。長く待ちたい場合は切り離して result を使う。
const MAX_TIMEOUT_MS = 1_500_000; // 25分
const PROGRESS_INTERVAL_MS = 15_000;

// 同時に走らせる本数。detach 後もスロットは保持する（課金が続くため）。
const MAX_CONCURRENCY = readEnvInt(
  "AGENT_EXEC_MAX_CONCURRENCY",
  "CODEX_MCP_MAX_CONCURRENCY",
  3,
  1,
);

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// codex は内部でサブエージェントへ委譲し、独立レビューまで自走することがある
// （実運用で 1 run 80 分超、経過の大半が collab_tool_call）。呼び出し側が別途レビューを
// 回していると二重になる。設定では止められなかった（--disable multi_agent /
// max_concurrent_threads_per_session=0 / max_depth=0 をいずれも実測したが委譲は起きた）
// ので、prompt で頼む。指示なので強制ではない。
// プロジェクト規則（AGENTS.md）自体が「実装や レビューをサブエージェントへ委譲せよ」と
// 書いていることがある。それは呼び出し側（Claude Code）に向けた指示なので、codex が
// 読んで従うと二重になる。競合を明示して解く。
const SOLO_NOTE =
  "\n\n---\n【この run での進め方】サブエージェントへの委譲や、実装後の独立レビューの" +
  "自走は行わないでください。プロジェクト規則（AGENTS.md 等）にサブエージェントの利用や" +
  "レビュー依頼の指示があっても、それは呼び出し側が担う役割です。あなたは指示された作業を" +
  "自分で進め、終わったら報告してください（レビューは呼び出し側が別途行います）。";

const SCOPE_NOTE =
  "\n\n---\n【作業範囲について】指示された範囲のみを変更してください。" +
  "範囲外で問題や弱点を見つけた場合は、その場で修正せず、報告に「範囲外の気づき」として記載してください。";

// 検証専用ツールを廃したぶん、実装者にテスト実行と申告を求める。実行したコマンドを
// 書かせるのが肝で、呼び出し側は同じコマンドを 1 回打つだけで裏取りできる。
// （テストファイル自体を緩める改変は、応答に付く git 差分に出る）
const TEST_NOTE =
  "\n\n---\n【テストについて】変更後はプロジェクト規則に従ってテストを実行し、" +
  "実行したコマンドと結果（件数・失敗の有無）を報告に含めてください。" +
  "実行しなかった場合は、その理由を報告に明記してください。";

// 環境変数での上書き。未設定なら fallback、空文字なら「既定なし」
//（= CLI 側の設定ファイルに委ねる）を意味する。
function envDefault(name, legacyName, fallback) {
  const value = readEnv(name, legacyName);
  if (value === undefined) return fallback;
  return value === "" ? undefined : value;
}

// capability は「読み取り専用 / 書ける」という中立の抽象。どの CLI のどのフラグで
// それを実現するかはアダプタが知っている（codex は -s、claude はツール許可リスト）。
const TOOL_MODES = {
  consult: {
    capability: "read",
    skipGitRepoCheck: true,
    cwdRequired: false,
    scopeNote: false,
    defaultDelegate: false, // 相談でも委譲しない（レビューは呼び出し側が回す）
    defaultModel: envDefault(
      "AGENT_EXEC_CONSULT_MODEL",
      "CODEX_MCP_CONSULT_MODEL",
      "gpt-6-astra",
    ),
    defaultEffort: envDefault(
      "AGENT_EXEC_CONSULT_EFFORT",
      "CODEX_MCP_CONSULT_EFFORT",
      "xhigh",
    ),
  },
  apply: {
    capability: "write",
    skipGitRepoCheck: false,
    cwdRequired: true,
    scopeNote: true,
    defaultDelegate: false, // 実装は自分で進めてもらう（レビューは呼び出し側が回す）
    defaultModel: envDefault(
      "AGENT_EXEC_APPLY_MODEL",
      "CODEX_MCP_APPLY_MODEL",
      "gpt-5.6-luna",
    ),
    defaultEffort: envDefault(
      "AGENT_EXEC_APPLY_EFFORT",
      "CODEX_MCP_APPLY_EFFORT",
      "max",
    ),
  },
};

// 起動時に 1 度だけ解決し、結果を mode に焼く。実行のたびに判定しない。
function adapterFor(mode) {
  return mode.adapter;
}

// 終端を観測済みか。terminal_seen は 5.0.0 からのキーで、turn_completed は
// それ以前の記録が持っている。移行中はどちらも読む。
function terminalSeen(meta) {
  return meta?.terminal_seen === true || meta?.turn_completed === true;
}

// model / reasoning_effort は意図的に含めない。呼び出し側の LLM に選ばせると、
// 実運用では既定を無視して毎回同じモデルを指定してきた（25 run すべて gpt-6-astra。
// apply の既定 gpt-5.6-luna は一度も発動しなかった）。どのモデルにいくら払うかは
// 利用者が決めることなので、環境変数だけを入口にする。
const RUN_ARG_KEYS = [
  "prompt",
  "cwd",
  "timeout_ms",
  "resume_session_id",
  "kill_on_timeout",
  "delegate",
];
const APPLY_ARG_KEYS = [...RUN_ARG_KEYS, "scope"];

// ---------------------------------------------------------------- 既定値の検査

// モデルと effort は呼び出し側から渡せないので、不正な設定に気づける唯一の機会が
// 起動時になる。effort は閉じた集合なので、不正な値とモデル非対応の値はここで捨てる
// （以前は実行時に呼び出し側へエラーを返していたが、渡せなくなった以上ここで解決する）。
// モデル slug は開いた集合（キャッシュが古いこともある）なので、警告だけ出して使う。
function checkDefaults() {
  for (const [toolName, mode] of Object.entries(TOOL_MODES)) {
    // モデル名から起動する CLI を決める。ここで 1 度だけ解決して mode に焼く。
    const resolved = resolveAdapter(mode.defaultModel);
    mode.adapter = resolved.adapter;
    mode.defaultModel = resolved.model;
    if (!resolved.confident) {
      process.stderr.write(
        `warning: ${toolName} のモデル "${resolved.model}" はどの CLI にも紐づきません。` +
          `${resolved.adapter.id} として起動します` +
          `（意図が違う場合は "claude:${resolved.model}" のように接頭辞を付けてください）\n`,
      );
    }
    const adapter = mode.adapter;
    const known = adapter.knownModels();
    if (mode.defaultEffort && !adapter.efforts.includes(mode.defaultEffort)) {
      process.stderr.write(
        `warning: ${toolName} の既定 reasoning_effort が不正なため無視します: ${mode.defaultEffort}\n`,
      );
      mode.defaultEffort = undefined;
    }
    if (
      mode.defaultEffort &&
      !adapter.supportsEffort(mode.defaultModel, mode.defaultEffort, known)
    ) {
      // 押し付けずに CLI 側の既定へ委ねる。ここで落とさないと毎回 run が失敗する。
      process.stderr.write(
        `warning: ${toolName} の既定モデル ${mode.defaultModel} は ` +
          `reasoning_effort=${mode.defaultEffort} に対応していないため無視します` +
          `（対応値: ${adapter.effortsFor(mode.defaultModel, known).join(", ")}）\n`,
      );
      mode.defaultEffort = undefined;
    }
    if (
      mode.defaultModel &&
      known.length > 0 &&
      !known.some((m) => m.slug === mode.defaultModel)
    ) {
      process.stderr.write(
        `warning: ${toolName} の既定モデル ${mode.defaultModel} は ${adapter.modelsCacheHint} に見当たりません` +
          "（キャッシュが古いだけの可能性があるため、そのまま使います）\n",
      );
    }
    // どの tool がどの CLI・どのモデルで走るかを毎回 stderr に出す。設定を変えた端末で
    // 「反映されているか」を確かめる唯一の手がかりになる。
    const sandbox = adapter.sandbox(mode.capability);
    process.stderr.write(
      `${toolName}: model=${mode.defaultModel ?? "(CLI 既定)"} ` +
        `effort=${mode.defaultEffort ?? "(CLI 既定)"} → ${adapter.bin()} ` +
        `(${sandbox.label} / ${sandbox.enforcement})\n`,
    );
  }
}

// ---------------------------------------------------------------- ツール定義

// 呼び出し側はモデルを選べないが、「誰に相談しているか」は判断材料になるので明示する。
function fixedModelNote(mode) {
  const model = mode.defaultModel ?? `${adapterFor(mode).configHint} の設定`;
  const effort = mode.defaultEffort ? `/ effort=${mode.defaultEffort}` : "";
  return `モデルは ${model} ${effort} に固定されている（呼び出し側からは変更できない）。`;
}

function runProperties(mode) {
  return {
    prompt: {
      type: "string",
      description:
        "Codex に渡す指示。resume_session_id を使わない限り会話は継続しないため、" +
        "必要な文脈はこの中に書く。",
    },
    timeout_ms: {
      type: "integer",
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      description:
        `同期で待つ上限（既定 ${DEFAULT_TIMEOUT_MS} ms）。超えても codex は止めず、` +
        "run_id とそこまでの報告を返す。続きは result で取得する。",
    },
    resume_session_id: {
      type: "string",
      description:
        "前回の応答に含まれる session_id。指定すると会話を継続する（文脈を書き直さずに済む）。",
    },
    kill_on_timeout: {
      type: "boolean",
      description:
        "true なら timeout_ms で codex を打ち切る（既定 false = 切り離して継続させる）。",
    },
    delegate: {
      type: "boolean",
      description:
        "codex がサブエージェントへ委譲し独立レビューまで自走することを許すか" +
        `（既定 ${mode.defaultDelegate}）。false にすると「自分で進めて」と prompt で頼む。` +
        "呼び出し側で別途レビューを回している場合、委譲を許すと二重になり run が何倍にも長くなる。",
    },
  };
}

function toolDefinitions() {
  const consult = runProperties(TOOL_MODES.consult);
  const apply = runProperties(TOOL_MODES.apply);
  return [
    {
      name: "consult",
      description:
        "Codex に読み取り専用（-s read-only）で相談する。コード調査・レビュー・設計相談・" +
        "セカンドオピニオンに使う。Codex はファイルを読めるが一切書き換えない。" +
        `${fixedModelNote(TOOL_MODES.consult)}`,
      inputSchema: {
        type: "object",
        properties: {
          ...consult,
          cwd: {
            type: "string",
            description:
              "Codex の作業ディレクトリ（絶対パス）。省略時はこのサーバの起動ディレクトリ。",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    {
      name: "apply",
      description:
        "Codex に workspace-write で作業させる。cwd 配下のファイルを書き換える。" +
        "変更を戻せるようにするため cwd は git 管理下である必要がある。" +
        "応答には変更ファイル一覧と diff --stat が付く。" +
        "既定では「テストを実行し、コマンドと結果を報告に含める」よう指示する。" +
        `${fixedModelNote(TOOL_MODES.apply)}`,
      inputSchema: {
        type: "object",
        properties: {
          ...apply,
          cwd: {
            type: "string",
            description:
              "Codex の作業ディレクトリ（絶対パス、git 管理下）。必須。",
          },
          scope: {
            type: "string",
            enum: ["strict", "open"],
            description:
              "strict（既定）なら「指示された範囲のみ変更し、範囲外の問題は直さず報告する」" +
              "という指示を prompt に添える。open なら添えない。",
          },
        },
        required: ["prompt", "cwd"],
        additionalProperties: false,
      },
    },
    {
      name: "status",
      description:
        "consult / apply が切り離した run の進捗を見る。" +
        "何をしているか（実行したコマンド数・直近の動作）と経過時間が分かる。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "consult / apply が返した run_id。",
          },
          event_limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "末尾から何件のイベントを見るか（既定 20）。",
          },
        },
        required: ["run_id"],
        additionalProperties: false,
      },
    },
    {
      name: "result",
      description:
        "切り離した run の最終報告を取得する。未完了なら wait_ms まで待つ。" +
        "サーバを再起動した後でも、記録が残っていれば取得できる。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "取得する run_id。" },
          wait_ms: {
            type: "integer",
            minimum: MIN_TIMEOUT_MS,
            maximum: MAX_TIMEOUT_MS,
            description: "未完了のとき待つ上限（既定は待たずに現状を返す）。",
          },
        },
        required: ["run_id"],
        additionalProperties: false,
      },
    },
    {
      name: "runs",
      description:
        "最近の run を新しい順に一覧する（run_id が分からなくなったときに使う）。",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "件数（既定 10）。",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  ];
}

// ---------------------------------------------------------------- 引数の検証

class InvalidArguments extends Error {}

function validateArgKeys(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new InvalidArguments(
      `未知の引数です: ${unknown.join(", ")}。使えるのは ${allowed.join(", ")} です。`,
    );
  }
}

function validatePrompt(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArguments("prompt は空でない文字列で指定してください。");
  }
  return value;
}

// symlink と `..` を解いて実体パスに揃える。codex は実体パスで動くので、ここで揃えないと
// git 判定の対象と実際の作業先がずれる。
function toRealDirectory(value) {
  let resolved;
  try {
    resolved = realpathSync(value);
  } catch {
    throw new InvalidArguments(`cwd が存在しません: ${value}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new InvalidArguments(`cwd がディレクトリではありません: ${value}`);
  }
  return resolved;
}

function validateCwd(value, { required }) {
  if (value === undefined || value === null) {
    if (required)
      throw new InvalidArguments(
        "cwd は必須です（絶対パスで指定してください）。",
      );
    return toRealDirectory(process.cwd());
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArguments("cwd は絶対パスの文字列で指定してください。");
  }
  if (!isAbsolute(value)) {
    throw new InvalidArguments(`cwd は絶対パスで指定してください: ${value}`);
  }
  return toRealDirectory(value);
}

function validateInteger(
  value,
  { name, min = MIN_TIMEOUT_MS, max = MAX_TIMEOUT_MS, fallback },
) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidArguments(
      `${name} は ${min} 以上 ${max} 以下の整数で指定してください。`,
    );
  }
  return value;
}

function toArgs(params) {
  const args = params?.arguments ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new InvalidArguments("arguments はオブジェクトで指定してください。");
  }
  return args;
}

// resume 先が自分の作ったセッションかを確かめる。索引（sessions.json）を先に引く。
// run 本体は prune で消えるが、索引は残るので会話は継続できる。
function findSessionOrigin(sessionId, cwd) {
  const indexed = lookupSession(sessionId);
  if (indexed?.cwd) {
    // 索引には backend を持たせていないので、run 本体から補う（消えていれば undefined）。
    return { ...indexed, backend: readMeta(indexed.run_id)?.backend };
  }
  // 索引が無い古い記録との互換。同じ session_id の run が並ぶので cwd 一致を優先する。
  let fallback;
  for (const runId of listRunIds()) {
    const meta = readMeta(runId);
    if (meta?.session_id !== sessionId && meta?.thread_id !== sessionId) continue;
    const entry = { run_id: runId, cwd: meta.cwd, tool: meta.tool, backend: meta.backend };
    if (meta.cwd === cwd) return entry;
    fallback ??= entry;
  }
  return fallback;
}

function validateSessionId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new InvalidArguments(
      `resume_session_id は UUID 形式で指定してください（応答の session_id をそのまま渡す）: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateBoolean(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean")
    throw new InvalidArguments(`${name} は true / false で指定してください。`);
  return value;
}

function validateRunId(value) {
  if (!isValidRunId(value)) {
    throw new InvalidArguments(
      `run_id の形式が不正です: ${JSON.stringify(value)}。runs で一覧できます。`,
    );
  }
  return value;
}

// ---------------------------------------------------------------- 応答の組み立て

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n…（中略: ${text.length - max} 文字を省略）…\n\n${text.slice(text.length - tail)}`;
}

function formatItemCounts(counts) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return "なし";
  return entries.map(([type, count]) => `${type}=${count}`).join(" ");
}

function formatGitDiff(gitDiff) {
  if (!gitDiff) return "";
  const moved = gitDiff.head_moved
    ? `（HEAD が ${gitDiff.head_before} → ${gitDiff.head_after} へ動いています。run 内で commit された可能性があります）\n`
    : "";
  const changed = gitDiff.changed_files ?? [];
  if (changed.length === 0) {
    return `\n--- 終了時点の git 状態 ---\n${moved}（作業ツリーに未コミットの変更はありません）\n`;
  }
  // 「この run が変えたぶん」を厳密に切り出すには開始時の内容を保存する必要がある。
  // ここでは終了時点の状態を全部出し、開始前から変わっていたものに印を付ける。
  const list = changed
    .map(
      (entry) =>
        `  ${entry.status || "?"} ${entry.path}${entry.pre_existing ? "  ← run 開始前から変更あり" : ""}`,
    )
    .join("\n");
  const stat = gitDiff.diff_stat ? `\n${gitDiff.diff_stat}\n` : "";
  const notes = [
    "終了時点の作業ツリー全体（同じ repo で別の run が同時に走っていれば混ざります）",
    changed.some((entry) => entry.status === "??")
      ? "?? の新規ファイルは diff --stat に含まれません"
      : "",
  ].filter(Boolean);
  return `\n--- 終了時点の git 状態 (${changed.length}) ---\n${moved}${list}\n${stat}※ ${notes.join("。")}\n`;
}

// 本文は last-message.txt を優先し、無ければイベントから拾った agent_message を使う。
// 打ち切り時は後者しか無いことが多い。
function pickBody(runId, messages) {
  const saved = readArtifact(runId, "last-message.txt").trim();
  if (saved) return { text: saved, source: "最終メッセージ" };
  // 実行中は記憶しているものを、追跡が切れていれば messages.jsonl を読む。
  // events.jsonl は切り詰めと末尾読みの対象なので、報告の復元には使わない。
  const list = messages && messages.length > 0 ? messages : readMessages(runId);
  if (list.length > 0)
    return { text: list.join("\n\n---\n\n"), source: "途中のメッセージ" };
  return { text: "", source: "なし" };
}

// 同じ repo で apply を重ねると、互いのファイルを奪い合ううえ、git 差分も
// 混ざって「どの run が何を変えたか」が分からなくなる。repo 単位で 1 本に制限する。
const activeRepos = new Map(); // git root -> run_id

// 完了直後に走らせると、応答を組み立てる前に記録を消しうる。
const PRUNE_DELAY_MS = readEnvInt(
  "AGENT_EXEC_PRUNE_DELAY_MS",
  "CODEX_MCP_PRUNE_DELAY_MS",
  10_000,
);

// 保持期間を過ぎた run を捨てる。動いている run と、自分が抱えている run は残す。
function prune() {
  pruneRuns((meta) => {
    if (getActive(meta.run_id)) return true;
    // スロット待ちなどで、まだ codex を起動していない自分の run
    if (meta.server_pid === process.pid && !meta.pid) return true;
    return isRunAlive(meta);
  });
}

// ---------------------------------------------------------------- 同時実行の調停

let activeSlots = 0;
const slotWaiters = [];

function acquireSlot(timeoutMs) {
  if (activeSlots < MAX_CONCURRENCY) {
    activeSlots += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timer);
      activeSlots += 1;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) slotWaiters.splice(index, 1);
      resolve(false);
    }, timeoutMs);
    slotWaiters.push(waiter);
  });
}

function releaseSlot() {
  activeSlots -= 1;
  const next = slotWaiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------- run の実行

function startProgressPings(progressToken, record) {
  if (progressToken === undefined || progressToken === null) return () => {};
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - record.startedAt) / 1000);
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsed,
        message:
          `${elapsed}s 経過 / events=${record.progress.eventCount} ` +
          `直近=${record.progress.lastItemType ?? "-"}`,
      },
    });
  }, PROGRESS_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function handleRun(toolName, params) {
  const mode = TOOL_MODES[toolName];
  const adapter = adapterFor(mode);
  const sandbox = adapter.sandbox(mode.capability);
  // モデルと effort は設定の値をそのまま使う。起動時の checkDefaults で健全性は
  // 確認済みなので、ここでは検証しない。
  const model = mode.defaultModel;
  const effort = mode.defaultEffort;
  let prompt;
  let cwd;
  let timeoutMs;
  let resumeSessionId;
  let killOnTimeout;
  let delegate;
  let scope = "open";
  let args;
  try {
    args = toArgs(params);
    validateArgKeys(args, mode.scopeNote ? APPLY_ARG_KEYS : RUN_ARG_KEYS);
    prompt = validatePrompt(args.prompt);
    cwd = validateCwd(args.cwd, { required: mode.cwdRequired });
    timeoutMs = validateInteger(args.timeout_ms, {
      name: "timeout_ms",
      fallback: DEFAULT_TIMEOUT_MS,
    });
    resumeSessionId = validateSessionId(args.resume_session_id);
    killOnTimeout = validateBoolean(args.kill_on_timeout, "kill_on_timeout");
    delegate =
      args.delegate === undefined || args.delegate === null
        ? mode.defaultDelegate
        : validateBoolean(args.delegate, "delegate");
    if (mode.scopeNote) {
      scope = args.scope ?? "strict";
      if (scope !== "strict" && scope !== "open") {
        throw new InvalidArguments(
          'scope は "strict" か "open" で指定してください。',
        );
      }
    }
  } catch (err) {
    if (err instanceof InvalidArguments) return errorResult(err.message);
    throw err;
  }

  // 書き込みを伴う場合のみ、git 管理下であることを先に確かめる。
  let repoRoot;
  if (!mode.skipGitRepoCheck) {
    repoRoot = gitRoot(cwd);
    if (repoRoot === null) {
      return errorResult(
        `cwd が git 管理下にありません: ${cwd}\n` +
          "apply は変更を戻せるように git リポジトリ内でのみ実行できます。" +
          "調査だけなら consult を使ってください。",
      );
    }
    const busy = activeRepos.get(repoRoot);
    if (busy) {
      return errorResult(
        `同じリポジトリで apply が実行中です（run_id=${busy}、repo=${repoRoot}）。\n` +
          "同時に走らせると互いの変更を奪い合い、git 差分もどちらのものか分からなくなります。\n" +
          `status(run_id="${busy}") で進捗を確認するか、完了を待ってください。` +
          "（読むだけなら consult は並行して使えます）",
      );
    }
  }

  // resume 先が自分の記録にある run か、同じ作業ディレクトリかを確かめる。
  // codex 側の前提（sandbox override が効く／cwd は spawn 側）に頼らず、ローカルで防ぐ。
  let toolSwitchNote = "";
  if (resumeSessionId) {
    const origin = findSessionOrigin(resumeSessionId, cwd);
    if (!origin) {
      return errorResult(
        `resume_session_id がこのサーバの記録に見つかりません: ${resumeSessionId}\n` +
          "runs で session_id を確認してください（他のツールが作ったセッションは再開できません）。",
      );
    }
    if (origin.cwd !== cwd) {
      return errorResult(
        `resume_session_id の元 run は cwd=${origin.cwd} で実行されています（今回の指定は ${cwd}）。\n` +
          "作業ディレクトリが変わると文脈と実際の作業先がずれるため、同じ cwd を指定してください。",
      );
    }
    // 別の CLI で作られたセッションは再開できない。env のモデルを codex 系から
    // claude 系（またはその逆）へ変えた直後に必ず踏むので、理由を明示して止める。
    const originBackend = origin.backend ?? "codex";
    if (originBackend !== adapter.id) {
      return errorResult(
        `このセッションは別の CLI（${originBackend}）で作られています（今回は ${adapter.id}）。\n` +
          "モデル設定が変わったため再開できません。文脈を prompt に書いて新しく始めてください。",
      );
    }
    // tool をまたぐ継続（調査 → 修正、修正 → レビュー）は自然なので拒否しない。
    // ただし sandbox が変わることは応答に明示する。
    if (origin.tool && origin.tool !== toolName) {
      toolSwitchNote = `\n（${origin.tool} のセッションを ${toolName} = ${sandbox.label} で継続します）`;
    }
  }

  let effectivePrompt = scope === "strict" ? `${prompt}${SCOPE_NOTE}` : prompt;
  // 書き込みを伴う run だけ、テストの実行と申告を求める（consult は走らせられない）。
  if (mode.scopeNote) effectivePrompt = `${effectivePrompt}${TEST_NOTE}`;
  // 委譲を argv で禁止できる CLI（claude は Task を許可リストから外すだけで済む）では
  // prompt で頼む必要がない。無意味な指示にトークンを払わない。
  if (!delegate && adapter.needsSoloNote) {
    effectivePrompt = `${effectivePrompt}${SOLO_NOTE}`;
  }
  const startedAt = new Date();
  // 差分の比較は書き込みを伴う apply でのみ使う（consult では git を呼ばない）。
  const gitBefore = mode.scopeNote ? captureGitState(cwd) : undefined;

  const runId = createRun(
    {
      tool: toolName,
      state: "running",
      // スロット待ちの間はまだ pid が無い。自分が作った run だと分かるようにしておく
      // （でないと prune が「動いていない running」として消してしまう）。
      server_pid: process.pid,
      started_at: startedAt.toISOString(),
      finished_at: null,
      cwd,
      backend: adapter.id,
      capability: mode.capability,
      // sandbox は既存の記録が使っているキー。アダプタが訳した実際の値を入れる。
      sandbox: sandbox.label,
      enforcement: sandbox.enforcement,
      model: model ?? null,
      reasoning_effort: effort ?? null,
      resume_session_id: resumeSessionId ?? null,
      scope,
      delegate,
      git_before: gitBefore ?? null,
      thread_id: null,
      exit_code: null,
    },
    effectivePrompt,
  );

  // timeout_ms は「同期で待つ上限」なので、待ち行列と実行待ちで合計してもこれを超えない。
  const deadline = Date.now() + timeoutMs;

  const gotSlot = await acquireSlot(Math.max(0, deadline - Date.now()));
  if (!gotSlot) {
    updateMeta(runId, {
      state: "failed",
      note: "同時実行の空きを待てませんでした",
    });
    return errorResult(
      `同時実行の上限（${MAX_CONCURRENCY}）に達しており、${timeoutMs} ms 待っても空きませんでした。\n` +
        `実行中: ${activeRunIds().join(", ") || "（サーバ管理外）"}\n` +
        "status で進捗を確認するか、時間をおいて再試行してください。",
    );
  }

  if (repoRoot) activeRepos.set(repoRoot, runId);
  const releaseRepo = () => {
    if (repoRoot && activeRepos.get(repoRoot) === runId)
      activeRepos.delete(repoRoot);
  };

  let launched;
  const plan = adapter.buildLaunch({
    runId,
    runDir: runDir(runId),
    capability: mode.capability,
    cwd,
    model,
    effort,
    resumeSessionId,
    delegate,
    skipGitRepoCheck: mode.skipGitRepoCheck,
  });

  try {
    launched = launch({
      runId,
      adapter,
      argv: plan.argv,
      marker: plan.marker,
      env: plan.env,
      prompt: effectivePrompt,
      cwd,
      // detach しても子は走り続けるので、スロットは run の完了まで保持する。
      onFinish: (finished) => {
        releaseSlot();
        releaseRepo();
        const diff = mode.scopeNote ? diffGitState(cwd, gitBefore) : undefined;
        if (diff) updateMeta(finished.runId, { git_diff: diff });
        // 応答は完了後に組み立てるので、その場で prune すると読む前に消えかねない。
        setTimeout(prune, PRUNE_DELAY_MS).unref();
      },
    });
  } catch (err) {
    releaseSlot(); // 起動前に落ちてもスロットと repo を取りこぼさない
    releaseRepo();
    throw err;
  }

  if (launched.spawnError) {
    releaseSlot();
    releaseRepo();
    updateMeta(runId, { state: "failed", note: launched.spawnError });
    return errorResult(
      `${adapter.id} の起動に失敗しました: ${launched.spawnError}\n` +
        `${adapter.binEnv} が PATH 上にあるか確認してください。`,
    );
  }

  const record = launched.record;
  const progressToken = params?._meta?.progressToken;
  process.stderr.write(
    progressToken === undefined
      ? `[${runId}] progressToken なし（クライアントは進捗通知を要求していません）\n`
      : `[${runId}] progressToken あり: ${JSON.stringify(progressToken)}\n`,
  );
  const stopPings = startProgressPings(progressToken, record);

  let outcome;
  try {
    outcome = await waitFor(record, Math.max(0, deadline - Date.now()));
  } finally {
    stopPings();
  }

  if (outcome === "timeout" && killOnTimeout) {
    killRun(runId, `${timeoutMs} ms を超えたため打ち切りました`);
    outcome = await waitFor(record, 10_000);
  }

  const elapsed = ((Date.now() - record.startedAt) / 1000).toFixed(1);
  const live = snapshot(record);
  const sessionId = live.thread_id ?? readMeta(runId)?.thread_id ?? null;
  const header =
    `[${toolName}] run_id=${runId} model=${model ?? "(config 既定)"} ` +
    `effort=${effort ?? "(config 既定)"} sandbox=${sandbox.label} ` +
    `cwd=${cwd} elapsed=${elapsed}s` +
    (sessionId
      ? `\nsession_id=${sessionId}（続きは resume_session_id に渡す）`
      : "") +
    (resumeSessionId ? `\n（${resumeSessionId} から継続）` : "") +
    toolSwitchNote;

  if (outcome === "timeout") {
    const body = pickBody(runId, live.messages);
    return textResult(
      `${header}\n\n⏳ 同期で待つ上限（${timeoutMs} ms）に達したので切り離しました。codex は実行を続けています。\n` +
        `進捗: ${formatItemCounts(live.item_counts)} / 直近=${live.last_item_type ?? "-"}\n` +
        `記録: ${runDir(runId)}\n` +
        `続きは result(run_id="${runId}") で取得できます。status(run_id="${runId}") で進捗を見られます。\n` +
        (body.text
          ? `\n--- ここまでの報告（${body.source}）---\n${truncateMiddle(body.text, MAX_OUTPUT_CHARS)}\n`
          : "\n（まだ報告は出ていません）\n"),
    );
  }

  return finishedResult({
    runId,
    header,
    cwd,
    mode,
    gitBefore,
    live,
    caveat: sandbox.caveat,
  });
}

// 承認が下りずに実行できなかった操作。claude の apply では「テストを走らせられなかった」
// 理由がここに出る。捨てると、なぜテストの報告が無いのかが分からない。
function formatDenials(meta) {
  const denials = meta.permission_denials;
  if (!Array.isArray(denials) || denials.length === 0) return "";
  const lines = denials
    .map((d) => "  - " + (d.tool_name ?? "?") + ": " + (d.command ?? "(詳細なし)"))
    .join("\n");
  return (
    "\n⚠ 次の操作は許可されていないため実行されませんでした:\n" +
    lines +
    "\n  許可するには AGENT_EXEC_CLAUDE_ALLOWED_TOOLS に追加してください" +
    '（例: "Bash(node --test*)"）。\n'
  );
}

function finishedResult({ runId, header, cwd, mode, gitBefore, live, caveat }) {
  const meta = readMeta(runId) ?? {};
  const notes = formatDenials(meta) + (caveat ? `\n注: ${caveat}\n` : "");
  const body = pickBody(runId, live.messages);
  const gitDiff =
    meta.git_diff ??
    (mode.scopeNote ? diffGitState(cwd, gitBefore) : undefined);
  const diffText = formatGitDiff(gitDiff);

  // codex 側が返したエラー（モデルが使えない等）は、他の何より先に見せる
  if (live.failure) {
    return errorResult(
      `${header}\n\ncodex が実行を中断しました: ${live.failure}\n` +
        (body.text ? `\n--- ここまでの報告 ---\n${body.text}\n` : "") +
        `記録: ${runDir(runId)}`,
    );
  }
  if (live.spawn_failed) {
    return errorResult(
      `${header}\n\n${live.spawn_failed}\n` +
        "CODEX_BIN が PATH 上にあるか確認してください。\n" +
        `記録: ${runDir(runId)}`,
    );
  }
  if (live.state === "failed") {
    return errorResult(
      `${header}\n\ncodex exec が失敗しました（exit=${live.exit?.code ?? "不明"} signal=${live.exit?.signal ?? "なし"}）。\n` +
        (body.text
          ? `\n--- codex の報告（${body.source}）---\n${body.text}\n`
          : "") +
        diffText +
        `\n--- codex stderr（末尾）---\n${live.stderr_tail?.trim() || "（空）"}\n` +
        `記録: ${runDir(runId)}`,
    );
  }
  if (live.state === "killed") {
    return errorResult(
      `${header}\n\n打ち切りました（${live.kill_reason ?? "理由不明"}）。\n` +
        (body.text
          ? `\n--- ここまでの報告（${body.source}）---\n${body.text}\n`
          : "") +
        diffText +
        `記録: ${runDir(runId)}`,
    );
  }
  if (!body.text) {
    return errorResult(
      `${header}\n\ncodex は報告を返しませんでした。\n` +
        diffText +
        `\n--- codex stderr（末尾）---\n${live.stderr_tail?.trim() || "（空）"}\n` +
        `記録: ${runDir(runId)}`,
    );
  }
  const usage = live.usage
    ? `\n（tokens: in=${live.usage.input_tokens ?? "?"} out=${live.usage.output_tokens ?? "?"}）`
    : "";
  return textResult(
    `${header}${usage}\n\n${truncateMiddle(body.text, MAX_OUTPUT_CHARS)}\n${diffText}${notes}`,
  );
}

// ---------------------------------------------------------------- status / result / runs

// サーバ再起動などで追跡が切れた run を、記録とプロセスの生死から判定する。
// snapshot() と同じ形を返す（呼び出し側で分岐しないため）。
function reconstruct(runId, meta, events = readEvents(runId)) {
  // どの CLI で走った run かは記録から引く。古い記録には backend が無いので codex 扱い。
  const adapter = adapterById(meta.backend);
  const deltas = events.map((event) => adapter.parseEvent(event));
  // terminal_seen は 5.0.0 からのキー。turn_completed は既存の記録が持っている。
  const completed =
    meta.terminal_seen === true ||
    meta.turn_completed === true ||
    deltas.some((delta) => delta?.completed);
  // 報告は messages.jsonl を正とする。無い場合（messages.jsonl を書く前の記録）は
  // events から拾う。
  let messages = readMessages(runId);
  if (messages.length === 0) {
    messages = deltas.flatMap((delta) => delta?.messages ?? []);
  }
  const itemCounts = {};
  for (const delta of deltas) {
    for (const itemType of delta?.itemTypes ?? []) {
      itemCounts[itemType] = (itemCounts[itemType] ?? 0) + 1;
    }
  }
  // meta が running のままでも子プロセスが生きているとは限らない（その逆もある）。
  // events に終端があるなら、それが最も確かな完了の証拠なので優先する
  // （pid が別プロセスに再利用されていると、生死判定だけでは永久に「実行中」になる）。
  const liveness = meta.state === "running" ? runLiveness(meta) : "dead";
  const alive = liveness === "alive";
  const state =
    meta.state === "running"
      ? completed
        ? "completed(推定)"
        : alive
          ? "running（別プロセスで継続中）"
          : liveness === "unknown"
            ? // 身元を確認できない起動だった run。「終わった」と断言すると、呼び出し側が
              // 失敗と判断して（apply なら破壊的な）再実行に走る。
              "unknown（まだ動いているかもしれません）"
            : "unknown"
      : meta.state;
  const finishedAt = meta.finished_at
    ? Date.parse(meta.finished_at)
    : Date.now();
  return {
    state,
    alive: alive && !completed,
    elapsed_ms: finishedAt - Date.parse(meta.started_at),
    thread_id:
      meta.session_id ??
      meta.thread_id ??
      deltas.find((delta) => delta?.sessionId)?.sessionId ??
      null,
    event_count: events.length,
    item_counts: itemCounts,
    last_item_type: null,
    messages,
    usage: meta.usage ?? null,
    stderr_tail: "",
    exit: null,
    kill_reason: null,
    spawn_failed: meta.spawn_failed ?? null,
  };
}

function handleStatus(params) {
  let runId;
  let eventLimit;
  try {
    const args = toArgs(params);
    validateArgKeys(args, ["run_id", "event_limit"]);
    runId = validateRunId(args.run_id);
    eventLimit = validateInteger(args.event_limit, {
      name: "event_limit",
      min: 1,
      max: 200,
      fallback: 20,
    });
  } catch (err) {
    if (err instanceof InvalidArguments) return errorResult(err.message);
    throw err;
  }

  const meta = readMeta(runId);
  if (!meta)
    return errorResult(
      `run が見つかりません: ${runId}（runs で一覧できます）`,
    );

  const record = getActive(runId);
  // events.jsonl は大きくなりうるので、1 回の status で 1 度しか読まない。
  const events = record ? undefined : readEvents(runId);
  const live = record ? snapshot(record) : reconstruct(runId, meta, events);
  // 正常に終わった run にまで「サーバ管理外」と出すと異常に見えるので、
  // 追跡が切れたまま終わっていない run にだけ注記する。
  const note =
    record || meta.state !== "running"
      ? ""
      : "（このサーバの管理外。記録から復元）";

  const recent = (
    events ? events.slice(-eventLimit) : readEvents(runId, eventLimit)
  )
    .map((event) => {
      if (event?.type === "item.completed")
        return `  item.completed: ${event.item?.type ?? "unknown"}`;
      return `  ${event?.type ?? "unknown"}`;
    })
    .join("\n");

  return textResult(
    `run_id=${runId} tool=${meta.tool} state=${live.state}${note}\n` +
      `cwd=${meta.cwd} model=${meta.model ?? "(config 既定)"} effort=${meta.reasoning_effort ?? "(config 既定)"}\n` +
      `session_id=${meta.thread_id ?? live.thread_id ?? "（未取得）"}\n` +
      `経過: ${(live.elapsed_ms / 1000).toFixed(1)}s / イベント: ${live.event_count}\n` +
      `内訳: ${formatItemCounts(live.item_counts)}\n` +
      `記録: ${runDir(runId)}\n` +
      (recent ? `\n--- 直近のイベント ---\n${recent}\n` : "") +
      (live.messages?.length
        ? `\n--- 直近のメッセージ ---\n${truncateMiddle(live.messages[live.messages.length - 1], 4_000)}\n`
        : ""),
  );
}

// 待っている間、クライアントへ生存を知らせる。progressToken が無ければ何もしない。
function pingWhileWaiting(progressToken, startedAt, describe) {
  if (progressToken === undefined || progressToken === null) return () => {};
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsed,
        message: `${elapsed}s 待機中 / ${describe()}`,
      },
    });
  }, PROGRESS_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function handleResult(params) {
  let runId;
  let waitMs;
  try {
    const args = toArgs(params);
    validateArgKeys(args, ["run_id", "wait_ms"]);
    runId = validateRunId(args.run_id);
    waitMs = validateInteger(args.wait_ms, { name: "wait_ms", fallback: 0 });
  } catch (err) {
    if (err instanceof InvalidArguments) return errorResult(err.message);
    throw err;
  }

  const meta = readMeta(runId);
  if (!meta)
    return errorResult(
      `run が見つかりません: ${runId}（runs で一覧できます）`,
    );

  let record = getActive(runId);
  const waitStartedAt = Date.now();
  const stopPings =
    waitMs > 0
      ? pingWhileWaiting(params?._meta?.progressToken, waitStartedAt, () => {
          const live = getActive(runId);
          return live
            ? `${formatItemCounts(snapshot(live).item_counts)}`
            : "別プロセスの run を監視中";
        })
      : () => {};
  try {
    if (record && waitMs > 0) {
      await waitFor(record, waitMs);
      record = getActive(runId);
    } else if (!record && waitMs > 0 && meta.state === "running") {
      // 別のサーバが動かしている run には待機フックが無い。wait_ms の意味が
      // 管理サーバによって変わらないよう、期限まで記録を見に行く。
      const deadline = Date.now() + waitMs;
      for (;;) {
        const current = readMeta(runId);
        if (!current || current.state !== "running") break;
        if (terminalSeen(current) || !isRunAlive(current)) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2_000, remaining)),
        );
      }
    }
  } finally {
    stopPings();
  }

  const current = readMeta(runId) ?? meta;
  const live = record ? snapshot(record) : reconstruct(runId, current);
  const body = pickBody(runId, live.messages);
  const header =
    `[result] run_id=${runId} tool=${current.tool} state=${live.state}\n` +
    `session_id=${current.thread_id ?? live.thread_id ?? "（未取得）"} cwd=${current.cwd}\n` +
    `記録: ${runDir(runId)}`;

  if (record) {
    return textResult(
      `${header}\n\n⏳ まだ実行中です（${(live.elapsed_ms / 1000).toFixed(1)}s 経過）。\n` +
        `進捗: ${formatItemCounts(live.item_counts)} / 直近=${live.last_item_type ?? "-"}\n` +
        (body.text
          ? `\n--- ここまでの報告（${body.source}）---\n${body.text}\n`
          : ""),
    );
  }

  const diffText = formatGitDiff(current.git_diff);
  if (!body.text) {
    // 追跡が切れていても codex 本体が生きていることがある。「無い」と断言すると、
    // 呼び出し側が失敗と判断して高価な（apply なら破壊的な）再実行に走る。
    if (live.alive) {
      return textResult(
        `${header}\n\n⏳ codex（pid=${current.pid}）はまだ動いています。報告はこれから書かれます。\n` +
          `しばらく後に result(run_id="${runId}") を再実行してください。\n` +
          `進捗: ${formatItemCounts(live.item_counts)}\n`,
      );
    }
    return errorResult(
      `${header}\n\n報告が記録されていません。\n` +
        diffText +
        `\n--- codex stderr（末尾）---\n${readArtifact(runId, "stderr.log").trim() || "（空）"}\n`,
    );
  }
  const report = `${header}\n\n--- 報告（${body.source}）---\n${truncateMiddle(body.text, MAX_OUTPUT_CHARS)}\n${diffText}`;
  // 同期の応答と機械的な成否判定を揃える（本文は残したまま isError を立てる）。
  if (current.state === "failed" || current.state === "killed") {
    const why =
      current.state === "failed"
        ? `exit=${current.exit_code ?? "不明"} signal=${current.signal ?? "なし"}`
        : (current.note ?? "打ち切られました");
    return errorResult(
      `${report}\n--- この run は ${current.state} で終わっています（${why}）---\n` +
        `stderr（末尾）: ${readArtifact(runId, "stderr.log").trim().slice(-2_000) || "（空）"}`,
    );
  }
  return textResult(report);
}

function handleRuns(params) {
  let limit;
  try {
    const args = toArgs(params);
    validateArgKeys(args, ["limit"]);
    limit = validateInteger(args.limit, {
      name: "limit",
      min: 1,
      max: 100,
      fallback: 10,
    });
  } catch (err) {
    if (err instanceof InvalidArguments) return errorResult(err.message);
    throw err;
  }

  const ids = listRunIds().slice(0, limit);
  if (ids.length === 0) return textResult("run の記録はありません。");
  const lines = ids.map((runId) => {
    const meta = readMeta(runId);
    if (!meta) return `${runId}  （meta 読み取り失敗）`;
    // status と食い違わないよう同じ基準で出す（件数が多いので events は読まない）。
    let state = meta.state;
    if (getActive(runId)) state = "running[このサーバが追跡中]";
    else if (meta.state === "running") {
      // status と同じ順序（終端の証跡 → 生存 → 不明）で判定する
      const liveness = runLiveness(meta);
      state = terminalSeen(meta)
        ? "completed(推定)"
        : liveness === "alive"
          ? "running（別プロセスで継続中）"
          : liveness === "unknown"
            ? "unknown（まだ動いているかもしれません）"
            : "unknown";
    }
    return (
      `${runId}  ${meta.tool}  state=${state}  ${meta.started_at}\n` +
      `    cwd=${meta.cwd}  session_id=${meta.thread_id ?? "-"}`
    );
  });
  return textResult(`最近の run（新しい順）:\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------- MCP ハンドラ

async function handleToolCall(params) {
  const name = params?.name;
  if (name === "consult" || name === "apply") {
    return handleRun(name, params);
  }
  if (name === "status") return handleStatus(params);
  if (name === "result") return handleResult(params);
  if (name === "runs") return handleRuns(params);
  return errorResult(
    `未知のツールです: ${JSON.stringify(name)}。利用できるのは ` +
      "consult, apply, status, result, runs です。",
  );
}

function handleInitialize(params) {
  const requested = params?.protocolVersion;
  const negotiated =
    typeof requested === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion: negotiated,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

// ---------------------------------------------------------------- JSON-RPC ループ

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  const { id, method, params } = message;

  // JSON-RPC のレスポンス（result / error を持つ）には応答してはいけない。
  if (typeof method !== "string") {
    if ("result" in message || "error" in message) return;
    if (id !== undefined)
      sendError(id, -32600, "method が指定されていません。");
    return;
  }
  // MCP は id: null を認めていない。パースエラー応答と区別できなくなるため弾く。
  if (id === null) {
    sendError(null, -32600, "id に null は使えません。");
    return;
  }

  const isNotification = id === undefined;
  switch (method) {
    case "initialize":
      if (!isNotification) sendResult(id, handleInitialize(params));
      return;
    case "ping":
      if (!isNotification) sendResult(id, {});
      return;
    case "tools/list":
      if (!isNotification) sendResult(id, { tools: toolDefinitions() });
      return;
    case "tools/call": {
      if (isNotification) return;
      try {
        sendResult(id, await handleToolCall(params));
      } catch (err) {
        sendResult(
          id,
          errorResult(`サーバ内部エラー: ${String(err?.stack ?? err)}`),
        );
      }
      return;
    }
    default:
      if (isNotification) return; // notifications/initialized などは黙って捨てる
      sendError(id, -32601, `未対応のメソッドです: ${String(method)}`);
  }
}

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "JSON の解析に失敗しました。");
    return;
  }
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    sendError(null, -32600, "JSON-RPC の単一オブジェクトのみ受け付けます。");
    return;
  }
  handleMessage(message).catch((err) => {
    process.stderr.write(`unhandled error: ${String(err?.stack ?? err)}\n`);
    const { id } = message;
    if (id === undefined || id === null) return;
    try {
      sendError(id, -32603, `サーバ内部エラー: ${String(err?.message ?? err)}`);
    } catch {
      /* stdout が閉じている場合は諦める */
    }
  });
}

function main() {
  // stdout は JSON-RPC 専用なので、想定外の例外もログは stderr に出して走り続ける。
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaught exception: ${String(err?.stack ?? err)}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
  });

  checkDefaults();
  const reclaimed = reclaimOrphans();
  if (reclaimed.length > 0) {
    process.stderr.write(
      `前回のサーバが残した codex を回収しました: ${reclaimed.join(", ")}\n`,
    );
  }
  prune();

  // 放置すると課金が続くので、サーバ終了時は実行中の codex を落とす。
  process.on("exit", shutdownAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      shutdownAll();
      process.exit(0);
    });
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line);
    }
    if (buffer.length > MAX_LINE_CHARS) {
      buffer = "";
      sendError(null, -32600, "改行の無い入力が長すぎるため破棄しました。");
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} started\n`);
}

main();
