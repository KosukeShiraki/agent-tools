// モデル名 → アダプタの解決と、各アダプタの argv 組み立て・イベント解釈。
//
// すべて純関数なので spawn しない。**このファイルだけは Windows でも走る**
// （他のテストはダミー CLI が shebang 付き .sh なので WSL / Linux / macOS が要る）。
// 運用環境が Windows なので、ここに寄せられる検証は寄せる価値がある。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import claudeBackend from "../lib/backends/claude.mjs";
import codexBackend from "../lib/backends/codex.mjs";
import { adapterById, resolveAdapter } from "../lib/backends/index.mjs";
import { currentProcessStartTime, markerVerdict, processStartTime } from "../lib/platform.mjs";
import { resolveSettings, validatePatch } from "../lib/settings.mjs";

describe("モデル名からアダプタを決める", () => {
  it("claude 系の名前は claude へ", () => {
    for (const model of [
      "opus",
      "sonnet",
      "haiku",
      "fable",
      "opus-4.5",
      "sonnet[1m]",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "us.anthropic.claude-sonnet-4",
    ]) {
      const r = resolveAdapter(model);
      assert.equal(r.adapter.id, "claude", `${model} が claude に解決されない`);
      assert.equal(r.confident, true, model);
    }
  });

  it("codex 系の名前は codex へ", () => {
    for (const model of ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.5", "codex-mini", "o3"]) {
      const r = resolveAdapter(model);
      assert.equal(r.adapter.id, "codex", `${model} が codex に解決されない`);
      assert.equal(r.confident, true, model);
    }
  });

  it("未指定は codex（従来の既定）", () => {
    for (const model of [undefined, null, ""]) {
      const r = resolveAdapter(model);
      assert.equal(r.adapter.id, "codex");
      assert.equal(r.model, undefined);
      assert.equal(r.confident, true);
    }
  });

  // キャッシュが古い／新しいモデルが出た、で正当な設定を弾くと毎 run 失敗する。
  it("未知の名前は拒否せず codex へ倒し、confident=false で知らせる", () => {
    const r = resolveAdapter("grok-9");
    assert.equal(r.adapter.id, "codex");
    assert.equal(r.model, "grok-9");
    assert.equal(r.confident, false);
  });

  it("接頭辞で明示できる（命名規則が破られたときの逃げ道）", () => {
    const a = resolveAdapter("claude:grok-9");
    assert.equal(a.adapter.id, "claude");
    assert.equal(a.model, "grok-9", "接頭辞は取り除かれる");

    const b = resolveAdapter("codex:opus");
    assert.equal(b.adapter.id, "codex");
    assert.equal(b.model, "opus", "パターンより接頭辞が優先される");
  });

  it("adapterById は未知・未設定を既定へ倒す", () => {
    assert.equal(adapterById("codex").id, "codex");
    assert.equal(adapterById("claude").id, "claude");
    assert.equal(adapterById(undefined).id, "codex", "古い記録は backend を持たない");
    assert.equal(adapterById("nope").id, "codex");
  });
});

describe("claude の argv", () => {
  const base = { runId: "20260919-120000-000-abcd", cwd: "/repo", runDir: "/runs/x" };

  it("読み取り専用では Bash も Write も Task も渡さない", () => {
    const { argv } = claudeBackend.buildLaunch({
      ...base,
      capability: "read",
      model: "opus",
      effort: "xhigh",
    });
    const tools = argv[argv.indexOf("--tools") + 1];
    for (const forbidden of ["Bash", "PowerShell", "Write", "Edit", "Task"]) {
      assert.ok(!tools.split(",").includes(forbidden), `${forbidden} が許可されている: ${tools}`);
    }
    assert.ok(tools.split(",").includes("Read"), tools);
    assert.ok(!argv.includes("--permission-mode"), "read で permission-mode は要らない");
  });

  it("書き込みでは acceptEdits と書き込み系ツールを渡す", () => {
    const { argv } = claudeBackend.buildLaunch({ ...base, capability: "write", model: "opus" });
    const tools = argv[argv.indexOf("--tools") + 1].split(",");
    assert.ok(tools.includes("Bash"), tools.join(","));
    assert.ok(tools.includes("Write"), tools.join(","));
    assert.ok(!tools.includes("Task"), "既定で委譲を許してはいけない");
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
    // bypassPermissions は cwd の外へも書けてしまう（実測）。使わない。
    assert.ok(!argv.includes("bypassPermissions"), argv.join(" "));
  });

  // --verbose を落とすと stream-json が JSONL にならず、静かに壊れる。
  it("必ず付ける引数（落とすと静かに壊れるもの）", () => {
    const { argv } = claudeBackend.buildLaunch({ ...base, capability: "read" });
    for (const flag of ["-p", "--verbose", "--strict-mcp-config"]) {
      assert.ok(argv.includes(flag), `${flag} が無い: ${argv.join(" ")}`);
    }
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
    assert.equal(argv[argv.indexOf("--permission-prompts") + 1], "none");
  });

  it("マーカーは run_id で、argv に実際に現れる", () => {
    const { argv, marker } = claudeBackend.buildLaunch({ ...base, capability: "read" });
    assert.equal(marker, base.runId);
    assert.ok(argv.some((a) => a.includes(marker)), argv.join(" "));
    assert.equal(argv[argv.indexOf("-n") + 1], base.runId);
  });

  it("resume は通常の argv に --resume を足すだけ", () => {
    const { argv } = claudeBackend.buildLaunch({
      ...base,
      capability: "read",
      model: "opus",
      resumeSessionId: "2a09c9a8-ac59-4508-b9ea-8dddcd38aaf2",
    });
    assert.equal(argv[argv.indexOf("--resume") + 1], "2a09c9a8-ac59-4508-b9ea-8dddcd38aaf2");
    assert.equal(argv[argv.indexOf("--model") + 1], "opus", "resume でも model は渡せる");
    assert.ok(argv.includes("--verbose"));
  });

  it("delegate: true のときだけ Task を足す", () => {
    const { argv } = claudeBackend.buildLaunch({
      ...base,
      capability: "read",
      delegate: true,
    });
    assert.ok(argv[argv.indexOf("--tools") + 1].split(",").includes("Task"));
  });

  it("ultra は受け付けない（claude の上限は max）", () => {
    assert.equal(claudeBackend.supportsEffort("opus", "ultra"), false);
    assert.equal(claudeBackend.supportsEffort("opus", "max"), true);
    assert.ok(!claudeBackend.efforts.includes("ultra"));
  });

  // 許可リストの置き場をコードへ移した（環境変数だけだと再登録で静かに消えた）。
  // 未設定＝既定 / 設定＝置換 / 空文字＝無効、の 3 分岐を固定する。
  it("許可リストは既定がコードにあり、環境変数で上書きできる", () => {
    const KEY = "AGENT_EXEC_CLAUDE_ALLOWED_TOOLS";
    const saved = process.env[KEY];
    // --allowedTools は可変長なので末尾に置いてある。以降は全て許可パターン。
    const patternsOf = () => {
      const { argv } = claudeBackend.buildLaunch({ ...base, capability: "write" });
      const at = argv.indexOf("--allowedTools");
      return at < 0 ? [] : argv.slice(at + 1);
    };
    try {
      delete process.env[KEY];
      assert.deepEqual(patternsOf(), [
        "Bash(uv run pytest*)",
        "Bash(uv run ruff*)",
        "Bash(uv run python*)",
        "Bash(git stash*)",
      ]);
      process.env[KEY] = "Bash(node --test*)  Bash(cargo test*)";
      assert.deepEqual(
        patternsOf(),
        ["Bash(node --test*)", "Bash(cargo test*)"],
        "環境変数は既定に足すのではなく置き換える",
      );
      process.env[KEY] = "";
      assert.deepEqual(patternsOf(), [], "空文字は「何も許さない」の明示");
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it("親セッションの環境変数を子から消す", () => {
    const saved = { ...process.env };
    process.env.CLAUDE_CODE_SESSION_ID = "parent";
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = "\\\\.\\pipe\\x";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_EFFORT = "max";
    process.env.AGENT_EXEC_RUNS_DIR = "/somewhere";
    try {
      const { env } = claudeBackend.buildLaunch({ ...base, capability: "read" });
      for (const key of [
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDECODE",
        "CLAUDE_EFFORT",
        "AGENT_EXEC_RUNS_DIR",
      ]) {
        assert.equal(env[key], undefined, `${key} が消えていない`);
        assert.ok(key in env, `${key} の削除指示が無い`);
      }
    } finally {
      process.env = saved;
    }
  });

  // CLAUDE_CODE_* を前方一致で消すと接続先の設定まで巻き込む。消し漏れは
  // 子がセッション ID を誤認する程度だが、接続先を消すと run ごと別の所へ行く。
  it("接続先と認証の環境変数は残す", () => {
    const saved = { ...process.env };
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const { env } = claudeBackend.buildLaunch({ ...base, capability: "read" });
      for (const key of [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_API_KEY",
      ]) {
        assert.ok(!(key in env), `${key} を消してはいけない`);
      }
    } finally {
      process.env = saved;
    }
  });
});

describe("claude のイベント解釈", () => {
  it("init から session_id を取る", () => {
    const d = claudeBackend.parseEvent({
      type: "system",
      subtype: "init",
      session_id: "abc",
      tools: ["Read"],
      mcp_servers: [],
    });
    assert.equal(d.sessionId, "abc");
    assert.equal(d.abort, undefined);
  });

  // 再帰は課金が伸び続けるので、警告ではなく打ち切りにする。
  it("MCP が継承されていたら abort を返す", () => {
    const d = claudeBackend.parseEvent({
      type: "system",
      subtype: "init",
      session_id: "abc",
      mcp_servers: [{ name: "agent" }],
    });
    assert.match(d.abort, /strict-mcp-config/);
  });

  it("許可リストの綻び（Task が残っている）を記録する", () => {
    const d = claudeBackend.parseEvent({
      type: "system",
      subtype: "init",
      session_id: "abc",
      tools: ["Read", "Task"],
      mcp_servers: [],
    });
    assert.equal(d.extra.delegation_possible, true);
  });

  it("assistant の複数ブロックを 1 イベントから取り出す", () => {
    const d = claudeBackend.parseEvent({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "..." },
          { type: "tool_use", name: "Bash", input: {} },
          { type: "text", text: "報告本文" },
        ],
      },
    });
    assert.deepEqual(d.itemTypes, ["reasoning", "command_execution", "agent_message"]);
    assert.deepEqual(d.messages, ["報告本文"]);
  });

  it("tool 名を codex と共通の語彙へ写像する", () => {
    assert.equal(claudeBackend.itemTypeFor("Bash"), "command_execution");
    assert.equal(claudeBackend.itemTypeFor("Write"), "file_change");
    assert.equal(claudeBackend.itemTypeFor("Read"), "file_read");
    assert.equal(claudeBackend.itemTypeFor("Nonesuch"), "tool:Nonesuch");
  });

  it("tool_result は数えない（tool_use で数えているので二重になる）", () => {
    assert.equal(claudeBackend.parseEvent({ type: "user", message: { content: [] } }), null);
  });

  it("result から最終報告・usage・完了を取る", () => {
    const d = claudeBackend.parseEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "FINAL",
      usage: { input_tokens: 1 },
      total_cost_usd: 0.5,
      num_turns: 3,
      permission_denials: [],
      subagent_stats: { spawned: 0 },
    });
    assert.equal(d.completed, true);
    assert.equal(d.finalMessage, "FINAL", "engine が last-message.txt を書くための値");
    assert.deepEqual(d.usage, { input_tokens: 1 });
    assert.equal(d.extra.cost_usd, 0.5);
  });

  // 「テストを実行できなかった」の原因がここに出る。捨てると理由が分からない。
  it("permission_denials を残す", () => {
    const d = claudeBackend.parseEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x",
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "node --test" } }],
      subagent_stats: { spawned: 0 },
    });
    assert.deepEqual(d.extra.permission_denials, [
      { tool_name: "Bash", command: "node --test" },
    ]);
  });

  it("is_error の result は failure にする（finalMessage にしない）", () => {
    const d = claudeBackend.parseEvent({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "なにか失敗",
      permission_denials: [],
      subagent_stats: { spawned: 0 },
    });
    assert.equal(d.completed, true);
    assert.equal(d.failure, "なにか失敗");
    assert.equal(d.finalMessage, undefined);
  });

  it("thinking の署名は events.jsonl から落とす", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "x".repeat(5000), signature: "sig" }] },
    });
    const shrunk = JSON.parse(claudeBackend.shrinkEventLine(line));
    assert.equal(shrunk.message.content[0].thinking, "（省略）");
  });
});

describe("codex アダプタ（純関数の側）", () => {
  it("マーカーが argv に現れる（-o のパス経由）", () => {
    const runId = "20260919-120000-000-abcd";
    const { argv, marker } = codexBackend.buildLaunch({
      runId,
      runDir: `/runs/${runId}`,
      capability: "read",
      cwd: "/repo",
      skipGitRepoCheck: true,
    });
    assert.equal(marker, runId);
    assert.ok(argv.some((a) => a.includes(runId)), argv.join(" "));
  });

  it("capability を sandbox 値へ訳す", () => {
    assert.equal(codexBackend.sandbox("read").label, "read-only");
    assert.equal(codexBackend.sandbox("write").label, "workspace-write");
    assert.equal(codexBackend.sandbox("write").enforcement, "os-sandbox");
    // claude 側は OS サンドボックスではないことを型として区別する
    assert.equal(claudeBackend.sandbox("write").enforcement, "tool-allowlist");
    assert.match(claudeBackend.sandbox("write").caveat, /OS サンドボックス/);
  });

  it("item.completed を共通語彙の配列で返す", () => {
    const d = codexBackend.parseEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "本文" },
    });
    assert.deepEqual(d.itemTypes, ["agent_message"]);
    assert.deepEqual(d.messages, ["本文"]);
  });

  // codex は -o が last-message.txt を書く。engine が二重に書かないこと。
  it("最終メッセージを返さない（-o に任せる）", () => {
    const d = codexBackend.parseEvent({ type: "turn.completed", usage: { input_tokens: 1 } });
    assert.equal(d.completed, true);
    assert.equal(d.finalMessage, undefined);
  });
});

// 設定の重ね方（コード既定 → config.json）。ファイルには触らず、config を直接渡す。
describe("設定の解決", () => {
  const consult = { baseModel: "gpt-6-astra", baseEffort: "xhigh" };

  it("config が無ければコード既定", () => {
    const s = resolveSettings("consult", consult, {});
    assert.equal(s.model, "gpt-6-astra");
    assert.equal(s.effort, "xhigh");
    assert.deepEqual(s.fromConfig, { model: false, effort: false });
    assert.equal(s.adapter.id, "codex");
  });

  it("config が上書きし、モデル名で CLI が決まる", () => {
    const s = resolveSettings("consult", consult, { consult: { model: "opus" } });
    assert.equal(s.adapter.id, "claude");
    assert.equal(s.model, "opus");
    assert.equal(s.effort, "xhigh", "指定していない側はコード既定のまま");
    assert.deepEqual(s.fromConfig, { model: true, effort: false });
  });

  it("空文字は「CLI 側に委ねる」で、未設定とは違う", () => {
    const s = resolveSettings("consult", consult, { consult: { model: "", effort: "" } });
    assert.equal(s.model, undefined);
    assert.equal(s.effort, undefined);
    assert.deepEqual(s.fromConfig, { model: true, effort: true });
  });

  // 使えない値で毎 run 失敗させない。捨てたことは notes に残し、呼び出し側へ出す。
  it("使えない effort は捨てて理由を残す", () => {
    const s = resolveSettings("consult", consult, { consult: { effort: "ultra", model: "opus" } });
    assert.equal(s.effort, undefined);
    assert.match(s.notes.join("\n"), /effort=ultra/);
  });

  it("保存前の検査は、使えない値を理由つきで断る", () => {
    assert.equal(validatePatch("consult", consult, { model: "opus" }, {}), null);
    const reason = validatePatch("consult", consult, { model: "opus", effort: "ultra" }, {});
    assert.match(reason, /ultra/);
    assert.match(reason, /low, medium, high, xhigh, max/, "対応値を添える");
  });

  // 保存前の検査と run の解決が、同じモデルに違う名前を使っていた。検査は
  // "codex:gpt-5.5" のまま照合するのでキャッシュの slug に当たらず素通りし、
  // run は接頭辞を落として照合するので effort を捨てる。つまり **config が
  // 受理した設定を run が黙って無視する**。接頭辞の有無で結果が変わらないこと。
  it("codex: 接頭辞を付けても、受理・拒否と実効 effort は変わらない", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-exec-prefix-"));
    writeFileSync(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.5",
            visibility: "list",
            // ultra は無い。codex アダプタ自体は ultra を持つので、
            // モデル固有の制限だけを見ていることになる。
            supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({
              effort,
            })),
          },
        ],
      }),
    );
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const base = { baseModel: "gpt-5.5", baseEffort: "high" };
      for (const model of ["gpt-5.5", "codex:gpt-5.5"]) {
        const reason = validatePatch("consult", base, { model, effort: "ultra" }, {});
        assert.ok(reason, `${model}: 対応しない effort が受理された`);
        assert.match(reason, /gpt-5\.5 は effort=ultra/, `${model}: ${reason}`);
        assert.doesNotMatch(reason, /codex:/, "報告は接頭辞を落とした名前で出す");
        assert.match(reason, /low, medium, high, xhigh/, `${model}: 対応値を添える`);

        const s = resolveSettings("consult", base, { consult: { model, effort: "ultra" } });
        assert.equal(s.model, "gpt-5.5", `${model}: 解決後のモデル名`);
        assert.equal(s.effort, undefined, `${model}: 実効 effort`);
      }
      // 対応している effort は、接頭辞の有無によらず通る
      for (const model of ["gpt-5.5", "codex:gpt-5.5"]) {
        assert.equal(validatePatch("consult", base, { model, effort: "xhigh" }, {}), null, model);
      }
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// OS への照会結果から身元を決める部分だけを切り出したもの。実プロセスが要らないので
// ここで網羅できる。要点は「引けなかった」を「別物」に潰さないこと——潰すと、
// PowerShell の照会が一度こけただけで全 run が「停止済み」判定になる。
describe("プロセスの身元は 3 値", () => {
  const MARKER = "20260101-000000-000-aaaa";

  it("コマンドラインを引けたなら、一致・不一致を断定する", () => {
    assert.equal(
      markerVerdict(`codex exec -o /runs/${MARKER}/last-message.txt`, MARKER, true),
      "match",
    );
    assert.equal(markerVerdict("sleep 30", MARKER, true), "mismatch");
    // カーネルスレッドや zombie。引けてはいるので、確かに我々の子ではない
    assert.equal(markerVerdict("", MARKER, true), "mismatch");
  });

  it("引けなかったが生きているなら unknown（dead に倒さない）", () => {
    assert.equal(markerVerdict(undefined, MARKER, true), "unknown");
  });

  it("引けず、生きてもいないなら mismatch", () => {
    assert.equal(markerVerdict(undefined, MARKER, false), "mismatch");
  });

  // 一致の判定は前方一致でも完全一致でもなく「含む」。argv のどこに現れてもよい。
  it("マーカーは argv のどこにあってもよい", () => {
    assert.equal(markerVerdict(`claude -p -n ${MARKER} --verbose`, MARKER, true), "match");
  });
});

// 自分の起動時刻はこのプロセスが生きている間は変わらないのに、run を起こすたび・
// 設定のロックを取るたびに meta へ書く。引き直していると Windows では毎回
// PowerShell が起きる（この端末で実測 440ms）。currentBootId と同じ扱いにする。
describe("自分の起動時刻はキャッシュする", () => {
  it("値は processStartTime(process.pid) と一致し、何度呼んでも変わらない", () => {
    assert.equal(currentProcessStartTime(), processStartTime(process.pid));
    assert.equal(currentProcessStartTime(), currentProcessStartTime());
  });

  // Linux は /proc を読むだけで速く、キャッシュの有無で差が出ないため判定にならない。
  // 運用環境である Windows でだけ、外部コマンドが消えたことを所要時間で確かめる。
  it(
    "2 回目以降は外部コマンドを起こさない（Windows のみ）",
    { skip: process.platform === "win32" ? false : "Windows でのみ差が出る" },
    async () => {
      currentProcessStartTime(); // 1 回目で埋める
      // processTable の TTL(1s) を跨ぐ。跨がないとテーブルのキャッシュが効いてしまい、
      // 自分の起動時刻をキャッシュしているかどうかの判定にならない。
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const started = process.hrtime.bigint();
      currentProcessStartTime();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 50, `2 回目に ${ms.toFixed(1)}ms かかった（毎回引き直している）`);
    },
  );
});
