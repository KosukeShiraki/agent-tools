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
    assert.equal(res.result.serverInfo.name, "agent-exec");
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
      "apply",
      "config",
      "consult",
      "result",
      "runs",
      "status",
    ]);

    const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(byName.consult.required, ["prompt"]);
    assert.deepEqual(byName.apply.required.sort(), ["cwd", "prompt"]);
    assert.deepEqual(byName.status.required, ["run_id"]);
    assert.deepEqual(byName.result.required, ["run_id"]);
    assert.deepEqual(byName.runs.required, []);

    for (const name of ["consult", "apply"]) {
      const props = byName[name].properties;
      assert.ok(props.resume_session_id, `${name} に resume_session_id がない`);
      assert.ok(props.kill_on_timeout, `${name} に kill_on_timeout がない`);
    }
    assert.deepEqual(byName.apply.properties.scope.enum, ["strict", "open"]);
    assert.equal(byName.consult.properties.scope, undefined);
  });

  // モデルと effort は利用者（環境変数）だけが決める。schema に載せると呼び出し側の
  // LLM が指定できてしまい、実運用では既定が毎回上書きされていた。
  it("model と reasoning_effort は schema に無い", async () => {
    const res = await server.request("tools/list", {});
    const byName = Object.fromEntries(
      res.result.tools.map((t) => [t.name, t.inputSchema.properties]),
    );
    for (const name of ["consult", "apply"]) {
      assert.equal(byName[name].model, undefined, `${name} に model が残っている`);
      assert.equal(
        byName[name].reasoning_effort,
        undefined,
        `${name} に reasoning_effort が残っている`,
      );
    }
  });

  it("tools/list の説明が固定されたモデルを示す", async () => {
    const res = await server.request("tools/list", {});
    const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t.description]));
    assert.match(byName.consult, /モデルは gpt-6-astra .*effort=xhigh.*固定/);
    assert.match(byName.apply, /モデルは gpt-5\.6-luna .*effort=max.*固定/);
    assert.match(byName.consult, /変えるなら config/);
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
    const res = await server.call("consult", { prompt: "   ", cwd: ws.plainDir });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /prompt は空でない文字列/);
  });

  it("相対パスの cwd を弾く", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: "relative/path" });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /絶対パス/);
  });

  it("存在しない cwd を弾く", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: join(ws.root, "nope") });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /存在しません/);
  });

  it("未知の引数キーを弾く（typo の握り潰しを防ぐ）", async () => {
    const res = await server.call("consult", {
      prompt: "x",
      cwd: ws.plainDir,
      reasoning_Effort: "high",
      bogus: 1,
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知の引数です: reasoning_Effort, bogus/);
  });

  it("consult に scope は渡せない", async () => {
    const res = await server.call("consult", {
      prompt: "x",
      cwd: ws.plainDir,
      scope: "strict",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知の引数です: scope/);
  });

  // 握り潰さず弾くのが肝。黙って無視すると、呼び出し側は指定が効いたと思い込む。
  it("model は呼び出し側から渡せない", async () => {
    const res = await server.call("consult", {
      prompt: "x",
      cwd: ws.plainDir,
      model: "gpt-5.5",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知の引数です: model/);
  });

  it("reasoning_effort は呼び出し側から渡せない", async () => {
    const res = await server.call("consult", {
      prompt: "x",
      cwd: ws.plainDir,
      reasoning_effort: "low",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /未知の引数です: reasoning_effort/);
  });

  it("resume_session_id は UUID 形式のみ受け付ける", async () => {
    const res = await server.call("consult", {
      prompt: "x",
      cwd: ws.plainDir,
      resume_session_id: "not-a-uuid",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /UUID 形式/);
  });

  it("kill_on_timeout は真偽値のみ", async () => {
    const res = await server.call("consult", {
      prompt: "x",
      cwd: ws.plainDir,
      kill_on_timeout: "yes",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /true \/ false/);
  });

  it("scope は strict / open のみ", async () => {
    const res = await server.call("apply", {
      prompt: "x",
      cwd: ws.gitDir,
      scope: "loose",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /scope は/);
  });

  it("run_id の形式を検証する（path traversal の防止）", async () => {
    for (const runId of ["../etc", "nope", "20260101-000000-aaaa", "20260101-000000-000-TOOLONG"]) {
      const res = await server.call("status", { run_id: runId });
      assert.equal(res.result.isError, true, runId);
      assert.match(textOf(res.result), /run_id の形式が不正/);
    }
  });

  it("cwd の symlink と .. を実体パスへ正規化する", async () => {
    const realDir = join(ws.root, "real-target");
    const linkDir = join(ws.root, "link-to-real");
    execFileSync("mkdir", ["-p", realDir]);
    execFileSync("ln", ["-sfn", realDir, linkDir]);

    await server.call("consult", { prompt: "x", cwd: linkDir });
    const viaLink = argvOf(ws.argvFile);
    assert.equal(viaLink[viaLink.indexOf("-C") + 1], realDir);

    await server.call("consult", { prompt: "x", cwd: join(realDir, "..", "real-target") });
    const viaDotDot = argvOf(ws.argvFile);
    assert.equal(viaDotDot[viaDotDot.indexOf("-C") + 1], realDir);
  });

  it("git 外への symlink は apply で弾く（実体で判定する）", async () => {
    const outside = join(ws.root, "outside-repo");
    const linkInRepo = join(ws.gitDir, "link-to-outside");
    execFileSync("mkdir", ["-p", outside]);
    execFileSync("ln", ["-sfn", outside, linkInRepo]);
    const res = await server.call("apply", { prompt: "x", cwd: linkInRepo });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /git 管理下にありません/);
  });

  it("空の .git ディレクトリは git リポジトリとみなさない", async () => {
    const fakeRepo = join(ws.root, "fake-repo");
    execFileSync("mkdir", ["-p", join(fakeRepo, ".git")]);
    const res = await server.call("apply", { prompt: "x", cwd: fakeRepo });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /git 管理下にありません/);
  });

  it("apply は cwd 必須", async () => {
    const res = await server.call("apply", { prompt: "x" });
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

  it("consult は read-only で --json を使う", async () => {
    const res = await server.call("consult", { prompt: "調べて", cwd: ws.plainDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[0], "exec");
    assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
    assert.equal(argv[argv.indexOf("-C") + 1], ws.plainDir);
    assert.ok(argv.includes("--json"), argv.join(" "));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.match(read(ws.stdinFile, "utf8"), /^調べて/);
  });

  it("apply は workspace-write で git チェックを外さない", async () => {
    const res = await server.call("apply", { prompt: "直して", cwd: ws.gitDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
    assert.ok(!argv.includes("--skip-git-repo-check"));
  });

  it("既定は consult=astra/xhigh, apply=luna/max", async () => {
    await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    const consultArgv = argvOf(ws.argvFile);
    assert.equal(consultArgv[consultArgv.indexOf("-m") + 1], "gpt-6-astra");
    assert.ok(consultArgv.includes('model_reasoning_effort="xhigh"'), consultArgv.join(" "));

    // コードを書かせるのは apply。ここだけ別のモデルを既定にしている
    await server.call("apply", { prompt: "x", cwd: ws.gitDir });
    const applyArgv = argvOf(ws.argvFile);
    assert.equal(applyArgv[applyArgv.indexOf("-m") + 1], "gpt-5.6-luna");
    assert.ok(applyArgv.includes('model_reasoning_effort="max"'), applyArgv.join(" "));
  });

  it("resume 時は resume サブコマンドと sandbox_mode の override を使う", async () => {
    // resume 先は自分の記録にある session_id に限るので、まず1本走らせて登録する
    await server.call("consult", { prompt: "最初", cwd: ws.plainDir });

    const res = await server.call("consult", {
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
    // -C が無いぶん、作業ディレクトリは spawn の cwd だけが決める（実 codex で確認済み）。
    assert.equal(read(ws.pwdFile, "utf8").trim(), ws.plainDir);
    assert.match(read(ws.stdinFile, "utf8"), /^続きを/);
    assert.match(textOf(res.result), new RegExp(`${FAKE_THREAD_ID} から継続`));
  });

  it("記録に無い session_id は resume できない", async () => {
    const res = await server.call("consult", {
      prompt: "続きを",
      cwd: ws.plainDir,
      resume_session_id: "01a09999-0000-7000-8000-000000000000",
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /このサーバの記録に見つかりません/);
  });

  it("apply は既定で範囲逸脱を抑える指示を添える", async () => {
    await server.call("apply", { prompt: "抽出だけして", cwd: ws.gitDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^抽出だけして/);
    assert.match(sent, /指示された範囲のみを変更してください/);
    assert.match(sent, /範囲外の気づき/);
  });

  it("scope=open なら範囲の指示を添えない", async () => {
    await server.call("apply", { prompt: "自由にやって", cwd: ws.gitDir, scope: "open" });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^自由にやって/);
    assert.ok(!sent.includes("指示された範囲のみを変更"), sent);
  });

  // 検証専用ツールを廃したので、テストを走らせるのは実装者の仕事になった。
  // 実行したコマンドを申告させることで、呼び出し側が同じコマンドで裏取りできる。
  it("apply はテストの実行と申告を求める", async () => {
    await server.call("apply", { prompt: "直して", cwd: ws.gitDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /テストを実行し/);
    assert.match(sent, /実行したコマンドと結果/);
    assert.match(sent, /実行しなかった場合/);
  });

  it("scope=open でもテストの指示は残る", async () => {
    await server.call("apply", { prompt: "x", cwd: ws.gitDir, scope: "open" });
    assert.match(read(ws.stdinFile, "utf8"), /テストを実行し/);
  });

  it("consult にはテストの指示を添えない", async () => {
    // read-only ではテストが走らない（キャッシュが書けない）ので、求めても無意味
    await server.call("consult", { prompt: "調べて", cwd: ws.plainDir });
    assert.ok(!read(ws.stdinFile, "utf8").includes("テストを実行し"));
  });

  it("consult には範囲の指示を添えないが、委譲は既定で止める", async () => {
    await server.call("consult", { prompt: "調べて", cwd: ws.plainDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /^調べて/);
    assert.ok(!sent.includes("指示された範囲のみを変更"), sent); // scope は apply だけ
    assert.match(sent, /サブエージェントへの委譲/);
  });

  it("apply は既定で「自分で進めて」と頼む（委譲による二重レビューを避ける）", async () => {
    await server.call("apply", { prompt: "直して", cwd: ws.gitDir });
    const sent = read(ws.stdinFile, "utf8");
    assert.match(sent, /サブエージェントへの委譲/);
    assert.match(sent, /独立レビューの/);
    // プロジェクト規則側が委譲を指示している場合があるので、競合を明示して解く
    assert.match(sent, /プロジェクト規則（AGENTS\.md 等）にサブエージェントの利用/);
    assert.match(sent, /呼び出し側が担う役割です/);
  });

  it("delegate: true なら委譲の指示を添えない", async () => {
    await server.call("apply", { prompt: "直して", cwd: ws.gitDir, delegate: true });
    const sent = read(ws.stdinFile, "utf8");
    assert.ok(!sent.includes("サブエージェントへの委譲"), sent);
    assert.match(sent, /指示された範囲のみを変更/); // scope の指示は既定どおり残る
  });

  it("consult も delegate: true で委譲を許せる", async () => {
    await server.call("consult", { prompt: "調べて", cwd: ws.plainDir, delegate: true });
    assert.equal(read(ws.stdinFile, "utf8"), "調べて");
  });

  it("delegate は真偽値のみ", async () => {
    const res = await server.call("apply", {
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
    await server.call("consult", { prompt: "最初", cwd: ws.plainDir });
    // 別ディレクトリから同じ session_id を再開しようとする
    const res = await server.call("apply", {
      prompt: "続きを",
      cwd: ws.gitDir,
      resume_session_id: FAKE_THREAD_ID,
    });
    assert.equal(res.result.isError, true, textOf(res.result));
    assert.match(textOf(res.result), /元 run は cwd=/);
  });

  it("同じ cwd なら resume できる", async () => {
    await server.call("consult", { prompt: "最初", cwd: ws.plainDir });
    const res = await server.call("consult", {
      prompt: "続きを",
      cwd: ws.plainDir,
      resume_session_id: FAKE_THREAD_ID,
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
  });
});

describe("config tool", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("config");
    server = startServer(ws.env());
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("引数なしなら現在の設定と、その値の出どころを返す", async () => {
    const text = textOf((await server.call("config", {})).result);
    assert.match(text, /consult: model=gpt-6-astra（コード既定）/);
    assert.match(text, /apply: model=gpt-5\.6-luna（コード既定/);
    assert.match(text, /設定ファイル: /, "どこを見れば分かるかも返す");
    assert.match(text, /選べる effort: /);
  });

  // 設定を run ごとに解決しているからこそ、同じサーバのまま次の run に効く。
  // 起動時に焼いていた頃は、変更のたびに Claude Code の再起動が要った。
  it("変更が同じサーバの次の run から効く（再起動が要らない）", async () => {
    const res = await server.call("config", {
      consult: { model: "gpt-5.5", effort: "medium" },
    });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    assert.match(textOf(res.result), /consult: model=gpt-5\.5（config \/ コード既定は gpt-6-astra）/);

    await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    const argv = argvOf(ws.argvFile);
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.5");
    assert.ok(argv.includes('model_reasoning_effort="medium"'), argv.join(" "));
  });

  it("モデル名を変えると起動する CLI も変わる", async () => {
    await server.call("config", { apply: { model: "sonnet", effort: "xhigh" } });
    await server.call("apply", { prompt: "x", cwd: ws.gitDir });
    const argv = argvOf(ws.argvFile);
    assert.ok(argv.includes("-p"), `claude で起動していない: ${argv.join(" ")}`);
    assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  });

  it("tools/list の説明にも今の設定が出る", async () => {
    const res = await server.request("tools/list", {});
    const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t.description]));
    assert.match(byName.apply, /モデルは sonnet/);
  });

  it("null でコード既定に戻る", async () => {
    await server.call("config", { consult: { model: null, effort: null } });
    const text = textOf((await server.call("config", {})).result);
    assert.match(text, /consult: model=gpt-6-astra（コード既定/);
  });

  it("空文字なら CLI 側の設定に委ねる", async () => {
    await server.call("config", { apply: { model: "", effort: "" } });
    const res = await server.call("apply", { prompt: "x", cwd: ws.gitDir });
    assert.equal(res.result.isError, undefined, textOf(res.result));
    const argv = argvOf(ws.argvFile);
    assert.ok(!argv.includes("-m"), argv.join(" "));
    assert.ok(!argv.some((a) => a.startsWith("model_reasoning_effort")), argv.join(" "));
    assert.match(textOf(res.result), /model=\(config 既定\)/);
    await server.call("config", { apply: { model: null, effort: null } });
  });

  // run では使えない値を捨てて走らせる（止めるより走らせたほうがよい）が、設定は
  // 意図してやる操作なので、黙って別の値になるほうが困る。断って対応値を返す。
  it("モデルが対応しない effort は拒否し、対応値を添える", async () => {
    const res = await server.call("config", { consult: { model: "gpt-5.5", effort: "ultra" } });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /対応していません/);
    assert.match(textOf(res.result), /low, medium, high, xhigh/);
    assert.match(textOf(res.result), /設定は変更していません/);
    const after = textOf((await server.call("config", {})).result);
    assert.match(after, /consult: model=gpt-6-astra/, "拒否したのに書き換わっている");
  });

  it("未知のキー・型・tool を弾く", async () => {
    const badKey = await server.call("config", { consult: { models: "opus" } });
    assert.equal(badKey.result.isError, true);
    assert.match(textOf(badKey.result), /未知のキー/);

    const badType = await server.call("config", { consult: { model: 3 } });
    assert.equal(badType.result.isError, true);
    assert.match(textOf(badType.result), /文字列か null/);

    const badTool = await server.call("config", { status: { model: "opus" } });
    assert.equal(badTool.result.isError, true);
    assert.match(textOf(badTool.result), /未知の引数/);
  });
});

describe("手で書かれた設定の扱い", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("config-manual");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  // config tool は不正値を弾くが、ファイルは手でも編集できる。その場合は run を
  // 止めずに値を捨て、**捨てたことを run の応答にも出す**（stderr だけだと、
  // 「設定したのに効いていない」に気づけない）。
  it("使えない effort は捨てて走り、応答と stderr の両方に出る", async () => {
    ws.writeConfig({ consult: { model: "gpt-5.5", effort: "ultra" } });
    const server = startServer(ws.env());
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      const argv = argvOf(ws.argvFile);
      assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.5");
      assert.ok(!argv.some((a) => a.startsWith("model_reasoning_effort")), argv.join(" "));
      assert.match(textOf(res.result), /⚠ 設定: .*effort=ultra/);
      assert.match(server.stderr, /effort=ultra/);
    } finally {
      server.close();
    }
  });

  it("壊れた JSON でも起動し、コード既定で走る", async () => {
    writeFileSync(ws.configFile, "{ これは JSON ではない");
    const server = startServer(ws.env());
    try {
      await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      const argv = argvOf(ws.argvFile);
      assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6-astra");
      assert.match(server.stderr, /読めないためコード既定/);
    } finally {
      server.close();
    }
  });
});

// 5.0.0 で CODEX_MCP_* を AGENT_EXEC_* に改名した。モデル/effort の環境変数は 7.0.0 で
// 廃したが、記録先などの運用系は残っている。旧名も読んで警告を出す仕組みを固定する。
describe("旧名の環境変数", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("legacyenv");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("CODEX_MCP_RUNS_DIR も読み、警告を出す", async () => {
    const env = ws.env({ CODEX_MCP_RUNS_DIR: ws.runsDir });
    delete env.AGENT_EXEC_RUNS_DIR;
    const server = startServer(env);
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.match(server.stderr, /CODEX_MCP_RUNS_DIR は AGENT_EXEC_RUNS_DIR に改名/);
    } finally {
      server.close();
    }
  });
});
