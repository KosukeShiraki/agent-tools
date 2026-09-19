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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { resolveAdapter } from "./backends/index.mjs";
import { currentProcessStartTime, isAlive, processStartTime } from "./platform.mjs";
import { RUNS_ROOT } from "./runs.mjs";

export const CONFIG_PATH = join(dirname(RUNS_ROOT), "config.json");
const LOCK_PATH = `${CONFIG_PATH}.lock`;
// 設定の変更は「モデルを切り替える」ときの操作で、頻度は低く一瞬で終わる。
// ここで長く待たせるより、待てなければ理由を返して呼び直させる。
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;

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
  // 一時ファイルは**書き手ごとに分ける**。固定名にすると、A が書いた一時ファイルを
  // B が上書きしてから A が rename し、**A の応答と実際に保存された内容が食い違う**。
  // 続く B の rename は動かされた後なので ENOENT になる。runs.mjs も同じ理由で
  // pid を付けている。
  const tmp = `${CONFIG_PATH}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, CONFIG_PATH); // 書きかけを他のサーバに読ませない
  } catch (err) {
    rmSync(tmp, { force: true }); // rename 前に落ちても置き去りにしない
    throw err;
  }
}

/** 設定ファイルを触っている別サーバが落ちて残したロックか */
function lockIsStale() {
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(LOCK_PATH, "owner.json"), "utf8"));
  } catch {
    // mkdir と owner.json の間で落ちた、あるいはまだ書かれていない。
    // 前者と後者を見分けられないので、十分に古いときだけ横取りする。
    try {
      return Date.now() - statMtimeMs(LOCK_PATH) > LOCK_TIMEOUT_MS * 4;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(owner?.pid) || !isAlive(owner.pid)) return true;
  // pid が生きていても、それが持ち主とは限らない（PID 再利用）。起動時刻まで見る。
  return Boolean(owner.start) && processStartTime(owner.pid) !== owner.start;
}

function statMtimeMs(path) {
  return statSync(path).mtimeMs;
}

// 同期のまま待つ。setTimeout は使えない（updateConfig は同期）。ビジーループに
// しないために Atomics.wait を使う。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 「読み込み → パッチ適用 → 検証 → 保存」を 1 つの操作として守る。
 *
 * temp + rename が保証するのは**書き換えの不可分性だけ**で、読み書きの排他ではない。
 * 別の Claude Code セッションの MCP サーバが同じ config.json を使うので、守らないと
 * 「A が consult を、B が apply を変えて、どちらも成功と答えたのに A の変更だけ消える」
 * が起きる。設定が黙って消えるのは 7.0.0 で潰したはずの失敗なので、ここで再発させない。
 *
 * mkdir は不可分なので、これだけでプロセス間の排他になる（依存を増やさずに済む）。
 */
function withConfigLock(fn) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_PATH); // recursive を付けない。既にあれば EEXIST で落ちる
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (lockIsStale()) {
        rmSync(LOCK_PATH, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `他のプロセスが設定を更新中のため ${LOCK_TIMEOUT_MS} ms 待っても書き込めませんでした` +
            `（${LOCK_PATH}）。少し待って config を呼び直してください。`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    writeFileSync(
      join(LOCK_PATH, "owner.json"),
      JSON.stringify({ pid: process.pid, start: currentProcessStartTime() }),
    );
    return fn();
  } finally {
    rmSync(LOCK_PATH, { recursive: true, force: true });
  }
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

  // 検査には**接頭辞を落とした名前**を使う。resolveSettings が使うのはこちらなので、
  // ここで "codex:gpt-5.5" のまま渡すと検査と実行で別のモデル名を見ることになる。
  // キャッシュの slug に接頭辞は付かないため、接頭辞付きは必ず「キャッシュに無い」
  // 側へ落ちて検査が素通りし、**保存では受理した effort を run が黙って捨てる**。
  const { adapter, model: resolved } = resolveAdapter(model);
  if (!adapter.efforts.includes(effort)) {
    return (
      `${toolName}: effort=${effort} は ${adapter.id} では使えません` +
      `（対応値: ${adapter.efforts.join(", ")}）`
    );
  }
  const known = adapter.knownModels();
  if (!adapter.supportsEffort(resolved, effort, known)) {
    return (
      `${toolName}: ${resolved} は effort=${effort} に対応していません` +
      `（対応値: ${adapter.effortsFor(resolved, known).join(", ")}）`
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

/**
 * 設定を書き換えて保存する。
 *
 * `validate` を渡すと、**ロックの中で読み直した設定**に対して呼ぶ。検証と保存を
 * 別々に設定を読んで行うと、その間に他のサーバが書き換えた場合に「検証した内容」と
 * 「保存した内容」がずれる。理由を返せばファイルには触らない。
 *
 * @param {(toolName: string, patch: object, config: object) => string|null} [validate]
 * @returns {{ config: object, reason?: undefined } | { reason: string, config?: undefined }}
 */
export function updateConfig(patchByTool, validate) {
  return withConfigLock(() => {
    const config = readConfig();
    if (validate) {
      for (const [toolName, patch] of Object.entries(patchByTool)) {
        const reason = validate(toolName, patch, config);
        if (reason) return { reason };
      }
    }
    return { config: mergeAndWrite(config, patchByTool) };
  });
}

function mergeAndWrite(config, patchByTool) {
  for (const [toolName, patch] of Object.entries(patchByTool)) {
    const next = mergeInto(config[toolName] ?? {}, patch);
    if (Object.keys(next).length === 0) delete config[toolName];
    else config[toolName] = next;
  }
  writeConfig(config);
  return config;
}
