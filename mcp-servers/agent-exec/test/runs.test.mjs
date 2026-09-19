// run の永続化・切り離し（detach）・status / result / runs のテスト。実 codex は呼ばない。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { FAKE_THREAD_ID, makeWorkspace, runIdOf, startServer, textOf } from "./helpers.mjs";

describe("run の記録", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("runs");
    // apply のときに実際に作業したことにする（git 差分の確認用）
    server = startServer(ws.env({ CODEX_FAKE_TOUCH: "seed.txt" }));
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("完了時に run_id と session_id を返し、記録を残す", async () => {
    const res = await server.call("consult", { prompt: "調べて", cwd: ws.plainDir });
    const text = textOf(res.result);
    assert.equal(res.result.isError, undefined, text);
    const runId = runIdOf(text);
    assert.ok(runId, text);
    assert.match(text, new RegExp(`session_id=${FAKE_THREAD_ID}`));
    assert.match(text, /FAKE_ANSWER/);

    const dir = join(ws.runsDir, runId);
    assert.ok(existsSync(join(dir, "meta.json")));
    assert.ok(existsSync(join(dir, "events.jsonl")));
    assert.ok(existsSync(join(dir, "prompt.txt")));
    assert.equal(readFileSync(join(dir, "last-message.txt"), "utf8"), "FAKE_ANSWER");

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    assert.equal(meta.state, "completed");
    assert.equal(meta.tool, "consult");
    assert.equal(meta.thread_id, FAKE_THREAD_ID);
    assert.equal(meta.sandbox, "read-only");
    assert.deepEqual(meta.item_counts, { command_execution: 1, agent_message: 1 });
  });

  it("usage を応答に載せる", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
    assert.match(textOf(res.result), /tokens: in=100 out=20/);
  });

  it("apply は変更ファイルと diff --stat を返す", async () => {
    const res = await server.call(
      "apply",
      { prompt: "直して", cwd: ws.gitDir },
      {},
      30_000,
    );
    const text = textOf(res.result);
    assert.equal(res.result.isError, undefined, text);
    assert.match(text, /終了時点の git 状態 \(1\)/);
    assert.match(text, /seed\.txt/);
    assert.match(text, /1 file changed|seed\.txt \|/);
  });

  it("runs が新しい順に一覧する", async () => {
    const res = await server.call("runs", { limit: 5 });
    const text = textOf(res.result);
    assert.match(text, /最近の run（新しい順）/);
    assert.match(text, /apply/);
    assert.match(text, /state=completed/);
  });

  it("存在しない run_id は見つからないと返す", async () => {
    const res = await server.call("status", { run_id: "20200101-000000-000-aaaa" });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res.result), /run が見つかりません/);
  });
});

describe("切り離し（detach）", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("detach");
    // 1本ずつ走らせて、スロットの保持と解放も一緒に確かめる
    server = startServer(ws.env({ CODEX_FAKE_SLEEP: "4", CODEX_FAKE_TOUCH: "seed.txt" }));
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("timeout_ms を超えたら打ち切らず run_id と途中経過を返す", async () => {
    const res = await server.call("apply", {
      prompt: "長い作業",
      cwd: ws.gitDir,
      timeout_ms: 1500,
    });
    const text = textOf(res.result);
    assert.equal(res.result.isError, undefined, text);
    assert.match(text, /切り離しました/);
    assert.match(text, /codex は実行を続けています/);
    // イベントから拾った途中の報告が入る（最終メッセージはまだ書かれていない）
    assert.match(text, /PARTIAL_REPORT/);
    assert.match(text, /ここまでの報告（途中のメッセージ）/);
    assert.match(text, new RegExp(`session_id=${FAKE_THREAD_ID}`));
    assert.match(text, /command_execution=1 agent_message=1/);

    const runId = runIdOf(text);
    // 実行中は status で追える
    const status = await server.call("status", { run_id: runId });
    const statusText = textOf(status.result);
    assert.match(statusText, /state=running/);
    assert.ok(!statusText.includes("サーバ管理外"), statusText);

    // result は wait_ms で完了まで待てる
    const result = await server.call("result", { run_id: runId, wait_ms: 20_000 }, {}, 40_000);
    const resultText = textOf(result.result);
    assert.equal(result.result.isError, undefined, resultText);
    assert.match(resultText, /state=completed/);
    assert.match(resultText, /FAKE_ANSWER/);
    assert.match(resultText, /終了時点の git 状態/);
  });

  it("kill_on_timeout=true なら打ち切る", async () => {
    const res = await server.call("consult", {
      prompt: "長い作業",
      cwd: ws.plainDir,
      timeout_ms: 1500,
      kill_on_timeout: true,
    });
    const text = textOf(res.result);
    assert.equal(res.result.isError, true, text);
    assert.match(text, /打ち切りました/);
    // 打ち切っても、それまでに出ていた報告は捨てない
    assert.match(text, /PARTIAL_REPORT/);
  });

  it("完了後は result を何度でも呼べる", async () => {
    const first = await server.call(
      "consult",
      { prompt: "x", cwd: ws.plainDir, timeout_ms: 20_000 },
      {},
      40_000,
    );
    const runId = runIdOf(textOf(first.result));
    for (let i = 0; i < 2; i += 1) {
      const again = await server.call("result", { run_id: runId });
      assert.equal(again.result.isError, undefined);
      assert.match(textOf(again.result), /FAKE_ANSWER/);
    }
  });
});

describe("サーバ再起動後の復元", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("restore");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("追跡が切れた run を記録から復元する", async () => {
    const first = startServer(ws.env());
    let runId;
    try {
      const res = await first.call("consult", { prompt: "x", cwd: ws.plainDir });
      runId = runIdOf(textOf(res.result));
    } finally {
      first.close();
    }

    // サーバが落ちて meta が running のまま残った状況を作る
    const metaPath = join(ws.runsDir, runId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...meta, state: "running" }, null, 2));

    const second = startServer(ws.env());
    try {
      const status = await second.call("status", { run_id: runId });
      const statusText = textOf(status.result);
      assert.match(statusText, /このサーバの管理外。記録から復元/);
      // events.jsonl に turn.completed があるので完了と推定できる
      assert.match(statusText, /state=completed\(推定\)/);

      const result = await second.call("result", { run_id: runId });
      assert.equal(result.result.isError, undefined, textOf(result.result));
      assert.match(textOf(result.result), /FAKE_ANSWER/);
    } finally {
      second.close();
    }
  });
});

describe("同時実行", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("concurrency");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("上限を守って直列化する", async () => {
    const server = startServer(
      ws.env({ AGENT_EXEC_MAX_CONCURRENCY: "1", CODEX_FAKE_SLEEP: "1.2" }),
    );
    try {
      const startedAt = Date.now();
      const both = await Promise.all([
        server.call("consult", { prompt: "1本目", cwd: ws.plainDir }, {}, 30_000),
        server.call("consult", { prompt: "2本目", cwd: ws.plainDir }, {}, 30_000),
      ]);
      const elapsed = Date.now() - startedAt;
      for (const res of both) assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.ok(elapsed >= 2_400, `並列に走ってしまった: ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  it("切り離した run もスロットを保持し、空かなければ待たせる", async () => {
    const server = startServer(
      ws.env({ AGENT_EXEC_MAX_CONCURRENCY: "1", CODEX_FAKE_SLEEP: "8" }),
    );
    try {
      // 1本目を切り離す（codex はまだ走っている）
      const first = await server.call("consult", {
        prompt: "長い",
        cwd: ws.plainDir,
        timeout_ms: 1200,
      });
      assert.match(textOf(first.result), /切り離しました/);

      // 2本目はスロットが空かないので待たされ、timeout_ms で諦める
      const second = await server.call("consult", {
        prompt: "次",
        cwd: ws.plainDir,
        timeout_ms: 1500,
      });
      assert.equal(second.result.isError, true, textOf(second.result));
      assert.match(textOf(second.result), /同時実行の上限/);
    } finally {
      server.close();
    }
  });
});

describe("異常系", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("errors");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("codex が非ゼロ終了なら isError と stderr を返す", async () => {
    const server = startServer(ws.env({ CODEX_FAKE_EXIT: "3", CODEX_FAKE_STDERR: "boom" }));
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      const text = textOf(res.result);
      assert.equal(res.result.isError, true, text);
      assert.match(text, /exit=3/);
      assert.match(text, /boom/);
      // 失敗しても、書かれていた報告は添える
      assert.match(text, /FAKE_ANSWER/);
    } finally {
      server.close();
    }
  });

  it("報告がまったく無ければ isError で知らせる", async () => {
    const server = startServer(ws.env({ CODEX_FAKE_NO_OUTPUT: "1", CODEX_FAKE_NO_EVENTS: "1" }));
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, true);
      assert.match(textOf(res.result), /報告を返しませんでした/);
    } finally {
      server.close();
    }
  });

  it("codex が見つからなければ起動失敗として返す", async () => {
    const server = startServer(ws.env({ CODEX_BIN: join(ws.root, "no-such-codex") }));
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(res.result.isError, true);
      assert.match(textOf(res.result), /codex の起動に失敗/);
    } finally {
      server.close();
    }
  });

  it("stdout を握った孫が残っても exit 後すぐ応答する", async () => {
    const marker = "24.681";
    const server = startServer(ws.env({ CODEX_FAKE_ORPHAN: marker }));
    try {
      const startedAt = Date.now();
      const res = await server.call("consult", {
        prompt: "x",
        cwd: ws.plainDir,
        timeout_ms: 600_000,
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.match(textOf(res.result), /FAKE_ANSWER/);
      assert.ok(elapsed < 5_000, `孫の終了を待ってしまった: ${elapsed}ms`);
    } finally {
      server.close();
      try {
        execFileSync("pkill", ["-f", `sleep ${marker}`]);
      } catch {
        /* 残っていなければそれでよい */
      }
    }
  });
});

describe("git 差分の正確さ", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("gitdiff");
    // codex は fileA だけを変える
    server = startServer(ws.env({ CODEX_FAKE_TOUCH: "fileA.txt" }));
    for (const name of ["fileA.txt", "fileB.txt"]) {
      writeFileSync(join(ws.gitDir, name), "base\n");
    }
    execFileSync("git", ["-C", ws.gitDir, "add", "."]);
    execFileSync("git", ["-C", ws.gitDir, "commit", "-q", "-m", "files"]);
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("未ステージ変更のパスを壊さず、run 前からの変更に印を付ける", async () => {
    // ユーザが run の前に fileB を編集しておく（codex は触らない）
    writeFileSync(join(ws.gitDir, "fileB.txt"), "edited by user\n");

    const res = await server.call("apply", { prompt: "直して", cwd: ws.gitDir });
    const text = textOf(res.result);
    assert.equal(res.result.isError, undefined, text);

    // porcelain の行頭は " M path"。trim すると 1 行目だけ 1 文字ずれる
    assert.match(text, /^ {2}M fileA\.txt$/m, text);
    assert.ok(!/ileA\.txt/.test(text.replace(/fileA\.txt/g, "")), "パスが壊れている");

    // run 前からの変更は隠さず出し、印で区別する（隠すと「追加編集されたのに消える」）
    assert.match(text, /^ {2}M fileB\.txt {2}← run 開始前から変更あり$/m, text);
    assert.ok(!/fileA\.txt {2}← run 開始前/.test(text), "codex の変更に誤った印が付いている");
    assert.match(text, /終了時点の git 状態 \(2\)/);
  });
});

describe("別セッションが動かしている run", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("cross");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("走っている run を「報告が無い」と断言しない", async () => {
    // サーバ A: 長い run を切り離す（codex は動き続ける）
    const serverA = startServer(ws.env({ CODEX_FAKE_SLEEP: "20", CODEX_FAKE_NO_EVENTS: "1" }));
    let runId;
    try {
      const res = await serverA.call("consult", {
        prompt: "長い",
        cwd: ws.plainDir,
        timeout_ms: 1200,
      });
      runId = runIdOf(textOf(res.result));
      assert.ok(runId, textOf(res.result));

      // サーバ B から同じ記録を見る。A は生きているので孤児回収の対象外
      const serverB = startServer(ws.env());
      try {
        const result = await serverB.call("result", { run_id: runId });
        const text = textOf(result.result);
        // ここで isError にすると、呼び出し側が「失敗した」と誤解して再実行に走る
        assert.equal(result.result.isError, undefined, text);
        assert.match(text, /まだ動いています/);

        const status = await serverB.call("status", { run_id: runId });
        assert.match(textOf(status.result), /別プロセスで継続中/);

        const runs = await serverB.call("runs", { limit: 5 });
        // runs と status で状態がちぐはぐにならないこと
        assert.match(textOf(runs.result), /別プロセスで継続中/);
      } finally {
        serverB.close();
      }
    } finally {
      serverA.close();
    }
  });

  it("前のサーバが突然死した後、起動時に孤児を回収する", async () => {
    const serverA = startServer(ws.env({ CODEX_FAKE_SLEEP: "25" }));
    let runId;
    let pid;
    try {
      const res = await serverA.call("consult", {
        prompt: "長い",
        cwd: ws.plainDir,
        timeout_ms: 1200,
      });
      runId = runIdOf(textOf(res.result));
      pid = JSON.parse(readFileSync(join(ws.runsDir, runId, "meta.json"), "utf8")).pid;
      assert.ok(pid, "pid が記録されていない");
    } finally {
      serverA.kill9(); // 後始末を走らせずに落とす
    }
    await new Promise((r) => setTimeout(r, 300));

    const serverB = startServer(ws.env());
    try {
      // 起動時の回収が終わるまで少し待つ
      await serverB.request("ping", {});
      const status = await serverB.call("status", { run_id: runId });
      assert.match(textOf(status.result), /state=killed/);
      assert.match(serverB.stderr, /前回のサーバが残した codex を回収しました/);
    } finally {
      serverB.close();
    }
  });
});

describe("イベントの頑健さ", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("weird");
    server = startServer(ws.env({ CODEX_FAKE_WEIRD: "1" }));
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("壊れた行・未知 item・巨大行があっても落ちない", async () => {
    const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir }, {}, 30_000);
    const text = textOf(res.result);
    assert.equal(res.result.isError, undefined, text);

    const runId = runIdOf(text);
    const meta = JSON.parse(readFileSync(join(ws.runsDir, runId, "meta.json"), "utf8"));
    // 未知の item type も型名だけは数える
    assert.equal(meta.item_counts.file_change, 1);
    assert.equal(meta.item_counts.agent_message, 2);

    // 巨大行は縮めて記録する（events.jsonl が無制限に膨らまない）
    const events = readFileSync(join(ws.runsDir, runId, "events.jsonl"), "utf8");
    assert.ok(events.includes("this is not json at all"), "壊れた行も生ログには残す");
    assert.ok(events.length < 1_000_000, `events.jsonl が大きすぎる: ${events.length}`);
    // 縮めた後も JSON として読めること（文字列の途中で切ると壊れる）
    for (const line of events.split("\n")) {
      if (line.trim() === "" || line.includes("this is not json")) continue;
      JSON.parse(line); // 壊れていれば例外で落ちる
    }
    // 報告本文は events とは別に残す（切り詰め・末尾読みの影響を受けない）
    const messages = readFileSync(join(ws.runsDir, runId, "messages.jsonl"), "utf8");
    assert.ok(messages.includes("PARTIAL_REPORT"), messages.slice(0, 200));

    // サーバは生きたまま次の呼び出しに応じる
    assert.deepEqual((await server.request("ping", {})).result, {});
    assert.deepEqual(server.badLines, []);
  });
});

describe("スロットの会計", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("slots");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("上限 2 で 3 本投げると、完了した順に次が入る", async () => {
    const server = startServer(
      ws.env({ AGENT_EXEC_MAX_CONCURRENCY: "2", CODEX_FAKE_SLEEP: "1.5" }),
    );
    try {
      const started = Date.now();
      const results = await Promise.all(
        ["a", "b", "c"].map((tag) =>
          server.call("consult", { prompt: tag, cwd: ws.plainDir }, {}, 40_000),
        ),
      );
      for (const res of results) assert.equal(res.result.isError, undefined, textOf(res.result));
      const elapsed = Date.now() - started;
      // 2 本並列 → 3 本目が入るので 2 巡ぶん。1 巡（1.5s）では終わらない
      assert.ok(elapsed >= 2_700, `直列化されていない: ${elapsed}ms`);
      assert.ok(elapsed < 8_000, `スロットが解放されていない: ${elapsed}ms`);

      // 会計がずれていなければ、この後も普通に実行できる
      const after = await server.call("consult", { prompt: "d", cwd: ws.plainDir }, {}, 40_000);
      assert.equal(after.result.isError, undefined, textOf(after.result));
    } finally {
      server.close();
    }
  });

  it("検証エラーでスロットを取りこぼさない", async () => {
    const server = startServer(ws.env({ AGENT_EXEC_MAX_CONCURRENCY: "1" }));
    try {
      await server.call("consult", { prompt: "", cwd: ws.plainDir }); // 検証エラー
      await server.call("consult", { prompt: "x", cwd: "/nope" }); // cwd エラー
      await server.call("apply", { prompt: "x", cwd: ws.plainDir }); // git エラー
      const ok = await server.call("consult", { prompt: "x", cwd: ws.plainDir }, {}, 20_000);
      assert.equal(ok.result.isError, undefined, textOf(ok.result));
    } finally {
      server.close();
    }
  });

  it("起動失敗が続いてもスロットを取りこぼさない", async () => {
    // 検証エラーと違い、こちらはスロットを取った後に失敗する経路を通る
    const server = startServer(
      ws.env({ AGENT_EXEC_MAX_CONCURRENCY: "1", CODEX_BIN: join(ws.root, "no-such-codex") }),
    );
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await server.call("consult", { prompt: `x${i}`, cwd: ws.plainDir });
        const text = textOf(res.result);
        assert.equal(res.result.isError, true, text);
        // スロットが枯れていれば「同時実行の上限」で止まり、起動まで到達しない
        assert.match(text, /codex の起動に失敗/, text);
      }
    } finally {
      server.close();
    }
  });

  it("codex が見つからなくても failed として扱い、打ち切り扱いにしない", async () => {
    const server = startServer(ws.env({ CODEX_BIN: join(ws.root, "no-such-codex") }));
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      const text = textOf(res.result);
      assert.equal(res.result.isError, true);
      assert.match(text, /codex の起動に失敗/);
      assert.match(text, /CODEX_BIN/);
      assert.ok(!text.includes("打ち切りました"), text);

      const runId = runIdOf(text);
      const meta = JSON.parse(readFileSync(join(ws.runsDir, runId, "meta.json"), "utf8"));
      assert.equal(meta.state, "failed");
    } finally {
      server.close();
    }
  });
});

describe("PID 再利用への耐性", () => {
  let ws;
  const decoys = [];

  // codex とは無関係な、たまたま同じ pid を持つことになったプロセスの代役
  // marker を渡すと argv に含まれるので、cmdline による身元確認を通過する
  function spawnDecoy(seconds, marker) {
    const command = marker ? `sleep ${seconds} # ${marker}` : `sleep ${seconds}`;
    const child = spawn("bash", ["-c", command], { detached: true, stdio: "ignore" });
    child.unref();
    decoys.push(child.pid);
    return child.pid;
  }

  function writeStaleRun(runId, { pid, events }) {
    const dir = join(ws.runsDir, runId);
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        run_id: runId,
        tool: "consult",
        state: "running", // 前のサーバが落ちて running のまま残った体
        started_at: new Date().toISOString(),
        cwd: ws.plainDir,
        sandbox: "read-only",
        pid,
        server_pid: 999_999, // 存在しないサーバ
        boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      }),
    );
    writeFileSync(join(dir, "events.jsonl"), events ?? "");
    return dir;
  }

  before(() => {
    ws = makeWorkspace("pidreuse");
  });
  after(() => {
    for (const pid of decoys) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* もう居ない */
        }
      }
    }
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("無関係なプロセスを孤児として殺さない", async () => {
    const victim = spawnDecoy(30);
    writeStaleRun("20260101-000000-000-aaaa", { pid: victim });

    const server = startServer(ws.env());
    try {
      await server.request("ping", {}); // 起動処理（回収）が済むまで待つ
      let alive = true;
      try {
        process.kill(victim, 0);
      } catch {
        alive = false;
      }
      assert.ok(alive, "codex と無関係なプロセスが回収で殺された");
      assert.ok(!server.stderr.includes("回収しました"), server.stderr);
    } finally {
      server.close();
    }
  });

  it("完了の証跡があるなら、pid が生きていても完了として扱う", async () => {
    const runId = "20260101-000000-000-bbbb";
    // argv に run_id を入れて「身元確認も通る生存プロセス」を作る。
    // こうしないと isRunAlive が false になり、判定順を逆にしてもテストが通ってしまう。
    const impostor = spawnDecoy(30, runId);
    writeStaleRun(runId, {
      pid: impostor,
      events:
        '{"type":"thread.started","thread_id":"01a09c85-9969-7611-97f2-0d00bf50a7f9"}\n' +
        '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"FINAL"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
    });

    const server = startServer(ws.env());
    try {
      const status = await server.call("status", { run_id: runId });
      assert.match(textOf(status.result), /state=completed\(推定\)/, textOf(status.result));

      // 「まだ動いています」で無限にポーリングさせない
      const result = await server.call("result", { run_id: runId });
      const text = textOf(result.result);
      assert.ok(!text.includes("まだ動いています"), text);
      assert.match(text, /FINAL/);

      // events から session_id も復元できる（meta に無くても）
      assert.match(textOf(status.result), /session_id=01a09c85-/);
    } finally {
      server.close();
    }
  });
});

describe("記録の保護", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("protect");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("読めない meta.json の run を prune で消さない", async () => {
    const brokenId = "20260101-000000-000-cccc";
    const dir = join(ws.runsDir, brokenId);
    execFileSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "meta.json"), "{ this is not json");

    const server = startServer(ws.env({ AGENT_EXEC_MAX_RUNS: "1" }));
    try {
      // prune は起動時と run 完了ごとに走る
      await server.call("consult", { prompt: "x", cwd: ws.plainDir }, {}, 20_000);
      assert.ok(existsSync(join(dir, "meta.json")), "壊れた meta の run が消された");
    } finally {
      server.close();
    }
  });

  it("run が prune されても session 索引で resume できる", async () => {
    const SESSION_A = "01a0aaaa-0000-7000-8000-000000000001";
    const SESSION_B = "01a0bbbb-0000-7000-8000-000000000002";
    // 保持 1 件・猶予と遅延をほぼ 0 にして、確実に prune させる
    const base = {
      AGENT_EXEC_MAX_RUNS: "1",
      AGENT_EXEC_PRUNE_GRACE_MS: "1",
      AGENT_EXEC_PRUNE_DELAY_MS: "1",
    };

    // セッション A を作る
    const serverA = startServer(ws.env({ ...base, CODEX_FAKE_THREAD_ID: SESSION_A }));
    let runA;
    try {
      const res = await serverA.call("consult", { prompt: "最初", cwd: ws.plainDir }, {}, 20_000);
      runA = runIdOf(textOf(res.result));
      assert.ok(runA, textOf(res.result));
    } finally {
      serverA.close();
    }

    // 別セッション B の run で保持枠を埋め、A の run 本体を押し出す
    const serverB = startServer(ws.env({ ...base, CODEX_FAKE_THREAD_ID: SESSION_B }));
    try {
      for (const prompt of ["次", "その次"]) {
        await serverB.call("consult", { prompt, cwd: ws.plainDir }, {}, 20_000);
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.ok(!existsSync(join(ws.runsDir, runA)), `A の run 本体が残っている: ${runA}`);

      // run 本体が消えていても、索引が残っていれば resume できる
      const indexed = JSON.parse(
        readFileSync(join(ws.runsDir, "sessions", `${SESSION_A}.json`), "utf8"),
      );
      assert.equal(indexed.run_id, runA);
      const res = await serverB.call(
        "consult",
        { prompt: "続き", cwd: ws.plainDir, resume_session_id: SESSION_A },
        {},
        20_000,
      );
      assert.equal(res.result.isError, undefined, textOf(res.result));
    } finally {
      serverB.close();
    }
  });

  it("tool をまたぐ継続は拒否せず、sandbox が変わることを明示する", async () => {
    const server = startServer(ws.env());
    try {
      await server.call("consult", { prompt: "調査", cwd: ws.gitDir }, {}, 20_000);
      const res = await server.call(
        "apply",
        { prompt: "直して", cwd: ws.gitDir, resume_session_id: FAKE_THREAD_ID },
        {},
        20_000,
      );
      assert.equal(res.result.isError, undefined, textOf(res.result));
      assert.match(
        textOf(res.result),
        /consult のセッションを apply = workspace-write で継続します/,
      );
    } finally {
      server.close();
    }
  });
});

describe("保持上限と記録の生存", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("retention");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("保持上限が小さくても、待機中と完了直後の記録を消さない", async () => {
    // 保持 1 件・同時実行 1 件で 3 本投げる。prune が待機中の run や
    // 応答を組み立て中の run を消すと、報告が失われる。
    const server = startServer(
      ws.env({
        AGENT_EXEC_MAX_RUNS: "1",
        AGENT_EXEC_MAX_CONCURRENCY: "1",
        CODEX_FAKE_SLEEP: "0.5",
      }),
    );
    try {
      const results = await Promise.all(
        ["1本目", "2本目", "3本目"].map((tag) =>
          server.call("consult", { prompt: tag, cwd: ws.plainDir }, {}, 40_000),
        ),
      );
      for (const res of results) {
        const text = textOf(res.result);
        assert.equal(res.result.isError, undefined, text);
        assert.match(text, /FAKE_ANSWER/, text);
      }
    } finally {
      server.close();
    }
  });

  it("巨大な報告でも last-message が無ければ復元できる", async () => {
    const server = startServer(
      ws.env({ CODEX_FAKE_WEIRD: "1", CODEX_FAKE_NO_OUTPUT: "1" }),
    );
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir }, {}, 40_000);
      const runId = runIdOf(textOf(res.result));
      // events.jsonl では 300KB の行が縮められるが、報告は messages.jsonl に残る
      const result = await server.call("result", { run_id: runId });
      const text = textOf(result.result);
      assert.match(text, /AAAA/, text.slice(0, 400));
      assert.match(text, /途中のメッセージ/);
    } finally {
      server.close();
    }
  });

  it("失敗した run は後から取っても isError になる", async () => {
    const server = startServer(ws.env({ CODEX_FAKE_EXIT: "3", CODEX_FAKE_STDERR: "boom" }));
    try {
      const first = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      assert.equal(first.result.isError, true);
      const runId = runIdOf(textOf(first.result));

      // 同期応答と、後から取る結果で成否判定が食い違わないこと
      const later = await server.call("result", { run_id: runId });
      assert.equal(later.result.isError, true, textOf(later.result));
      assert.match(textOf(later.result), /failed で終わっています（exit=3/);
      assert.match(textOf(later.result), /boom/);
    } finally {
      server.close();
    }
  });
});

describe("同じ repo での並行 apply", () => {
  let ws;
  let server;

  before(() => {
    ws = makeWorkspace("repolock");
    server = startServer(ws.env({ CODEX_FAKE_SLEEP: "3", AGENT_EXEC_MAX_CONCURRENCY: "3" }));
  });
  after(() => {
    server.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it("同じリポジトリでは 1 本に制限する", async () => {
    // 1本目を切り離して、走らせたままにする
    const first = await server.call("apply", {
      prompt: "長い作業",
      cwd: ws.gitDir,
      timeout_ms: 1200,
    });
    assert.match(textOf(first.result), /切り離しました/);
    const runId = runIdOf(textOf(first.result));

    // 同じ repo への 2 本目は弾く（差分がどちらのものか分からなくなるため）
    const second = await server.call("apply", { prompt: "別の作業", cwd: ws.gitDir });
    assert.equal(second.result.isError, true, textOf(second.result));
    assert.match(textOf(second.result), /同じリポジトリで apply が実行中/);
    assert.match(textOf(second.result), new RegExp(runId));

    // 読むだけの consult は並行して使える
    const consult = await server.call(
      "consult",
      { prompt: "調べて", cwd: ws.gitDir, timeout_ms: 20_000 },
      {},
      40_000,
    );
    assert.equal(consult.result.isError, undefined, textOf(consult.result));

    // 1本目が終われば、次の apply は通る
    await server.call("result", { run_id: runId, wait_ms: 20_000 }, {}, 40_000);
    const third = await server.call("apply", { prompt: "次の作業", cwd: ws.gitDir }, {}, 40_000);
    assert.equal(third.result.isError, undefined, textOf(third.result));
  });
});

describe("codex 側のエラー", () => {
  let ws;

  before(() => {
    ws = makeWorkspace("apierror");
  });
  after(() => rmSync(ws.root, { recursive: true, force: true }));

  it("モデルが使えない等の中断理由をそのまま見せる", async () => {
    // 実運用で起きた例: 使っていたモデルが提供終了し、400 で弾かれた
    const message = "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.";
    const server = startServer(
      ws.env({ CODEX_FAKE_TURN_FAILED: message, CODEX_FAKE_NO_OUTPUT: "1" }),
    );
    try {
      const res = await server.call("consult", { prompt: "x", cwd: ws.plainDir });
      const text = textOf(res.result);
      assert.equal(res.result.isError, true, text);
      // 「報告を返しませんでした」では原因が分からない
      assert.match(text, /codex が実行を中断しました/);
      assert.match(text, /not supported when using Codex with a ChatGPT account/);
      assert.ok(!text.includes("報告を返しませんでした"), text);

      const runId = runIdOf(text);
      const meta = JSON.parse(readFileSync(join(ws.runsDir, runId, "meta.json"), "utf8"));
      assert.match(meta.failure, /not supported/);
    } finally {
      server.close();
    }
  });
});
