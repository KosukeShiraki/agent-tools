// モデル名から、起動する CLI を決める。
//
// 利用者が決めるのはモデルと effort だけ（tool の引数ではなく環境変数）。モデルが
// 決まれば行き先も決まるので、`backend` という概念を呼び出し側に見せる必要はない。
//
// 未知のモデル名は**拒否しない**。models_cache.json が古い／新しいモデルが出た、で
// 正当な設定を弾くと毎 run 失敗する（effort 検証と同じ思想）。従来の既定である codex へ
// 倒したうえで、起動時に警告を出す。

import claudeBackend from "./claude.mjs";
import codexBackend from "./codex.mjs";

export const ADAPTERS = [codexBackend, claudeBackend];
export const DEFAULT_ADAPTER = codexBackend;

// 接頭辞で明示されたとき用。将来モデル名が命名規則を破ったときの逃げ道。
const EXPLICIT = /^(codex|claude):(.+)$/i;

// 前方一致にするのは opus-4.5 / sonnet[1m] / claude-opus-5[1m] / opusplan を拾うため。
const CLAUDE_PATTERNS = [
  /^(opus|sonnet|haiku|fable)/i,
  /^claude[-.]/i,
  /^(us|eu|apac)\.anthropic\./i, // Bedrock 形式
];
const CODEX_PATTERNS = [/^(gpt|codex|o[0-9])/i];

export function adapterById(id) {
  return ADAPTERS.find((a) => a.id === id) ?? DEFAULT_ADAPTER;
}

/**
 * @returns {{ adapter, model: string|undefined, reason: string, confident: boolean }}
 */
export function resolveAdapter(rawModel) {
  if (rawModel === undefined || rawModel === null || rawModel === "") {
    // 「既定なし」= CLI 側の設定に委ねる。従来どおり codex。
    return {
      adapter: DEFAULT_ADAPTER,
      model: undefined,
      reason: "モデル未指定のため既定",
      confident: true,
    };
  }
  const explicit = EXPLICIT.exec(rawModel);
  if (explicit) {
    return {
      adapter: adapterById(explicit[1].toLowerCase()),
      model: explicit[2],
      reason: "接頭辞で明示",
      confident: true,
    };
  }
  // models_cache.json は codex にとって権威ある一覧なので、パターンより先に見る。
  if (codexBackend.knownModels().some((m) => m.slug === rawModel)) {
    return {
      adapter: codexBackend,
      model: rawModel,
      reason: "models_cache.json に一致",
      confident: true,
    };
  }
  if (CLAUDE_PATTERNS.some((re) => re.test(rawModel))) {
    return { adapter: claudeBackend, model: rawModel, reason: "claude 系の名前", confident: true };
  }
  if (CODEX_PATTERNS.some((re) => re.test(rawModel))) {
    return { adapter: codexBackend, model: rawModel, reason: "codex 系の名前", confident: true };
  }
  return {
    adapter: DEFAULT_ADAPTER,
    model: rawModel,
    reason: "どの CLI にも紐づかないため既定へ",
    confident: false,
  };
}
