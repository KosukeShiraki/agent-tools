// テスト共通のヘルパー。実 codex は呼ばず、fake-codex.sh を CODEX_BIN として使う。
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(HERE, "..", "server.mjs");
export const FAKE_CODEX = join(HERE, "fake-codex.sh");
export const FAKE_THREAD_ID = "01a09c85-9969-7611-97f2-0d00bf50a7f9";

// サーバを1本起動し、id 対応で JSON-RPC をやり取りする薄いクライアント。
export function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CODEX_BIN: FAKE_CODEX, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const badLines = [];
  const unsolicited = [];
  const notifications = [];
  let stderr = "";
  let nextId = 1;
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        badLines.push(line); // stdout に JSON-RPC 以外が出た
        continue;
      }
      if (message?.jsonrpc !== "2.0") {
        badLines.push(line);
        continue;
      }
      if (message.method !== undefined) {
        notifications.push(message);
        continue;
      }
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      } else {
        unsolicited.push(message);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    request(method, params, timeoutMs = 30_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} が応答しませんでした`));
        }, timeoutMs).unref();
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    call(name, args, extra = {}, timeoutMs) {
      return this.request("tools/call", { name, arguments: args, ...extra }, timeoutMs);
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    writeRaw(line) {
      child.stdin.write(`${line}\n`);
    },
    // id を持たない応答（-32700 など）を1件待つ
    nextUnmatched() {
      return new Promise((resolve, reject) => {
        pending.set(null, resolve);
        setTimeout(() => {
          if (pending.delete(null)) reject(new Error("エラー応答が返りませんでした"));
        }, 5_000).unref();
      });
    },
    get stderr() {
      return stderr;
    },
    badLines,
    unsolicited,
    notifications,
    get pid() {
      return child.pid;
    },
    close() {
      child.stdin.end();
      child.kill();
    },
    // サーバが突然死した状況（後始末が走らない）を作る
    kill9() {
      child.kill("SIGKILL");
    },
  };
}

// 実ホームの ~/.codex に依存しないよう、テスト専用の models_cache.json を置く
export function writeModelsCache(codexHome) {
  execFileSync("mkdir", ["-p", codexHome]);
  const levels = (efforts) => efforts.map((effort) => ({ effort, description: "" }));
  writeFileSync(
    join(codexHome, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-astra",
          visibility: "list",
          supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]),
        },
        {
          slug: "gpt-5.6-luna",
          visibility: "list",
          supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max"]),
        },
        {
          slug: "gpt-5.5",
          visibility: "list",
          supported_reasoning_levels: levels(["low", "medium", "high", "xhigh"]),
        },
        { slug: "gpt-hidden", visibility: "hide", supported_reasoning_levels: levels(["low"]) },
      ],
    }),
  );
}

// 一時の作業場（git repo・非 git ディレクトリ・codex home・runs 置き場）を用意する
export function makeWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), `codex-mcp-${prefix}-`));
  const plainDir = join(root, "plain");
  const gitDir = join(root, "repo");
  const codexHome = join(root, "codex-home");
  const runsDir = join(root, "runs");
  execFileSync("mkdir", ["-p", plainDir, gitDir, runsDir]);
  execFileSync("git", ["init", "-q", gitDir]);
  execFileSync("git", ["-C", gitDir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", gitDir, "config", "user.name", "t"]);
  writeFileSync(join(gitDir, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", gitDir, "add", "."]);
  execFileSync("git", ["-C", gitDir, "commit", "-q", "-m", "seed"]);
  writeModelsCache(codexHome);
  return {
    root,
    plainDir,
    gitDir,
    codexHome,
    runsDir,
    argvFile: join(root, "argv.txt"),
    stdinFile: join(root, "stdin.txt"),
    pwdFile: join(root, "pwd.txt"),
    env(extra = {}) {
      return {
        CODEX_HOME: codexHome,
        AGENT_EXEC_RUNS_DIR: runsDir,
        CODEX_FAKE_ARGV_FILE: join(root, "argv.txt"),
        CODEX_FAKE_STDIN_FILE: join(root, "stdin.txt"),
        CODEX_FAKE_PWD_FILE: join(root, "pwd.txt"),
        ...extra,
      };
    },
  };
}

export function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

export function argvOf(argvFile) {
  return readFileSync(argvFile, "utf8").trim().split("\n");
}

export function runIdOf(text) {
  const match = text.match(/run_id=(\d{8}-\d{6}-\d{3}-[a-z0-9]{4})/);
  return match?.[1];
}
