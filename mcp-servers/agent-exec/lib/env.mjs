// 環境変数の読み出し。5.0.0 で `CODEX_MCP_*` を `AGENT_EXEC_*` へ改名したので、
// 移行期間のあいだは旧名も読む。
//
// 旧名を黙って無視すると、端末ごとにセットアップする運用では「片方の端末だけ設定が
// 効いていない」状態が起きて気づけない。警告を出して、読んだ値は使う。

const warned = new Set();

/**
 * 新名 → 旧名の順に探す。どちらも無ければ undefined。
 * 旧名で当たったときは一度だけ stderr に警告を出す。
 */
export function readEnv(name, legacyName) {
  const value = process.env[name];
  if (value !== undefined) return value;
  if (!legacyName) return undefined;
  const legacy = process.env[legacyName];
  if (legacy === undefined) return undefined;
  if (!warned.has(legacyName)) {
    warned.add(legacyName);
    process.stderr.write(
      `warning: 環境変数 ${legacyName} は ${name} に改名されました（今回は旧名の値を使います）\n`,
    );
  }
  return legacy;
}

/** 整数として読む。不正な値や 0 は fallback に倒す（既存の挙動に合わせる）。 */
export function readEnvInt(name, legacyName, fallback, min = 0) {
  const raw = readEnv(name, legacyName);
  return Math.max(min, Number.parseInt(raw ?? "", 10) || fallback);
}
