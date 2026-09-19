// config.json の同時更新。temp + rename が保証するのは書き換えの不可分性だけで、
// 読み書きの排他ではない——同じ config.json を別の Claude Code セッションの MCP サーバが
// 使うので、守らないと「どちらも成功と答えたのに片方の変更だけ消える」が起きる。
//
// spawn しないので **このファイルも Windows で走る**。ロックの実体は mkdir なので、
// 同一プロセスから握っても別プロセスから握っても同じように効く。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// RUNS_ROOT はモジュール読み込み時に env から決まるので、import より前に差し替える。
// 実ホームの ~/.claude/agent-exec/config.json には触らない。
const ROOT = mkdtempSync(join(tmpdir(), "agent-exec-config-"));
process.env.AGENT_EXEC_RUNS_DIR = join(ROOT, "runs");
const { CONFIG_PATH, readConfig, updateConfig } = await import("../lib/settings.mjs");
const LOCK_PATH = `${CONFIG_PATH}.lock`;

describe("設定の同時更新", () => {
  before(() => mkdirSync(process.env.AGENT_EXEC_RUNS_DIR, { recursive: true }));
  after(() => rmSync(ROOT, { recursive: true, force: true }));
  beforeEach(() => {
    rmSync(CONFIG_PATH, { force: true });
    rmSync(LOCK_PATH, { recursive: true, force: true });
  });

  it("更新中はロックを取り、終われば必ず外す", () => {
    let heldDuringUpdate = false;
    const res = updateConfig({ consult: { model: "opus" } }, () => {
      heldDuringUpdate = existsSync(LOCK_PATH);
      return null;
    });
    assert.ok(heldDuringUpdate, "更新中にロックが無い");
    assert.ok(!existsSync(LOCK_PATH), "ロックが残った");
    assert.deepEqual(res.config.consult, { model: "opus" });
  });

  // 検証と保存が別々に設定を読むと、その間に他のサーバが書き換えた場合に
  // 「検証した内容」と「保存した内容」がずれる。同じスナップショットを見ること。
  it("検証はロックの中で、保存するのと同じ設定を見る", () => {
    updateConfig({ apply: { model: "gpt-5.5" } });
    let seen;
    updateConfig({ consult: { model: "opus" } }, (_tool, _patch, config) => {
      seen = config;
      return null;
    });
    assert.deepEqual(seen.apply, { model: "gpt-5.5" }, "保存済みの設定が検証に渡らない");
  });

  it("検証が理由を返したらファイルに触らない", () => {
    updateConfig({ consult: { model: "opus" } });
    const before = readFileSync(CONFIG_PATH, "utf8");
    const res = updateConfig({ consult: { model: "gpt-5.5" } }, () => "だめ");
    assert.equal(res.reason, "だめ");
    assert.equal(res.config, undefined);
    assert.equal(readFileSync(CONFIG_PATH, "utf8"), before, "断ったのに書き換えた");
    assert.ok(!existsSync(LOCK_PATH), "断った経路でロックが残った");
  });

  // 固定名の一時ファイルだと、A が書いたものを B が上書きしてから A が rename し、
  // **A の応答と実際に保存された内容が食い違う**。続く B の rename は ENOENT になる。
  it("一時ファイルは書き手ごとに分ける（他の書き手のものを奪わない）", () => {
    const foreign = `${CONFIG_PATH}.tmp`;
    writeFileSync(foreign, "他の書き手が用意した中身");
    updateConfig({ consult: { model: "opus" } });
    assert.equal(
      readFileSync(foreign, "utf8"),
      "他の書き手が用意した中身",
      "他の書き手の一時ファイルを奪った",
    );
    assert.deepEqual(readConfig().consult, { model: "opus" });
  });

  // ここが排他の本体。ロックは mkdir なので、握っているのが別プロセスでも同じ。
  it("他が握っている間は書けず、理由を返す（黙って上書きしない）", () => {
    mkdirSync(LOCK_PATH);
    // 持ち主は生きている（このプロセス自身）ので、横取りしてはいけない
    writeFileSync(
      join(LOCK_PATH, "owner.json"),
      JSON.stringify({ pid: process.pid, start: null }),
    );
    try {
      assert.throws(
        () => updateConfig({ consult: { model: "opus" } }),
        /設定を更新中/,
        "ロックを無視して書き込んだ",
      );
      assert.ok(!existsSync(CONFIG_PATH), "断ったのに設定が書かれた");
    } finally {
      rmSync(LOCK_PATH, { recursive: true, force: true });
    }
  });

  // サーバが SIGKILL されるとロックだけが残る。永久に設定を変えられなくなるので、
  // 持ち主が died と確認できたときは横取りする。
  it("持ち主が死んだロックは横取りする", () => {
    mkdirSync(LOCK_PATH);
    writeFileSync(
      join(LOCK_PATH, "owner.json"),
      JSON.stringify({ pid: 0x7ffffffe, start: null }), // 存在しない pid
    );
    const res = updateConfig({ consult: { model: "opus" } });
    assert.deepEqual(res.config.consult, { model: "opus" });
    assert.ok(!existsSync(LOCK_PATH), "横取り後にロックが残った");
  });
});
