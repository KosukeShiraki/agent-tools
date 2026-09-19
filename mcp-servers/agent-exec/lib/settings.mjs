// モデルと effort の設定。7.0.0 で環境変数を廃し、MCP の `config` tool から読み書きする
// 1 つの JSON に集約した。
//
// 環境変数だった頃の問題は 2 つある。
//   1. MCP しか使えないエージェントからは、設定を見ることも変えることもできなかった。
//      設定が MCP の外にあるせいで、README・ホームの道標・CLI フラグといった仕組みを
//      外側に足し続けることになっていた。
//   2. `claude mcp` に env だけを編集する手段が無く、登録し直すたびに指定漏れで静かに
//      消えた（実際に消え、codex の既定へ戻っていたのに数時間気づけなかった）。
//
// ファイルなら、どちらも起きない。置き場は run の記録の隣（clone の外）なので、
// git pull でも再登録でも消えず、記録先を差し替えればテストからも隔離できる。
//
// 設定できるのはモデルと effort だけ。claude の許可コマンド（どのコマンドを無条件に
// 実行してよいか）は**コードに置いたまま**にする。あれは金額ではなく安全の宣言で、
// 実行中のエージェントが自分で緩められる場所に置くものではない。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveAdapter } from "./backends/index.mjs";
import { RUNS_ROOT } from "./runs.mjs";

export const CONFIG_PATH = join(dirname(RUNS_ROOT), "config.json");

// 設定できるキー。増やすときはここと config tool の schema の両方を変える。
export const SETTING_KEYS = ["model", "effort"];

/**
 * 保存されている設定。壊れていても落とさない——起動できないほうが困るので、
 * 警告を出してコード既定で動く。
 */
export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    process.stderr.write(
      `warning: ${CONFIG_PATH} を読めないためコード既定で動きます: ${err.message}\n`,
    );
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, CONFIG_PATH); // 書きかけを他のサーバに読ませない
}

// 空文字は「モデル/effort を渡さず CLI 側の設定に委ねる」の明示。未設定（キーが無い）
// とは意味が違うので、undefined へ畳んでから扱う。
function pick(stored, key, fallback) {
  if (stored[key] === undefined) return { value: fallback, fromConfig: false };
  return { value: stored[key] === "" ? undefined : stored[key], fromConfig: true };
}

/**
 * コード既定と保存された設定を重ね、CLI・モデル・effort を決める。
 *
 * **run ごとに呼ぶ**（起動時に 1 度焼かない）。設定の変更が次の run から効くこと、
 * 設定を変えるのにサーバの再起動が要らないことが、この形の要点。
 *
 * 使えない値は捨てて CLI 側の既定に委ねる。押し付けると毎 run 失敗するため。
 * 捨てたことは notes に残し、呼び出し側が必ず見える場所に出す。
 *
 * @returns {{ adapter, model: string|undefined, effort: string|undefined,
 *             fromConfig: {model: boolean, effort: boolean}, notes: string[] }}
 */
export function resolveSettings(toolName, base, config = readConfig()) {
  const stored = config[toolName] ?? {};
  const picked = {
    model: pick(stored, "model", base.baseModel),
    effort: pick(stored, "effort", base.baseEffort),
  };
  const notes = [];

  const resolved = resolveAdapter(picked.model.value);
  const adapter = resolved.adapter;
  const model = resolved.model;
  if (!resolved.confident) {
    notes.push(
      `モデル "${model}" はどの CLI にも紐づかないため ${adapter.id} として起動します` +
        `（"claude:${model}" のように接頭辞を付けると明示できます）`,
    );
  }

  const known = adapter.knownModels();
  let effort = picked.effort.value;
  if (effort && !adapter.efforts.includes(effort)) {
    notes.push(
      `effort=${effort} は ${adapter.id} には無いため無視します（対応値: ${adapter.efforts.join(", ")}）`,
    );
    effort = undefined;
  } else if (effort && !adapter.supportsEffort(model, effort, known)) {
    notes.push(
      `${model} は effort=${effort} に対応していないため無視します` +
        `（対応値: ${adapter.effortsFor(model, known).join(", ")}）`,
    );
    effort = undefined;
  }
  if (model && known.length > 0 && !known.some((m) => m.slug === model)) {
    notes.push(
      `${model} は ${adapter.modelsCacheHint} に見当たりません` +
        "（キャッシュが古いだけの可能性があるため、そのまま使います）",
    );
  }

  return {
    adapter,
    model,
    effort,
    fromConfig: { model: picked.model.fromConfig, effort: picked.effort.fromConfig },
    notes,
  };
}

/**
 * 保存する前の検査。設定の変更は「意図してやる操作」なので、黙って捨てずにその場で
 * 断る（起動時に stderr へ出すだけの警告は、実際には誰も読まなかった）。
 *
 * @returns {string|null} 断る理由。問題なければ null
 */
export function validatePatch(toolName, base, patch, config = readConfig()) {
  const merged = mergeInto(config[toolName] ?? {}, patch);
  const model = merged.model === undefined ? base.baseModel : merged.model || undefined;
  const effort = merged.effort === undefined ? base.baseEffort : merged.effort || undefined;
  if (!effort) return null;

  const { adapter } = resolveAdapter(model);
  if (!adapter.efforts.includes(effort)) {
    return (
      `${toolName}: effort=${effort} は ${adapter.id} では使えません` +
      `（対応値: ${adapter.efforts.join(", ")}）`
    );
  }
  const known = adapter.knownModels();
  if (!adapter.supportsEffort(model, effort, known)) {
    return (
      `${toolName}: ${model} は effort=${effort} に対応していません` +
      `（対応値: ${adapter.effortsFor(model, known).join(", ")}）`
    );
  }
  return null;
}

function mergeInto(current, patch) {
  const next = { ...current };
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    if (patch[key] === null) delete next[key]; // null = コード既定へ戻す
    else next[key] = patch[key];
  }
  return next;
}

/** 設定を書き換えて保存する。@returns 保存後の全体 */
export function updateConfig(patchByTool) {
  const config = readConfig();
  for (const [toolName, patch] of Object.entries(patchByTool)) {
    const next = mergeInto(config[toolName] ?? {}, patch);
    if (Object.keys(next).length === 0) delete config[toolName];
    else config[toolName] = next;
  }
  writeConfig(config);
  return config;
}
