// claude バックエンドを実際に spawn して回すテスト（ダミー CLI を使う）。
//
// resolve.test.mjs が純関数側を見るのに対し、ここは engine との噛み合わせを見る:
// マーカー契約・最終報告の書き出し・env の掃除・abort・切り離し・git 差分。
// engine 自体は backend 非依存なので、codex で通っている経路が claude でも
// 通ることを確かめるのが目的。
import assert from "node:assert/strict";
import { existsSync, readFileSync as read, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { FAKE_SESSION_ID, argvOf, makeWorkspace, runIdOf, startServer, textOf } from "./helpers.mjs";

// claude 系のモデル名を設定すると、解決器が claude アダプタを選ぶ。
// backend という引数は存在しない。設定は config.json（7.0.0 で環境変数を廃した）。
const CLAUDE_CONFIG = {
  consult: { model: "opus", effort: "xhigh" },
  apply: { model: "sonnet", effort: "max" },
};

describe("claude バックエンド", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("claude");
    ws.writeConfig(CLAUDE_CONFIG);
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("モデル名だけで claude が起動する（backend 引数は無い）", async () => {
    const res = await server.call("consult", { prompt: "調べて", cwd: ws.plainDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.ok(argv.includes("-p"), argv.join(" "));
    assert.equal(argv[argv.indexOf("--model") + 1], "opus");
    assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
    assert.equal(read(ws.stdinFile, "utf8"), "調べて", "prompt は stdin から渡す");
  });

  it("起動ログにどの CLI へ行くかを出す", () => {
    assert.match(server.stderr, /consult: model=opus/);
    assert.match(server.stderr, /fake-claude/);
    assert.match(server.stderr, /apply: model=sonnet/);
  });

  it("cwd は spawn で与える（-C 相当は無い）", async () => {
    await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    assert.equal(read(ws.pwdFile, "utf8").trim(), ws.plainDir);
    assert.ok(!argvOf(ws.argvFile).includes("-C"));
  });

  it("親セッションの環境変数が子に届かない", async () => {
    await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    // ダミーが「自分から見えた危険な環境変数」を書き出している
    const leaked = read(ws.childEnvFile, "utf8").trim();
    assert.equal(leaked, "", `子に環境変数が漏れている:\n${leaked}`);
  });

  // codex は -o が last-message.txt を書く。claude は書かないので engine が書く。
  it("最終報告を last-message.txt に書く", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    const runId = runIdOf(textOf(res.result));
    assert.equal(read(join(ws.runsDir, runId, "last-message.txt"), "utf8"), "FAKE_ANSWER");
    assert.match(textOf(res.result), /FAKE_ANSWER/);
  });

  it("進捗の内訳は codex と同じ語彙で出る", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    const runId = runIdOf(textOf(res.result));
    const meta = JSON.parse(read(join(ws.runsDir, runId, "meta.json"), "utf8"));
    assert.equal(meta.backend, "claude");
    assert.equal(meta.capability, "read");
    assert.equal(meta.enforcement, "tool-allowlist");
    assert.equal(meta.item_counts.agent_message, 1);
    assert.equal(meta.item_counts.command_execution, 1, "Bash → command_execution");
    assert.equal(meta.item_counts.reasoning, 1, "thinking → reasoning");
    assert.equal(meta.argv_marker, runId, "マーカーが argv に確認できている");
    assert.equal(meta.reclaimable, true);
  });

  it("session_id を記録し、resume で渡せる", async () => {
    const first = await server.call("consult", { prompt: "最初", cwd: ws.plainDir });
    assert.match(textOf(first.result), new RegExp(`session_id=${FAKE_SESSION_ID}`));
    const res = await server.call("consult", {
      prompt: "続きを",
      cwd: ws.plainDir,
      resume_session_id: FAKE_SESSION_ID,
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("--resume") + 1], FAKE_SESSION_ID);
  });

  it("委譲は prompt ではなく argv で止める", async () => {
    await server.call("consult", { prompt: "調べて", cwd: ws.plainDir });
    const sent = read(ws.stdinFile, "utf8");
    // Task を許可リストから外すので、prompt で頼む必要がない
    assert.ok(!sent.includes("サブエージェントへの委譲"), sent);
    const argv = argvOf(ws.argvFile);
    assert.ok(!argv[argv.indexOf("--tools") + 1].split(",").includes("Task"));
  });

  it("apply では acceptEdits と書き込み系ツールを渡す", async () => {
    const res = await server.call("apply", { prompt: "直して", cwd: ws.gitDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.ok(argv[argv.indexOf("--tools") + 1].split(",").includes("Bash"));
    // bypassPermissions は cwd の外へも書けてしまう（実測）。使わない。
    assert.ok(!argv.includes("bypassPermissions"), argv.join(" "));
  });

  it("apply には OS サンドボックスでないことの注記が付く", async () => {
    const res = await server.call("apply", { prompt: "x", cwd: ws.gitDir });
    assert.match(textOf(res.result), /OS サンドボックスではなく/);
  });

  it("consult には注記を付けない（読むだけなので）", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    assert.ok(!textOf(res.result).includes("OS サンドボックスではなく"));
  });
});

describe("claude の異常系", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("claude-err");
    ws.writeConfig(CLAUDE_CONFIG);
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("result に本文が無くても、途中の報告を返せる", async () => {
    const server = startServer(ws.env({ CLAUDE_FAKE_NO_RESULT: "1" }));
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.match(textOf(res.result), /PARTIAL_REPORT/);
    } finally {
      server.close();
    }
  });

  it("claude 側のエラーを応答に載せる", async () => {
    const server = startServer(
      ws.env({ CLAUDE_FAKE_ERROR_RESULT: "model not available" }),
    );
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.match(textOf(res.result), /model not available/);
    } finally {
      server.close();
    }
  });

  // 「テストを走らせられなかった」理由。捨てると原因が分からない。
  it("拒否された操作を応答に載せ、直し方を示す", async () => {
    const server = startServer(
      ws.env({ CLAUDE_FAKE_DENIAL: "node --test" }),
    );
    try {
      const res = await server.call("apply", { prompt: "テストして", cwd: ws.gitDir });
      const text = textOf(res.result);
      assert.match(text, /node --test/);
      assert.match(text, /許可されていない/);
      assert.match(text, /AGENT_EXEC_CLAUDE_ALLOWED_TOOLS/);
    } finally {
      server.close();
    }
  });

  // 切り離した run ほど長く、拒否も起きやすい。result に出ないと、一番必要な
  // ときだけ「テストを実行できなかった」が消える。
  it("切り離して result で取っても拒否が出る", async () => {
    const server = startServer(
      ws.env({ CLAUDE_FAKE_DENIAL: "uv run pytest", CLAUDE_FAKE_SLEEP: "4" }),
    );
    try {
      const first = await server.call(
        "apply",
        { prompt: "テストして", cwd: ws.gitDir, timeout_ms: 1_000 },
        {},
        20_000,
      );
      assert.match(textOf(first.result), /切り離しました/);
      const runId = runIdOf(textOf(first.result));
      const res = await server.call("result", { run_id: runId, wait_ms: 20_000 }, {}, 30_000);
      const text = textOf(res.result);
      assert.match(text, /uv run pytest/, "result に拒否が出ていない");
      assert.match(text, /AGENT_EXEC_CLAUDE_ALLOWED_TOOLS/);
    } finally {
      server.close();
    }
  });

  // CLI がイベントで失敗を伝えつつ exit 0 で終えると state は completed になる。
  // 同期応答だけが isError を返し、result は成功扱いになっていた。
  it("失敗イベント + exit 0 でも result は失敗として返す", async () => {
    const server = startServer(
      ws.env({
        CLAUDE_FAKE_ERROR_RESULT: "model not available",
        CLAUDE_FAKE_SLEEP: "4",
      }),
    );
    try {
      const first = await server.call(
        "consult",
        { prompt: "x", cwd: ws.plainDir, timeout_ms: 1_000 },
        {},
        20_000,
      );
      const runId = runIdOf(textOf(first.result));
      const res = await server.call("result", { run_id: runId, wait_ms: 20_000 }, {}, 30_000);
      assert.equal(res.result.isError, true, textOf(res.result));
      assert.match(textOf(res.result), /model not available/);
    } finally {
      server.close();
    }
  });
});

describe("セッション索引だけで resume できる", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("sessionidx");
    ws.writeConfig(CLAUDE_CONFIG);
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  // 索引を run 本体と別寿命にしているのは「run が消えても会話を続ける」ため。
  // backend を索引に書いていないと、run が prune された後に codex 扱いへ倒れ、
  // claude のセッションが「別の CLI で作られています」と拒否されていた。
  it("run が消えても claude のセッションと分かる", async () => {
    const server = startServer(ws.env());
    let runId;
    try {
      const res = await server.call("consult", { prompt: "最初", cwd: ws.plainDir });
      runId = runIdOf(textOf(res.result));
      const indexed = JSON.parse(
        read(join(ws.runsDir, "sessions", `${FAKE_SESSION_ID}.json`), "utf8"),
      );
      assert.equal(indexed.backend, "claude", "索引に backend が無い");
    } finally {
      server.close();
    }

    // run 本体だけ消す（prune や保持期限で起きる状態を再現する）
    rmSync(join(ws.runsDir, runId), { recursive: true, force: true });

    const after = startServer(ws.env());
    try {
      const res = await after.call("consult", {
        prompt: "続きを",
        cwd: ws.plainDir,
        resume_session_id: FAKE_SESSION_ID,
      });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.ok(!textOf(res.result).includes("別の CLI"), textOf(res.result));
    } finally {
      after.close();
    }
  });

  // 再帰は課金が伸び続けるので、警告ではなく打ち切りにする。
  it("子が MCP を継承していたら打ち切る", async () => {
    const server = startServer(
      ws.env({ CLAUDE_FAKE_MCP_LEAK: "1", CLAUDE_FAKE_SLEEP: "5" }),
    );
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir }, {}, 30_000);
      assert.match(textOf(res.result), /strict-mcp-config/);
    } finally {
      server.close();
    }
  });

  it("壊れた行や巨大な本文でも落ちない", async () => {
    const server = startServer(ws.env({ CLAUDE_FAKE_WEIRD: "1" }));
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      const runId = runIdOf(textOf(res.result));
      assert.ok(existsSync(join(ws.runsDir, runId, "messages.jsonl")));
      assert.deepEqual(server.badLines, []);
    } finally {
      server.close();
    }
  });
});

describe("claude で engine の経路が通る", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("claude-engine");
    ws.writeConfig(CLAUDE_CONFIG);
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("apply の git 差分が付く", async () => {
    const server = startServer(ws.env({ CLAUDE_FAKE_TOUCH: "seed.txt" }));
    try {
      const res = await server.call("apply", { prompt: "直して", cwd: ws.gitDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.match(textOf(res.result), /seed\.txt/, "git 差分が応答に付いていない");
    } finally {
      server.close();
    }
  });

  it("切り離しても、そこまでの報告と run_id を返す", async () => {
    const server = startServer(ws.env({ CLAUDE_FAKE_SLEEP: "6" }));
    try {
      const res = await server.call(
        "consult",
        { prompt: "x", cwd: ws.plainDir, timeout_ms: 1_000 },
        {},
        20_000,
      );
      assert.match(textOf(res.result), /切り離しました/);
      assert.match(textOf(res.result), /PARTIAL_REPORT/);
      const runId = runIdOf(textOf(res.result));
      const result = await server.call("result", { run_id: runId, wait_ms: 20_000 }, {}, 30_000);
      assert.match(textOf(result.result), /FAKE_ANSWER/);
    } finally {
      server.close();
    }
  });
});

describe("backend をまたぐ resume", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("crossbackend");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  // 設定のモデルを codex 系から claude 系へ変えた直後に必ず踏む。
  // 黙って失敗させず、理由を明示する。
  it("別の CLI で作られたセッションは再開できない", async () => {
    const codexServer = startServer(ws.env());
    let sessionId;
    try {
      const res = await codexServer.call("consult", { prompt: "最初", cwd: ws.plainDir });
      sessionId = textOf(res.result).match(/session_id=([0-9a-f-]+)/)[1];
    } finally {
      codexServer.close();
    }

    ws.writeConfig(CLAUDE_CONFIG); // ここで claude 系へ切り替える
    const claudeServer = startServer(ws.env());
    try {
      const res = await claudeServer.call("consult", {
        prompt: "続きを",
        cwd: ws.plainDir,
        resume_session_id: sessionId,
      });
      assert.equal(res.result.isError, true, textOf(res.result));
      assert.match(textOf(res.result), /別の CLI（codex）で作られています/);
    } finally {
      claudeServer.close();
    }
  });
});
