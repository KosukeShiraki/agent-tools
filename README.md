# agent-tools

Claude Code / Codex CLI で使う道具の置き場。スキルと MCP サーバを 1 つの repo で配る。

| 種類 | 名前 | 内容 |
|---|---|---|
| スキル | `consulting-slides` | 経営層向けの戦略コンサルティング資料を HTML スライド（16:9）で作成する。24種の図解パターン、ヘッドレス Chrome による全ページ画像検証つき。求められたときだけ PPTX にも変換できる |
| MCP サーバ | `mcp-servers/agent-exec` | Codex CLI と Claude Code を MCP の tool として Claude Code へ公開する。モデル名で起動する CLI が決まる。相談と実装を委譲でき、長時間の run は切り離して後から結果を取れる |

## セットアップ（各端末で1回）

```bash
git clone git@github.com:KosukeShiraki/agent-tools.git ~/projects/agent-tools
```

### スキル

```bash
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s ~/projects/agent-tools/consulting-slides ~/.claude/skills/consulting-slides   # Claude Code
ln -s ~/projects/agent-tools/consulting-slides ~/.codex/skills/consulting-slides    # Codex CLI
```

### MCP サーバ（agent-exec）

前提: Node（22 で動作確認）、[Codex CLI](https://github.com/openai/codex)（login 済み）、git。
`npm install` は要らない（Node 標準モジュールのみで動く）。

```bash
claude mcp add agent -s user -- node ~/projects/agent-tools/mcp-servers/agent-exec/server.mjs
claude mcp list   # ✔ Connected を確認
```

反映は次に Claude Code を起動したときから。実行記録は clone の外
（`~/.claude/agent-exec/runs`）に置かれるので、この repo は汚れない。

詳細は [`mcp-servers/agent-exec/README.md`](mcp-servers/agent-exec/README.md)。

#### 対応 OS

| OS | 状態 |
|---|---|
| Linux / WSL | 動作確認済み |
| macOS | 実装済み・未検証（プロセスの同定に `ps` / `sysctl` を使う） |
| Windows | 実装済み・未検証（`taskkill` / PowerShell の `Win32_Process` を使う） |

プロセスの身元確認ができない環境では、孤児プロセスの回収を見送る（誤って無関係な
プロセスを止めるより安全側に倒す）。

## 更新

```bash
cd ~/projects/agent-tools && git pull
```

MCP サーバのコードを更新した場合、**動いているサーバプロセスには反映されない**
（Node は起動時にモジュールを読む）。Claude Code を起動し直すか `/mcp` で再接続する。
今どの版が動いているかは `serverInfo.version` で分かる。

## テスト

```bash
cd ~/projects/agent-tools/mcp-servers/agent-exec && node --test test/protocol.test.mjs test/runs.test.mjs
```

実 Codex は呼ばず、ダミーに差し替えて 132 件を検証する。

**Windows では走らない**（ダミーが shebang 付きの `.sh` で、Windows は実行できない）。
WSL / Linux / macOS で実行すること。
