// Codex CLI (`codex exec`) のアダプタ。
//
// engine から呼ばれるのは純粋な関数だけで、このファイルは runs.mjs も
// child_process も import しない（永続化も spawn もしない）。おかげで argv 組み立てと
// イベント解釈は spawn 無しでテストできる。
//
// `--json` を使うのは、最終メッセージ（-o）が最後に一度しか書かれないためである。
// 長時間の作業では、報告を書き出す前に打ち切られると内容が丸ごと失われる。
// イベントを逐次受け取れば、打ち切っても「そこまでの報告」を返せる。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

// capability（読み取り専用 / 書ける）を codex の sandbox 値へ翻訳する。
// codex は CLI が OS レベルで強制するので、enforcement は os-sandbox。
const SANDBOX = {
  read: { label: "read-only", enforcement: "os-sandbox" },
  write: { label: "workspace-write", enforcement: "os-sandbox" },
};

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
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

export default {
  id: "codex",
  label: "Codex CLI (codex exec)",
  binEnv: "CODEX_BIN",
  bin: () => process.env.CODEX_BIN || "codex",
  efforts: EFFORTS,
  // codex は cwd から AGENTS.md を project doc として読む。
  projectDoc: "AGENTS.md",
  // codex は内部でサブエージェントへ委譲しうるが、設定では止められない（実測）。
  // prompt で頼むしかないので、engine に SOLO_NOTE を添えさせる。
  needsSoloNote: true,

  sandbox(capability) {
    return SANDBOX[capability] ?? SANDBOX.read;
  },

  // 既知モデルの一覧。説明文と警告のためのヒントであり、この一覧に無いモデルも拒否しない
  // （キャッシュが古いと正当なモデルを弾いてしまうため）。
  knownModels() {
    try {
      const parsed = JSON.parse(readFileSync(join(codexHome(), "models_cache.json"), "utf8"));
      const models = Array.isArray(parsed?.models) ? parsed.models : [];
      return models
        .filter((m) => m && typeof m.slug === "string" && m.visibility === "list")
        .map((m) => ({
          slug: m.slug,
          efforts: (Array.isArray(m.supported_reasoning_levels)
            ? m.supported_reasoning_levels
            : []
          )
            .map((l) => l?.effort)
            .filter((e) => typeof e === "string"),
        }));
    } catch {
      return [];
    }
  },

  // キャッシュに情報が無ければ判定せず true を返す（古いキャッシュで正当な組み合わせを
  // 弾かないため）。
  supportsEffort(model, effort, known = this.knownModels()) {
    const entry = model ? known.find((m) => m.slug === model) : undefined;
    if (!entry || entry.efforts.length === 0) return true;
    return entry.efforts.includes(effort);
  },

  effortsFor(model, known = this.knownModels()) {
    const entry = model ? known.find((m) => m.slug === model) : undefined;
    return entry?.efforts ?? [];
  },

  configHint: "~/.codex/config.toml",
  modelsCacheHint: "models_cache.json",

  // 純関数。argv / 追加 env / argv マーカーを返す。
  buildLaunch({ runId, capability, cwd, model, effort, resumeSessionId, runDir, skipGitRepoCheck }) {
    const sandbox = this.sandbox(capability).label;
    const lastMessagePath = join(runDir, "last-message.txt");
    const argv = ["exec"];
    if (resumeSessionId) {
      // resume が受け付けるのは --json / -o / -m / -c / --skip-git-repo-check などに限られ、
      // -s / -C / --color は無い（codex 0.154.0 で実測）。sandbox は config override で固定し、
      // 作業ディレクトリは spawn の cwd で与える。"-" で prompt を stdin から読ませる。
      argv.push("resume", resumeSessionId, "-", "-c", `sandbox_mode="${sandbox}"`);
    } else {
      argv.push("-s", sandbox, "-C", cwd, "--color", "never");
    }
    argv.push("--json", "-o", lastMessagePath);
    if (skipGitRepoCheck) argv.push("--skip-git-repo-check");
    if (model) argv.push("-m", model);
    // model / effort / sandbox はいずれも検証済みの値のみ埋め込む。
    if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
    return {
      argv,
      env: {},
      // 孤児回収の身元確認に使う目印。`-o <runs>/<run_id>/last-message.txt` が
      // 必ず argv に入るので、run_id は偶然一致しない文字列として機能する。
      // engine が launch 前に argv に含まれることを検証する。
      marker: runId,
    };
  },

  // 1 イベントから読み取れた事実だけを返す純関数。永続化も副作用も持たない。
  // 実測できているのは thread.started / turn.started / item.completed / turn.completed の
  // 4 種と、item.type = agent_message の text だけ。未知の item は type を数えるに留め、
  // 中身の解釈は生ログ（events.jsonl）に委ねる。
  parseEvent(event) {
    if (!event || typeof event !== "object") return null;
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return { sessionId: event.thread_id };
    }
    if (event.type === "item.completed") {
      const itemType = typeof event.item?.type === "string" ? event.item.type : "unknown";
      const delta = { itemType };
      if (itemType === "agent_message" && typeof event.item?.text === "string") {
        delta.message = event.item.text;
      }
      return delta;
    }
    if (event.type === "turn.completed") {
      // usage が無い turn.completed もありうる。終端を見たことだけは必ず記録する。
      return event.usage ? { completed: true, usage: event.usage } : { completed: true };
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
      return { failure: extractApiMessage(message) };
    }
    return null;
  },

  // 1 行が長すぎるときの縮め方。文字列の途中で切ると JSON が壊れて後から読めなくなるので、
  // フィールドを切ってから組み直す。
  shrinkEventLine(line) {
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
  },
};
