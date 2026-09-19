// Claude Code (`claude -p`) のアダプタ。
//
// codex アダプタと同じ契約: runs.mjs も child_process も import せず、純関数だけを
// 公開する。argv 組み立てとイベント解釈は spawn 無しでテストできる。
//
// 実測（claude 2.1.277 / Windows）で確かめたこと:
//   - `--verbose` が無いと `--output-format stream-json` は JSONL を吐かない。
//     静かに壊れるので無条件で付ける。
//   - `--strict-mcp-config`（`--mcp-config` 無し）で子の MCP が全部切れる
//     （init イベントの mcp_servers が []）。これが無いと子がこのサーバ自身を
//     読み込んで再帰する。
//   - `--tools` に Task を含めなければサブエージェントは物理的に存在しない。
//     codex では prompt で頼むしかなかった委譲禁止が、ここでは強制できる。
//   - `-n <run_id>` は実プロセスのコマンドラインにそのまま現れる（孤児回収の目印）。
//   - `--resume <id>` は通常の argv に足すだけ。session_id は同じ値が返る。
//   - effort は low/medium/high/xhigh/max。**ultra は無い**。
//   - `--permission-mode acceptEdits` は「安全と判定できる Bash」だけ自動承認する。
//     `echo` や `git status` は通るが `node --test` は拒否される。テストを走らせるには
//     `--allowedTools` で明示的に許す必要がある（下記）。
//   - `bypassPermissions` にすると cwd の外へも書けてしまう（実測）。採らない。

import { readEnv } from "../env.mjs";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// 読み取り専用。Bash / PowerShell / Write / Edit / Task を含めない。
// 許可リスト方式なので、ここに無いものは使えない。
const READ_TOOLS = "Read,Grep,Glob,WebSearch";
// 書き込み。Bash は入れるが、承認が要るコマンドは拒否される（ALLOWED_TOOLS 参照）。
// PowerShell は入れない（Bash と二重に shell を開ける必要がない）。
const WRITE_TOOLS = "Read,Grep,Glob,Edit,Write,NotebookEdit,Bash";
// 委譲を許すときだけ足す。
const DELEGATE_TOOLS = "Task";

const SANDBOX = {
  read: {
    label: "read-only(tool 制限)",
    enforcement: "tool-allowlist",
  },
  write: {
    label: "write(tool 制限)",
    enforcement: "tool-allowlist",
    caveat:
      "claude の書き込み制限は OS サンドボックスではなくツール層の許可判定です" +
      "（cwd の外への書き込みは実測で拒否されましたが、codex の workspace-write ほど" +
      "強い保証ではありません）。戻せることは cwd が git 管理下であることが担保します。",
  },
};

// 親セッションの環境変数が子を誤動作させるので落とす。ただし **`CLAUDE_CODE_*` を
// 前方一致で消してはいけない**。この接頭辞には接続先の設定も混ざっていて、たとえば
// `CLAUDE_CODE_USE_BEDROCK` を消すと、Bedrock を使う設定の端末で子が第一者 API へ
// 向いてしまう（設定ファイル側に同じ指定が無ければ、意図しない課金先になる）。
//
// 失敗の重さが非対称なのが判断の理由:
//   - セッション固有の変数が消し漏れる → 子が自分のセッション ID を誤認する程度
//   - 接続先の変数を消してしまう       → run そのものが意図と違う所へ行く
// そこで前方一致ではなく、実測で確認したセッション固有の変数を名指しで消す。
// Claude Code が新しいセッション変数を増やしたらここに足す。
const SCRUB_EXACT = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT", // --effort と競合する
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET", // 子が親へメッセージを送れてしまう
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
];
// 自分のもの。子が万一このサーバを読み込んでも同じ runs/ を共有しないための保険。
const SCRUB_PREFIXES = ["AGENT_EXEC_", "CODEX_MCP_"];
// ANTHROPIC_* は落とさない。利用者がどの認証で課金するかを勝手に変えないため。

function scrubbedEnv() {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (SCRUB_EXACT.includes(key) || SCRUB_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = undefined; // engine が「親から削除」と解釈する
    }
  }
  return env;
}

// テストなど、承認が要るコマンドを明示的に許す。既定は空。
//
// 空にしてあるのは、ここに何を入れるかが「どのコマンドを無条件で実行してよいか」の
// 宣言そのものだから。既定で埋めると、利用者が意図しないコマンドが走る。
// 例: AGENT_EXEC_CLAUDE_ALLOWED_TOOLS="Bash(node --test*) Bash(uv run pytest*)"
function allowedToolPatterns() {
  const raw = readEnv("AGENT_EXEC_CLAUDE_ALLOWED_TOOLS");
  if (!raw || raw.trim() === "") return [];
  return raw.split(/\s{2,}|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
}

export default {
  id: "claude",
  label: "Claude Code (claude -p)",
  binEnv: "CLAUDE_BIN",
  bin: () => process.env.CLAUDE_BIN || "claude",
  efforts: EFFORTS,
  projectDoc: "CLAUDE.md",
  // Task を許可リストから外すので委譲は起こりえない。prompt で頼む必要がない。
  needsSoloNote: false,
  configHint: "~/.claude/settings.json",
  modelsCacheHint: "モデル一覧",

  sandbox(capability) {
    return SANDBOX[capability] ?? SANDBOX.read;
  },

  // claude のモデル名は開いた集合（alias も完全な id も受け付ける）。照合しない。
  knownModels() {
    return [];
  },
  supportsEffort(_model, effort) {
    return EFFORTS.includes(effort);
  },
  effortsFor() {
    return EFFORTS;
  },

  buildLaunch({ runId, capability, model, effort, resumeSessionId, delegate }) {
    const argv = [
      "-p",
      "--output-format",
      "stream-json",
      // これが無いと JSONL にならない。落とすと静かに壊れる。
      "--verbose",
      // 子に MCP サーバを一切読ませない（このサーバ自身を読んで再帰するのを断つ）。
      "--strict-mcp-config",
      // 承認が要る操作は、誰も答えられないので自動的に拒否される。
      "--permission-prompts",
      "none",
      // 孤児回収の目印。実プロセスの argv にそのまま現れることを実測済み。
      "-n",
      runId,
    ];
    if (resumeSessionId) argv.push("--resume", resumeSessionId);
    if (model) argv.push("--model", model);
    if (effort) argv.push("--effort", effort);

    let tools = capability === "write" ? WRITE_TOOLS : READ_TOOLS;
    if (delegate) tools = `${tools},${DELEGATE_TOOLS}`;
    argv.push("--tools", tools);

    if (capability === "write") argv.push("--permission-mode", "acceptEdits");

    // 可変長引数なので、後ろに別のフラグが続かない末尾に置く。
    const allowed = allowedToolPatterns();
    if (allowed.length > 0) argv.push("--allowedTools", ...allowed);

    return { argv, env: scrubbedEnv(), marker: runId };
  },

  // claude の tool 名を、codex と共通の進捗語彙へ写像する。
  // ここを揃えないと status の内訳表示が backend ごとに別物になる。
  itemTypeFor(toolName) {
    if (toolName === "Bash" || toolName === "PowerShell") return "command_execution";
    if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
      return "file_change";
    }
    if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") return "file_read";
    if (toolName === "WebSearch" || toolName === "WebFetch") return "web_search";
    return `tool:${toolName}`;
  },

  parseEvent(event) {
    if (!event || typeof event !== "object") return null;

    if (event.type === "system" && event.subtype === "init") {
      const delta = { extra: {} };
      if (typeof event.session_id === "string") delta.sessionId = event.session_id;
      if (Array.isArray(event.tools)) delta.extra.cli_tools = event.tools;
      if (typeof event.apiKeySource === "string") {
        delta.extra.api_key_source = event.apiKeySource;
      }
      // --strict-mcp-config が効いていない。子がこのサーバを読み込んでいる可能性が
      // あり、放置すると再帰して課金が伸び続ける。警告では足りないので打ち切る。
      if (Array.isArray(event.mcp_servers) && event.mcp_servers.length > 0) {
        delta.abort =
          `子プロセスが MCP サーバを読み込んでいます（${event.mcp_servers.length} 件）。` +
          "--strict-mcp-config が効いていません";
      }
      // 許可リストの綴りを間違えると静かに無視される。Task が残っていたら気づけるように。
      if (Array.isArray(event.tools) && event.tools.includes("Task")) {
        delta.extra.delegation_possible = true;
      }
      return delta;
    }

    if (event.type === "assistant") {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const delta = { itemTypes: [], messages: [] };
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          delta.itemTypes.push("agent_message");
          delta.messages.push(block.text);
        } else if (block?.type === "thinking") {
          delta.itemTypes.push("reasoning");
        } else if (block?.type === "tool_use") {
          delta.itemTypes.push(this.itemTypeFor(block.name));
        }
      }
      return delta.itemTypes.length > 0 ? delta : null;
    }

    // tool_result。assistant 側の tool_use で数えているので、ここで数えると二重になる。
    if (event.type === "user") return null;

    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info;
      return info ? { extra: { rate_limit: info } } : null;
    }

    if (event.type === "result") {
      const delta = { completed: true, extra: {} };
      if (event.usage) delta.usage = event.usage;
      if (typeof event.total_cost_usd === "number") {
        delta.extra.cost_usd = event.total_cost_usd;
      }
      if (typeof event.num_turns === "number") delta.extra.num_turns = event.num_turns;
      if (Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
        // 「テストを実行できなかった」の原因がここに出る。捨てると理由が分からない。
        delta.extra.permission_denials = event.permission_denials.map((d) => ({
          tool_name: d?.tool_name ?? null,
          command: d?.tool_input?.command ?? d?.tool_input?.file_path ?? null,
        }));
      }
      if (event.subagent_stats?.spawned > 0) {
        delta.extra.subagents_spawned = event.subagent_stats.spawned;
      }
      const failed = event.is_error === true || event.subtype !== "success";
      if (failed) {
        delta.failure =
          typeof event.result === "string" && event.result.trim() !== ""
            ? event.result
            : (event.api_error_status ?? event.subtype ?? "claude が失敗を返しました");
      } else if (typeof event.result === "string") {
        // claude は -o 相当を持たないので、engine に last-message.txt を書かせる。
        delta.finalMessage = event.result;
      }
      return delta;
    }

    return null;
  },

  // thinking の署名は長いうえ後から読んでも意味がない。丸ごと落とす。
  shrinkEventLine(line) {
    try {
      const parsed = JSON.parse(line);
      const blocks = parsed?.message?.content;
      if (Array.isArray(blocks)) {
        parsed.message.content = blocks.map((b) => {
          if (b?.type === "thinking") return { type: "thinking", thinking: "（省略）" };
          if (b?.type === "text" && typeof b.text === "string" && b.text.length > 4096) {
            return {
              type: "text",
              text: `${b.text.slice(0, 4096)}…（全 ${b.text.length} 文字。全文は messages.jsonl）`,
            };
          }
          return b;
        });
        return JSON.stringify(parsed);
      }
      return JSON.stringify({ type: "truncated_event", original_type: parsed?.type ?? null });
    } catch {
      return JSON.stringify({ type: "truncated_line", chars: line.length });
    }
  },
};
