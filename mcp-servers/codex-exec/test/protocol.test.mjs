// MCP プロトコルと引数検証のテスト。実 codex は呼ばない。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync as read, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  FAKE_THREAD_ID,
  argvOf,
  makeWorkspace,
  runIdOf,
  startServer,
  textOf,
} from "./helpers.mjs";

describe("MCP プロトコル", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("proto");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("initialize がサポート版を反射する", async () => {
    const res = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(res.result.protocolVersion, "2025-06-18");
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.serverInfo.name, "codex-exec");
  });

  it("未知の protocolVersion には自分の版を返す", async () => {
    const res = await server.request("initialize", { protocolVersion: "9999-12-31" });
    assert.equal(res.result.protocolVersion, "2025-06-18");
  });

  it("古い protocolVersion はそのまま受け入れる", async () => {
    const res = await server.request("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(res.result.protocolVersion, "2024-11-05");
  });

  it("initialized 通知には応答せず、後続の ping が通る", async () => {
    server.notify("notifications/initialized", {});
    const res = await server.request("ping", {});
    assert.deepEqual(res.result, {});
  });

  it("tools/list が 6 ツールを返す", async () => {
    const res = await server.request("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "codex_apply",
      "codex_consult",
      "codex_result",
      "codex_runs",
      "codex_status",
      "codex_verify",
    ]);

    const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(byName.codex_consult.required, ["prompt"]);
    assert.deepEqual(byName.codex_apply.required.sort(), ["cwd", "prompt"]);
    assert.deepEqual(byName.codex_status.required, ["run_id"]);
    assert.deepEqual(byName.codex_result.required, ["run_id"]);
    assert.deepEqual(byName.codex_runs.required, []);
    assert.deepEqual(byName.codex_verify.required.sort(), ["prompt", "target_dir"]);
    assert.equal(byName.codex_verify.properties.cwd, undefined, "verify に cwd は無い");

    for (const name of ["codex_consult", "codex_apply"]) {
      const props = byName[name].properties;
      assert.deepEqual(props.reasoning_effort.enum, [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]);
      assert.ok(props.resume_session_id, `${name} に resume_session_id がない`);
      assert.ok(props.kill_on_timeout, `${name} に kill_on_timeout がない`);
    }
    assert.deepEqual(byName.codex_apply.properties.scope.enum, ["strict", "open"]);
    assert.equal(byName.codex_consult.properties.scope, undefined);
  });

  it("tools/list の説明が既定値を示す", async () => {
    const res = await server.request("tools/list", {});
    const byName = Object.fromEntries(
      res.result.tools.map((t) => [t.name, t.inputSchema.properties]),
    );
    assert.match(byName.codex_consult.model.description, /省略時は gpt-6-astra/);
    assert.match(byName.codex_consult.reasoning_effort.description, /省略時は xhigh/);
    assert.match(byName.codex_apply.model.description, /省略時は gpt-5\.6-luna/);
    assert.match(byName.codex_apply.reasoning_effort.description, /省略時は max/);
    // 既知モデルは visibility=list のみ
    assert.match(
      byName.codex_consult.model.description,
      /既知のモデル: gpt-6-astra, gpt-5\.6-luna, gpt-5\.5$/,
    );
  });

  it("未対応メソッドは -32601 を返す", async () => {
    const res = await server.request("resources/list", {});
    assert.equal(res.error.code, -32601);
  });

  it("JSON-RPC のレスポンスには応答しない", async () => {
    server.writeRaw(JSON.stringify({ jsonrpc: "2.0", id: 9001, result: {} }));
    server.writeRaw(JSON.stringify({ jsonrpc: "2.0", id: 9002, error: { code: -1, message: "x" } }));
    const res = await server.request("ping", {});
    assert.deepEqual(res.result, {});
    assert.deepEqual(
      server.unsolicited.filter((m) => m.id === 9001 || m.id === 9002),
      [],
    );
  });

  it("id: null のリクエストは -32600 で弾く", async () => {
    const waiter = server.nextUnmatched();
    server.writeRaw(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }));
    assert.equal((await waiter).error.code, -32600);
  });

  it("壊れた JSON には -32700 を返す", async () => {
    const waiter = server.nextUnmatched();
    server.writeRaw("{ this is not json");
    assert.equal((await waiter).error.code, -32700);
  });

  it("配列（バッチ）は -32600 で拒否する", async () => {
    const waiter = server.nextUnmatched();
    server.writeRaw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    assert.equal((await waiter).error.code, -32600);
  });

  it("未知のツールは isError で返す", async () => {
    const res = await server.call("nope", {});
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知のツール/);
  });

  it("stdout に JSON-RPC 以外を出していない", () => {
    assert.deepEqual(server.badLines, []);
  });
});

describe("引数の検証", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("args");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("空の prompt を弾く", async () => {
    const res = await server.call("codex_consult", { prompt: "   ", cwd: ws.plainDir });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /prompt は空でない文字列/);
  });

  it("相対パスの cwd を弾く", async () => {
    const res = await server.call("codex_consult", { prompt: "x", cwd: "relative/path" });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /絶対パス/);
  });

  it("存在しない cwd を弾く", async () => {
    const res = await server.call("codex_consult", { prompt: "x", cwd: join(ws.root, "nope") });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /存在しません/);
  });

  it("未知の引数キーを弾く（typo の握り潰しを防ぐ）", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      reasoning_Effort: "high",
      bogus: 1,
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知の引数です: reasoning_Effort, bogus/);
  });

  it("codex_consult に scope は渡せない", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      scope: "strict",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知の引数です: scope/);
  });

  it("不正な reasoning_effort を実行前に弾く", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      reasoning_effort: "bogus",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /reasoning_effort が不正/);
  });

  it("モデルが非対応の effort を明示指定したら弾く", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      model: "gpt-5.5",
      reasoning_effort: "ultra",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /モデル gpt-5\.5 は reasoning_effort=ultra に対応していません/);
  });

  it("キャッシュに無いモデルは effort を検証せず通す", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      model: "gpt-unknown",
      reasoning_effort: "ultra",
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-unknown");
  });

  it("resume_session_id は UUID 形式のみ受け付ける", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      resume_session_id: "not-a-uuid",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /UUID 形式/);
  });

  it("kill_on_timeout は真偽値のみ", async () => {
    const res = await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      kill_on_timeout: "yes",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /true \/ false/);
  });

  it("scope は strict / open のみ", async () => {
    const res = await server.call("codex_apply", {
      prompt: "x",
      cwd: ws.gitDir,
      scope: "loose",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /scope は/);
  });

  it("run_id の形式を検証する（path traversal の防止）", async () => {
    for (const runId of ["../etc", "nope", "20260101-000000-aaaa", "20260101-000000-000-TOOLONG"]) {
      const res = await server.call("codex_status", { run_id: runId });
      assert.equal(res.result.isError, true, runId);
      assert.match(textOf(res.result), /run_id の形式が不正/);
    }
  });

  it("cwd の symlink と .. を実体パスへ正規化する", async () => {
    const realDir = join(ws.root, "real-target");
    const linkDir = join(ws.root, "link-to-real");
    execFileSync("mkdir", ["-p", realDir]);
    execFileSync("ln", ["-sfn", realDir, linkDir]);

    await server.call("codex_consult", { prompt: "x", cwd: linkDir });
    const viaLink = argvOf(ws.argvFile);
    assert.equal(viaLink[viaLink.indexOf("-C") + 1], realDir);

    await server.call("codex_consult", { prompt: "x", cwd: join(realDir, "..", "real-target") });
    const viaDotDot = argvOf(ws.argvFile);
    assert.equal(viaDotDot[viaDotDot.indexOf("-C") + 1], realDir);
  });

  it("git 外への symlink は codex_apply で弾く（実体で判定する）", async () => {
    const outside = join(ws.root, "outside-repo");
    const linkInRepo = join(ws.gitDir, "link-to-outside");
    execFileSync("mkdir", ["-p", outside]);
    execFileSync("ln", ["-sfn", outside, linkInRepo]);
    const res = await server.call("codex_apply", { prompt: "x", cwd: linkInRepo });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /git 管理下にありません/);
  });

  it("空の .git ディレクトリは git リポジトリとみなさない", async () => {
    const fakeRepo = join(ws.root, "fake-repo");
    execFileSync("mkdir", ["-p", join(fakeRepo, ".git")]);
    const res = await server.call("codex_apply", { prompt: "x", cwd: fakeRepo });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /git 管理下にありません/);
  });

  it("codex_apply は cwd 必須", async () => {
    const res = await server.call("codex_apply", { prompt: "x" });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /cwd は必須/);
  });
});

describe("codex への引数の渡し方", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("argv");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("codex_consult は read-only で --json を使う", async () => {
    const res = await server.call("codex_consult", { prompt: "調べて", cwd: ws.plainDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[0], "exec");
    assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
    assert.equal(argv[argv.indexOf("-C") + 1], ws.plainDir);
    assert.ok(argv.includes("--json"), argv.join(" "));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.match(read(ws.stdinFile, "utf8"), /^調べて/);
  });

  it("codex_apply は workspace-write で git チェックを外さない", async () => {
    const res = await server.call("codex_apply", { prompt: "直して", cwd: ws.gitDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
    assert.ok(!argv.includes("--skip-git-repo-check"));
  });

  it("既定は consult=astra/xhigh, apply=luna/max, verify=astra/low", async () => {
    await server.call("codex_consult", { prompt: "x", cwd: ws.plainDir });
    const consultArgv = argvOf(ws.argvFile);
    assert.equal(consultArgv[consultArgv.indexOf("-m") + 1], "gpt-6-astra");
    assert.ok(consultArgv.includes('model_reasoning_effort="xhigh"'), consultArgv.join(" "));

    // コードを書かせるのは codex_apply。ここだけ別のモデルを既定にしている
    await server.call("codex_apply", { prompt: "x", cwd: ws.gitDir });
    const applyArgv = argvOf(ws.argvFile);
    assert.equal(applyArgv[applyArgv.indexOf("-m") + 1], "gpt-5.6-luna");
    assert.ok(applyArgv.includes('model_reasoning_effort="max"'), applyArgv.join(" "));

    // 検証はテスト実行が主なので、モデルは据え置きで effort だけ低くしている
    await server.call("codex_verify", { prompt: "x", target_dir: ws.gitDir });
    const verifyArgv = argvOf(ws.argvFile);
    assert.equal(verifyArgv[verifyArgv.indexOf("-m") + 1], "gpt-6-astra");
    assert.ok(verifyArgv.includes('model_reasoning_effort="low"'), verifyArgv.join(" "));
  });

  it("明示指定は既定より優先される", async () => {
    await server.call("codex_consult", {
      prompt: "x",
      cwd: ws.plainDir,
      model: "gpt-5.5",
      reasoning_effort: "low",
    });
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.5");
    assert.ok(argv.includes('model_reasoning_effort="low"'));
  });

  it("resume 時は resume サブコマンドと sandbox_mode の override を使う", async () => {
    // resume 先は自分の記録にある session_id に限るので、まず1本走らせて登録する
    await server.call("codex_consult", { prompt: "最初", cwd: ws.plainDir });

    const res = await server.call("codex_consult", {
      prompt: "続きを",
      cwd: ws.plainDir,
      resume_session_id: FAKE_THREAD_ID,
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "resume");
    assert.equal(argv[2], FAKE_THREAD_ID);
    assert.equal(argv[3], "-"); // prompt は stdin から
    assert.ok(argv.includes('sandbox_mode="read-only"'), argv.join(" "));
    // resume が受け付けないオプションを渡していないこと（実 codex は unexpected argument で落ちる）
    const RESUME_ALLOWED = new Set([
      "-c",
      "-m",
      "-o",
      "--json",
      "--skip-git-repo-check",
      "--last",
      "--all",
      "--ephemeral",
      "--output-schema",
      "--strict-config",
      "--thread-source",
      "--worktree",
      "--enable",
      "--disable",
      "--ignore-rules",
      "--ignore-user-config",
    ]);
    const flags = argv.slice(4).filter((a) => a.startsWith("-") && a !== "-");
    for (const flag of flags) {
      assert.ok(RESUME_ALLOWED.has(flag), `resume が受け付けないオプション: ${flag}`);
    }
    assert.ok(!argv.includes("--color"), argv.join(" "));
    assert.ok(!argv.includes("-s"), argv.join(" "));
    assert.ok(!argv.includes("-C"), argv.join(" "));
    assert.match(read(ws.stdinFile, "utf8"), /^続きを/);
    assert.match(textOf(res.result), new RegExp(`${FAKE_THREAD_ID} から継続`));
  });

  it("記録に無い session_id は resume できない", async () => {
    const res = await server.call("codex_consult", {
      prompt: "続きを",
      cwd: ws.plainDir,
      resume_session_id: "01a09999-0000-7000-8000-000000000000",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /このサーバの記録に見つかりません/);
  });

  it("codex_apply は既定で範囲逸脱を抑える指示を添える", async () => {
    await server.call("codex_apply", { prompt: "抽出だけして", cwd: ws.gitDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^抽出だけして/);
    assert.match(sent, /指示された範囲のみを変更してください/);
    assert.match(sent, /範囲外の気づき/);
  });

  it("scope=open なら範囲の指示を添えない", async () => {
    await server.call("codex_apply", { prompt: "自由にやって", cwd: ws.gitDir, scope: "open" });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^自由にやって/);
    assert.ok(!sent.includes("指示された範囲のみを変更"), sent);
  });

  it("codex_consult には範囲の指示を添えないが、委譲は既定で止める", async () => {
    await server.call("codex_consult", { prompt: "調べて", cwd: ws.plainDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^調べて/);
    assert.ok(!sent.includes("指示された範囲のみを変更"), sent); // scope は apply だけ
    assert.match(sent, /サブエージェントへの委譲/);
  });

  it("codex_apply は既定で「自分で進めて」と頼む（委譲による二重レビューを避ける）", async () => {
    await server.call("codex_apply", { prompt: "直して", cwd: ws.gitDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /サブエージェントへの委譲/);
    assert.match(sent, /独立レビューの/);
    // プロジェクト規則側が委譲を指示している場合があるので、競合を明示して解く
    assert.match(sent, /プロジェクト規則（AGENTS\.md 等）にサブエージェントの利用/);
    assert.match(sent, /呼び出し側が担う役割です/);
  });

  it("delegate: true なら委譲の指示を添えない", async () => {
    await server.call("codex_apply", { prompt: "直して", cwd: ws.gitDir, delegate: true });
    const sent = read(ws.stdinFile, "utf8");
    assert.ok(!sent.includes("サブエージェントへの委譲"), sent);
    assert.match(sent, /指示された範囲のみを変更/); // scope の指示は既定どおり残る
  });

  it("codex_consult も delegate: true で委譲を許せる", async () => {
    await server.call("codex_consult", { prompt: "調べて", cwd: ws.plainDir, delegate: true });
    assert.equal(read(ws.stdinFile, "utf8"), "調べて");
  });

  it("codex_verify は既定で委譲しない", async () => {
    await server.call("codex_verify", { prompt: "テストして", target_dir: ws.gitDir });
    assert.match(read(ws.stdinFile, "utf8"), /サブエージェントへの委譲/);
  });

  it("delegate は真偽値のみ", async () => {
    const res = await server.call("codex_apply", {
      prompt: "x",
      cwd: ws.gitDir,
      delegate: "no",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /delegate は true \/ false/);
  });
});

describe("resume の出自検証", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("resume");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("cwd が違う session_id は resume できない", async () => {
    // plainDir でセッションを作る
    await server.call("codex_consult", { prompt: "最初", cwd: ws.plainDir });
    // 別ディレクトリから同じ session_id を再開しようとする
    const res = await server.call("codex_apply", {
      prompt: "続きを",
      cwd: ws.gitDir,
      resume_session_id: FAKE_THREAD_ID,
    });
    assert.equal(res.result.isError, true, textOf(res.result));
    assert.match(textOf(res.result), /元 run は cwd=/);
  });

  it("同じ cwd なら resume できる", async () => {
    await server.call("codex_consult", { prompt: "最初", cwd: ws.plainDir });
    const res = await server.call("codex_consult", {
      prompt: "続きを",
      cwd: ws.plainDir,
      resume_session_id: FAKE_THREAD_ID,
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
  });
});

describe("既定の上書き", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("defaults");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("環境変数で既定を変えられる", async () => {
    const server = startServer(
      ws.env({ CODEX_MCP_CONSULT_MODEL: "gpt-5.5", CODEX_MCP_CONSULT_EFFORT: "medium" }),
    );
    try {
      await server.call("codex_consult", { prompt: "x", cwd: ws.plainDir });
      const argv = argvOf(ws.argvFile);
      assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.5");
      assert.ok(argv.includes('model_reasoning_effort="medium"'), argv.join(" "));
    } finally {
      server.close();
    }
  });

  it("空文字で既定を外し config.toml に委ねられる", async () => {
    const server = startServer(ws.env({ CODEX_MCP_APPLY_MODEL: "", CODEX_MCP_APPLY_EFFORT: "" }));
    try {
      const res = await server.call("codex_apply", { prompt: "x", cwd: ws.gitDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      const argv = argvOf(ws.argvFile);
      assert.ok(!argv.includes("-m"), argv.join(" "));
      assert.ok(!argv.some((a) => a.startsWith("model_reasoning_effort")), argv.join(" "));
      assert.match(textOf(res.result), /model=\(config 既定\) effort=\(config 既定\)/);
    } finally {
      server.close();
    }
  });

  it("既定 effort がモデル非対応なら押し付けない", async () => {
    const server = startServer(
      ws.env({ CODEX_MCP_CONSULT_MODEL: "gpt-5.5", CODEX_MCP_CONSULT_EFFORT: "ultra" }),
    );
    try {
      const res = await server.call("codex_consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      const argv = argvOf(ws.argvFile);
      assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.5");
      assert.ok(!argv.some((a) => a.startsWith("model_reasoning_effort")), argv.join(" "));
    } finally {
      server.close();
    }
  });

  it("不正な既定 effort は警告して無視する", async () => {
    const server = startServer(ws.env({ CODEX_MCP_CONSULT_EFFORT: "bogus" }));
    try {
      const res = await server.call("codex_consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      const argv = argvOf(ws.argvFile);
      assert.ok(!argv.some((a) => a.startsWith("model_reasoning_effort")), argv.join(" "));
      assert.match(server.stderr, /既定 reasoning_effort が不正/);
    } finally {
      server.close();
    }
  });
});

describe("codex_verify（検証モード）", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("verify");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("対象を書けなくする設定を付け、作業ディレクトリは run 配下にする", async () => {
    const res = await server.call("codex_verify", {
      prompt: "テストを流して",
      target_dir: ws.gitDir,
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);

    // workspace-write のままだと /tmp と $TMPDIR が書けてしまう（実 codex で確認済み）
    assert.ok(argv.includes("sandbox_workspace_write.exclude_slash_tmp=true"), argv.join(" "));
    assert.ok(argv.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"), argv.join(" "));
    assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");

    // -C と実際の cwd は run 配下の使い捨てディレクトリ（対象ディレクトリではない）
    const passedCwd = argv[argv.indexOf("-C") + 1];
    assert.match(passedCwd, /\/runs\/\d{8}-\d{6}-\d{3}-[a-z0-9]{4}\/workspace$/, passedCwd);
    assert.equal(read(ws.pwdFile, "utf8").trim(), passedCwd);
    assert.ok(!passedCwd.startsWith(ws.gitDir), "対象ディレクトリを作業場所にしている");

    // 応答は「対象は読み取り専用」であることを示す
    assert.match(textOf(res.result), new RegExp(`target=${ws.gitDir}（読み取り専用）`));
  });

  it("キャッシュは run をまたいで共有し、一時領域は run ごとに分ける", async () => {
    const readEnv = () =>
      Object.fromEntries(
        read(ws.envFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );

    await server.call("codex_verify", { prompt: "x", target_dir: ws.gitDir });
    const argv = argvOf(ws.argvFile);
    const workspace = argv[argv.indexOf("-C") + 1];
    const env = readEnv();
    const sharedCache = join(ws.runsDir, ".cache");

    // run ごとに cache を作り直すと毎回ダウンロードが走り、1 run 数百 MB まで膨らむ
    assert.ok(env.UV_CACHE_DIR?.startsWith(sharedCache), env.UV_CACHE_DIR);
    assert.ok(env.XDG_CACHE_HOME?.startsWith(sharedCache), env.XDG_CACHE_HOME);
    assert.ok(!env.UV_CACHE_DIR?.startsWith(workspace), "cache が run ごとになっている");
    // 一時領域は run ごとに分ける（成果物と混ざらないように）
    assert.ok(env.TMPDIR?.startsWith(workspace), env.TMPDIR);
    // 共有 cache は cwd の外なので、書き込み許可を明示しないと使えない
    const rootsArg = argv.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
    assert.ok(rootsArg, argv.join(" "));
    assert.ok(rootsArg.includes(sharedCache), rootsArg);

    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.match(env.PYTEST_ADDOPTS ?? "", /no:cacheprovider/);

    // 2 本目も同じ cache を指す（共有されている）
    await server.call("codex_verify", { prompt: "y", target_dir: ws.gitDir });
    assert.equal(readEnv().UV_CACHE_DIR, env.UV_CACHE_DIR);
  });

  it("実行環境の説明を prompt に添える", async () => {
    await server.call("codex_verify", { prompt: "テストして", target_dir: ws.gitDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^テストして/);
    assert.match(sent, /検証対象（読み取り専用）/);
    assert.match(sent, new RegExp(ws.gitDir));
    assert.match(sent, /検証対象には書き込めません/);
  });

  it("target_dir は必須で、cwd は受け付けない", async () => {
    const missing = await server.call("codex_verify", { prompt: "x" });
    assert.equal(missing.result.isError, true);
    assert.match(textOf(missing.result), /target_dir は必須/);

    const withCwd = await server.call("codex_verify", {
      prompt: "x",
      target_dir: ws.gitDir,
      cwd: ws.gitDir,
    });
    assert.equal(withCwd.result.isError, true);
    assert.match(textOf(withCwd.result), /未知の引数です: cwd/);
  });

  it("git 管理外でも検証できる（読むだけなので）", async () => {
    const res = await server.call("codex_verify", { prompt: "x", target_dir: ws.plainDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
  });
});

describe("codex_verify のプロジェクト規則", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("projectdoc");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("対象の AGENTS.md を作業ディレクトリへ持ち込む", async () => {
    // codex は cwd から project doc を探す。verify は cwd が使い捨ての workspace なので、
    // 持ち込まないと対象プロジェクトの規則（「pytest は uv run で」等）が届かない。
    writeFileSync(join(ws.gitDir, "AGENTS.md"), "# 規則\nテストは `uv run pytest` で実行する。\n");

    const res = await server.call("codex_verify", { prompt: "テストして", target_dir: ws.gitDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));

    const runId = runIdOf(textOf(res.result));
    const copied = join(ws.runsDir, runId, "workspace", "AGENTS.md");
    assert.ok(existsSync(copied), "AGENTS.md が持ち込まれていない");
    assert.match(read(copied, "utf8"), /uv run pytest/);

    const meta = JSON.parse(read(join(ws.runsDir, runId, "meta.json"), "utf8"));
    assert.equal(meta.project_doc, join(ws.gitDir, "AGENTS.md"));
  });

  it("対象に AGENTS.md が無ければ何もしない", async () => {
    const res = await server.call("codex_verify", { prompt: "x", target_dir: ws.plainDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const runId = runIdOf(textOf(res.result));
    assert.ok(!existsSync(join(ws.runsDir, runId, "workspace", "AGENTS.md")));
    const meta = JSON.parse(read(join(ws.runsDir, runId, "meta.json"), "utf8"));
    assert.equal(meta.project_doc, null);
  });
});
