# codex-exec MCP サーバ

Codex CLI (`codex exec`) を MCP の tool として Claude Code へ公開する stdio サーバ。

## 背景

Codex CLI 0.154.0 で `codex mcp-server` サブコマンドが削除された（0.153.x までは
deprecated 警告付きで存在した）。現行の `codex mcp` は「Codex が外部 MCP サーバを使う側」の
管理コマンドで、Codex 自身を MCP サーバとして公開する手段は無い。`codex app-server` は
stdio で JSON-RPC を話すが MCP 非互換（`initialize` に MCP の `protocolVersion` /
`capabilities` / `serverInfo` を返さない）。そのため `codex exec` を包んで代替する。

Node 標準モジュールのみで動く（依存ゼロ、`npm install` 不要）。

## ツール

| tool | 役割 |
|---|---|
| `codex_consult` | read-only で相談する。調査・レビュー・設計相談 |
| `codex_verify` | 対象は読めるが書けない状態で検証させる。**テストの再実行ができる** |
| `codex_apply` | workspace-write で作業させる。git 管理下のみ |
| `codex_status` | 切り離した run の進捗を見る |
| `codex_result` | 切り離した run の報告を取る |
| `codex_runs` | 最近の run を一覧する |

### codex_consult / codex_apply

| 引数 | 必須 | 説明 |
|---|---|---|
| `prompt` | ✓ | Codex への指示 |
| `cwd` | `codex_apply` のみ | 作業ディレクトリ（絶対パス）。symlink と `..` は実体へ正規化する |
| `model` | | モデル slug。省略時は既定（下表） |
| `reasoning_effort` | | `low` / `medium` / `high` / `xhigh` / `max` / `ultra` |
| `timeout_ms` | | **同期で待つ上限**（既定 600000 = 10分、上限 1500000 = 25分）。待ち行列と実行待ちの合計がこれを超えない（`kill_on_timeout: true` のときは打ち切り待ちが最大 10 秒加わる）。超えても codex は止めない |
| `delegate` | | codex がサブエージェントへ委譲し独立レビューまで自走することを許すか。既定は tool ごと（下記） |
| `resume_session_id` | | 前回の `session_id`。会話を継続する |
| `kill_on_timeout` | | true なら `timeout_ms` で打ち切る（既定 false） |
| `scope` | `codex_apply` のみ | `strict`（既定）/ `open` |

`codex_apply` を git 管理下に限っているのは、Codex の変更を `git diff` で確認して戻せる
状態を保つため。判定は `git rev-parse --show-toplevel` で行う（`.git` の存在だけを見ると、
空の `.git` ディレクトリ——実際に `/tmp` にあった——を誤ってリポジトリと見なす）。

### 既定のモデルと effort

| tool | 既定モデル | 既定 effort |
|---|---|---|
| `codex_consult` | `gpt-6-astra` | `xhigh` |
| `codex_verify` | `gpt-6-astra` | `low` |
| `codex_apply` | `gpt-5.6-luna` | `max` |

- コードを書くのは `codex_apply` だけなので、そこだけ別のモデルを既定にしている。
  検証を別系統のモデル（astra）に任せることで、書いたモデルと同じ癖で見落とすのを避ける。
- `codex_verify` はテストを走らせて結果を持ち帰るのが主な仕事なので、モデルの能力は
  据え置きで effort だけ低くしている（深い推論は効きにくく、時間と費用だけ増える）。

明示指定が既定より優先される。既定の effort がそのモデルで非対応の場合は押し付けず、
Codex 側の既定に委ねる。

## codex_verify（検証モード）

`codex_consult` は `-s read-only` なので、**テストを実行しようとすると uv や pytest が
キャッシュを書けずに失敗する**。「テストは通っているという前提でコードを読む」しかなく、
レビューの独立性が落ちる。かといって `codex_apply` では対象を書き換えられてしまう。

その中間として `codex_verify` がある:

- 書けるのは `runs/<run_id>/workspace/`（run ごとの使い捨て）**だけ**
- `target_dir` は**読めるが書けない**。サンドボックスが拒否する
- Python のキャッシュ類は環境変数で作業ディレクトリへ向けてある
  （`UV_CACHE_DIR` / `XDG_CACHE_HOME` / `TMPDIR` / `PYTHONDONTWRITEBYTECODE` /
  `PYTEST_ADDOPTS=-p no:cacheprovider`）

### 仕組みと、実測して分かったこと

`-s workspace-write` は「cwd 配下だけ書ける」ではない。**既定では `/tmp` と `$TMPDIR` も
書ける**ので、cwd を一時ディレクトリにしただけでは隔離にならない（`/tmp` 配下に置いた
repo へ書けてしまうことを実測で確認した）。そこで次の 2 つを付ける:

```
-c sandbox_workspace_write.exclude_slash_tmp=true
-c sandbox_workspace_write.exclude_tmpdir_env_var=true
```

これで実測した挙動:

| 操作 | 結果 |
|---|---|
| cwd の外（対象 repo）を読む | できる |
| cwd の外（対象 repo）に書く | **できない** |
| cwd（使い捨て作業ディレクトリ）に書く | できる |

実運用での確認（対象 = このリポジトリとは別の実プロジェクト）:

```
1. uv run pytest ... → 57 passed in 3.37s     ← テストが走る
2. touch <target>/PROBE.txt → false            ← 書き込みは拒否される
3. touch ./scratch.txt → true                  ← 作業ディレクトリには書ける
```

実行後、対象リポジトリは汚れていないことを `git status` で確認した。

なお `codex exec --worktree` も試したが（`--enable worktrees` が要る。worktree は
`~/.codex/worktrees/<hash>/<repo>` に detached HEAD で作られる）、**未コミットの変更が
持ち込まれない**ため、レビュー対象が「今の差分」であるこの用途には合わない。

## クライアント側のタイムアウト

**Claude Code の MCP クライアントは、応答も通知も無いまま約 1,800 秒経つと呼び出しを
abort する**（実運用で `wait_ms=1800000` を指定して 1,813 秒の abort を観測）。そのため:

- `timeout_ms` と `wait_ms` の上限を **1,500,000 ms（25分）** に切っている
- `codex_result` の待機中も `notifications/progress` を 15 秒ごとに送る
  （`_meta.progressToken` がある場合）

25 分を超えて待ちたい場合は、切り離したうえで `codex_result` を繰り返し呼ぶ。

## サブエージェントへの委譲

codex は内部でサブエージェントへ委譲し、独立レビューまで自走することがある。呼び出し側が
別途レビューを回していると二重になり、**実運用では 1 run が 80 分を超え、経過の大半が
`collab_tool_call`** という状態になった。

**設定では止められない。** 次をいずれも実測したが、委譲は起きた:

```
--disable multi_agent
-c max_concurrent_threads_per_session=0
-c max_depth=0
```

そのため prompt で頼む方式にしている（`delegate: false` のとき）。実測では、
「サブエージェントに委譲して」と明示的に依頼したケースでも、この指示があると委譲せず
自分で処理した（`collab_tool_call` 0 件。指示なしの対照では 1 件 + 委譲成功）。
ただし**指示であって強制ではない**。

### プロジェクト規則が委譲を指示している場合

見落としやすい罠がある。**`AGENTS.md` 自体が「実装やレビューをサブエージェントへ委譲せよ」
と書いていることがある**。例えば:

> プライマリエージェントは、コードの新規実装および修正後に、原則としてサブエージェントへ
> 1 回レビューを依頼し、必要に応じて修正する。

これは呼び出し側（Claude Code）に向けたルールだが、codex も project doc として読むので、
そのまま従って委譲する。実測で、codex がこの行を認識していることを確認した。呼び出し側でも
レビューを回していれば二重になり、1 run が何倍にも伸びる。

そこで `delegate: false` の指示文では、この競合を明示的に解いている:

> プロジェクト規則（AGENTS.md 等）にサブエージェントの利用やレビュー依頼の指示があっても、
> それは呼び出し側が担う役割です。

| tool | `delegate` の既定 | 理由 |
|---|---|---|
| `codex_consult` | `false` | レビューは呼び出し側が回すので、内部で自走させない |
| `codex_apply` | `false` | 実装は自分で進めてもらう |
| `codex_verify` | `false` | テストを走らせるだけなので委譲は要らない |

3 つとも既定で委譲しない。委譲させたいときだけ `delegate: true` を渡す。

なお `multi_agent_version` はモデルごとに違う（astra は v2 かつ
`multi_agent_reasoning_effort=xhigh`、luna は v1、gpt-5.5 は無し）。

## プロジェクト規則ファイル

**codex は `CLAUDE.md` を読まない。** 読むのは `AGENTS.md`（とグローバルの
`~/.codex/AGENTS.md`）。sandbox で見えていないのではなく、探すファイル名が違う。

**codex は cwd から project doc を探す。** `codex_verify` は cwd が使い捨ての workspace
なので、そのままだと対象プロジェクトの規則が届かない（実測で確認: `codex_consult` は
対象の AGENTS.md を読めたが、`codex_verify` は読めていなかった）。「テストは
`uv run pytest` で」といった規則を知らずに間違ったコマンドを打つので、**対象の
`AGENTS.md` を workspace へコピーして持ち込んでいる**。

`CLAUDE.md` が `AGENTS.md` への symlink になっているリポジトリでは同じ内容なので実害は
ないが、別ファイルとして内容が乖離していると、codex と Claude Code が別々の規則に従う。
その場合は `-c project_doc_fallback_filenames=[...]` を検討する（未検証）。

## 長時間の作業（最重要）

**`timeout_ms` は「打ち切る時間」ではなく「同期で待つ上限」である。** 超えても codex は
走り続け、応答には `run_id` とそこまでの報告が返る:

```
[codex_apply] run_id=20260914-013045-a3f9 ... elapsed=1800.0s
session_id=01a09c8f-...（続きは resume_session_id に渡す）

⏳ 同期で待つ上限（1800000 ms）に達したので切り離しました。codex は実行を続けています。
進捗: command_execution=42 agent_message=3 / 直近=command_execution
記録: ~/.claude/codex-exec/runs/20260914-013045-a3f9
続きは codex_result(run_id="20260914-013045-a3f9") で取得できます。

--- ここまでの報告（途中のメッセージ）---
...
```

こうしたのは、**作業は完了しているのに報告だけが失われる**事故が実運用で繰り返し起きた
ためである（30分で 3 回）。何を実装したか、判断に迷った点、範囲外で見つけた弱点は
実装者しか知らないので、失うと差分からは復元できない。

これを支えているのが `--json` である。最終メッセージ（`-o`）はプロセスの最後に一度しか
書かれないので、報告を書き出す前に打ち切られると丸ごと消える。`--json` なら
`item.completed` が逐次流れてくるので、打ち切っても「そこまでの報告」を返せる。

### run の記録

すべての実行は次の場所に残る。MCP の応答が失われても、後から読める。

```
~/.claude/codex-exec/runs/
├── <run_id>/
│   ├── meta.json         # 引数・状態・pid・thread_id・usage・git 差分
│   ├── prompt.txt        # 実際に渡したプロンプト（scope の付加ぶんを含む）
│   ├── events.jsonl      # --json の生ログ（切り詰めと末尾読みの対象）
│   ├── messages.jsonl    # 報告本文だけを逐次保存したもの
│   ├── last-message.txt  # codex の最終メッセージ
│   └── stderr.log
└── sessions/<session_id>.json   # resume のための索引（run の保持期間とは独立）
```

**報告本文を `events.jsonl` と分けている**のは、イベントログが「1 行 256 KB で切り詰め」
「読み出しは末尾 2 MB」という制約を持つため。巨大な報告や長いログでは、イベント側から
本文を復元できない。`messages.jsonl` は `agent_message` だけを貯めるので、打ち切られても
そこまでの報告を必ず取り出せる。

サーバを再起動して追跡が切れた run も、`codex_status` / `codex_result` が
`events.jsonl` から状態と報告を復元する。

## 会話の継続

応答の `session_id` を次の呼び出しの `resume_session_id` に渡すと、文脈を書き直さずに
続きを話せる（実 codex で検証済み）。

### codex exec resume について実測したこと（0.154.0）

`codex exec resume` が受け付けるオプションは `--json` / `-o` / `-m` / `-c` /
`--skip-git-repo-check` などに限られ、**`-s` / `-C` / `--color` は無い**（`--color` を
渡すと `unexpected argument` で落ちる）。そのため sandbox は `-c sandbox_mode="..."` で
指定し、作業ディレクトリは spawn の cwd で与えている。この 2 つは前提として重いので、
実際に確かめた:

| 確かめたこと | 方法 | 結果 |
|---|---|---|
| `-c sandbox_mode` が元セッションの sandbox を上書きするか | `workspace-write` で作ったセッションを `read-only` で resume し、ファイル作成を試させた | **上書きする**（codex が `touch: Read-only file system` で失敗を報告） |
| 再開後の cwd がどちらになるか | repoA で作ったセッションを dirB から resume し、cwd を報告させた | **spawn の cwd**（dirB） |
| resume 時に `thread.started` が再送されるか | resume した run の `events.jsonl` を確認 | **再送される**（同じ thread_id） |

### resume の出自検証

`resume_session_id` は UUID 形式であることに加え、**このサーバの記録にあるセッションで、
かつ同じ cwd** であることを確認する。codex 側の上記の前提に頼らず、ローカルの記録だけで
防げる部分は防いでおくため。

索引は `runs/sessions/<session_id>.json` に run 本体とは別に持つ。run は `MAX_RUNS` や
保持期間で prune されるが、索引が残っていれば会話は継続できる。1 セッション 1 ファイル
なのは、1 つの JSON にまとめると読み込み→更新→書き戻しの間に他のサーバの登録が消えるため
（temp + rename が保証するのは書き換えの不可分性だけで、読み書きの排他ではない）。

tool をまたぐ継続（調査 → 修正、修正 → レビュー）は自然なので拒否しない。ただし
sandbox が変わるので、応答に「codex_consult のセッションを codex_apply = workspace-write
で継続します」と明示する。

## 変更内容の確認

`codex_apply` は**終了時点の git 状態**（変更ファイル一覧と `diff --stat`）を応答に添える。
codex のイベント形式に依存しないので、打ち切られた場合でも取得できる。

「この run が変えたぶん」だけを厳密に切り出すには開始時点の内容そのものを保存する必要が
あるため、そこまではやっていない。代わりに開始前から変更があったファイルには
`← run 開始前から変更あり` と印を付ける。開始前の変更を一覧から**除外**すると、
codex がそのファイルを追加編集した場合に消えてしまう（run 前から dirty だったという
理由だけで）。HEAD が動いた場合は、作業ツリーが clean でもその旨を表示する。

## 作業範囲

`codex_apply` は既定（`scope: "strict"`）で、prompt の末尾に次の指示を添える:

> 指示された範囲のみを変更してください。範囲外で問題や弱点を見つけた場合は、その場で
> 修正せず、報告に「範囲外の気づき」として記載してください。

「抽出だけ」と指示したのに周辺を直され差し戻しになった事例があったため。`scope: "open"`
で外せる。

## 登録

```bash
claude mcp add codex -s user -- node ~/agent-tools/mcp-servers/codex-exec/server.mjs
claude mcp list   # ✔ Connected を確認
```

`codex_consult` は read-only なので `permissions.allow` に入れてよい。`codex_apply` は
書き込みが走るため、都度承認を勧める。

## テスト

```bash
cd ~/agent-tools/mcp-servers/codex-exec && node --test test/protocol.test.mjs test/runs.test.mjs
```

実 Codex は呼ばず、`test/fake-codex.sh` を `CODEX_BIN` として差し替える。ダミーは
`--json` のイベント列を模し、環境変数で遅延・異常終了・孫プロセス・ファイル変更を再現する。

**ダミーは引数を検証しない**ので、`codex exec resume` に `--color` を渡していた不具合は
テストを通過し、実 codex で初めて露見した。resume に渡すオプションは許可リストで
固定してある（`test/protocol.test.mjs`）。

## 変更を反映させる

**動いているサーバプロセスは、起動時のコードをメモリに持ち続ける**（実測で確認）。
`server.mjs` や `lib/*.mjs` を書き換えても、そのプロセスが生きている限り反映されない。
反映にはサーバプロセスの再起動が要る（Claude Code のセッション再起動、または `/mcp` で
再接続できればそれでもよい）。

今どのコードが動いているかは `serverInfo.version` で分かる。挙動を変えたらここを上げる。

```
現在: 3.7.0
```

| version | 変更 |
|---|---|
| 1.0.0 | 初版（codex_consult / codex_apply の 2 ツール、同期のみ） |
| 2.0.0 | `--json` へ移行、run の永続化、切り離し（detach）、会話継続、status/result/runs |
| 3.0.0 | `codex_verify` を追加、同じ repo での並行 apply を拒否 |
| 3.1.0 | `codex_apply` の既定を gpt-5.6-luna / max に変更 |
| 3.2.0 | `codex_verify` の既定 effort を low に変更 |
| 3.3.0 | 同期で待つ上限を 25 分へ引き下げ、`codex_result` の待機中も進捗通知を送る |
| 3.4.0 | `delegate` 引数を追加、codex 側のエラー（turn.failed）を応答に載せる |
| 3.5.0 | `codex_verify` が対象の AGENTS.md を workspace へ持ち込むよう修正 |
| 3.6.0 | `delegate: false` の指示文で、AGENTS.md の委譲指示との競合を明示的に解く |
| 3.7.0 | `codex_consult` の `delegate` も既定 false に（3 ツールとも委譲しない） |

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `CODEX_BIN` | `codex` | codex 実行ファイル |
| `CODEX_HOME` | `~/.codex` | `models_cache.json` の探索先 |
| `CODEX_MCP_RUNS_DIR` | `~/.claude/codex-exec/runs` | run の記録先（clone の外に置く） |
| `CODEX_MCP_CONSULT_MODEL` | `gpt-6-astra` | `codex_consult` の既定モデル |
| `CODEX_MCP_CONSULT_EFFORT` | `xhigh` | `codex_consult` の既定 effort |
| `CODEX_MCP_APPLY_MODEL` | `gpt-5.6-luna` | `codex_apply` の既定モデル |
| `CODEX_MCP_APPLY_EFFORT` | `max` | `codex_apply` の既定 effort |
| `CODEX_MCP_VERIFY_MODEL` | `gpt-6-astra` | `codex_verify` の既定モデル |
| `CODEX_MCP_VERIFY_EFFORT` | `low` | `codex_verify` の既定 effort |
| `CODEX_MCP_MAX_CONCURRENCY` | `3` | 同時に走らせる codex の本数 |
| `CODEX_MCP_MAX_RUNS` | `50` | 保持する run の件数 |
| `CODEX_MCP_WORKSPACE_TTL_MS` | `86400000` | 完了から この時間で codex_verify の workspace を捨てる（24時間） |
| `CODEX_MCP_MAX_CACHE_BYTES` | `3221225472` | 共有 cache の上限（3GB）。超えたら捨てて作り直す |
| `CODEX_MCP_PRUNE_GRACE_MS` | `120000` | 完了直後の run を保護する時間 |
| `CODEX_MCP_PRUNE_DELAY_MS` | `10000` | run 完了から prune までの遅延 |
| `CODEX_MCP_HARD_LIMIT_MS` | `7200000` | 1 run の絶対上限（2時間）。超えたら強制的に打ち切る |

モデル / effort の環境変数に**空文字**を渡すと「既定なし」になり、`~/.codex/config.toml`
に委ねる。

## 設計上の注意

- **完了の判定**: `close` は「プロセス終了」と「stdio が全て閉じる」の両方を待つ。Codex が
  stdout を継いだ孫（別プロセスグループへ逃げたもの）を残すと `close` は来ないので、
  `exit` を購読して 1 秒の drain 猶予で確定させる。これが無いと、正常終了していても
  `timeout_ms` まで待たされる。
- **打ち切り**: `detached: true` でプロセスグループを作り、`SIGTERM` → 3秒後 `SIGKILL` を
  グループごと送る。SIGKILL 後 2 秒で強制的に応答を返す。
- **孤児プロセス**: 通常終了（`exit` / `SIGINT` / `SIGTERM` / `SIGHUP`）では、切り離した
  run も含めて全て落とす（放置すると課金が続くため）。サーバが `SIGKILL` された場合は
  その場では回収できないので、`meta.json` に codex の `pid`・管理サーバの `server_pid`・
  `boot_id` を記録しておき、**次の起動時に回収する**。
- **PID 再利用に注意**: `pid` が生きているだけでは「その run の codex」とは限らない。
  特に**マシン再起動をまたぐと PID は低位から振り直される**ので、無関係なプロセスに
  当たりやすい。`process.kill(-pid, SIGKILL)` はプロセスグループ全体を落とすため、
  誤爆すると他のセッションやビルドを巻き込む。そこで回収の条件を 3 つ重ねている:
  (1) `boot_id` が現在と一致する、(2) `server_pid` が死んでいる（＝他のセッションが
  見ていない）、(3) `/proc/<pid>/cmdline` に `run_id` が含まれる（codex には必ず
  `-o <runs>/<run_id>/last-message.txt` が渡るので、偶然一致しない目印になる）。
- **走っているかの判定**: 追跡が切れた run は、まず `events.jsonl` の `turn.completed`
  を見る。完了の証跡があればそれが最も確かなので「完了」とする。無ければ上と同じ
  身元確認つきの生存判定へ進み、生きていれば `codex_result` は「まだ動いています」と
  返す。逆順にすると、PID 再利用で**終わった run が永久に実行中に見え**、呼び出し側が
  無限にポーリングする。「報告が無い」と断言するのも同様に危険で、呼び出し側が失敗と
  判断して高価な（apply なら破壊的な）再実行に走る。
- **記録の保護**: `meta.json` と セッション索引は一時ファイル + `rename` で書き換える
  （同一 FS の rename は不可分なので、他プロセスが途中の状態を読まない）。prune は
  meta が読めない run を消さない — 書き込み途中かもしれないものを消す側に倒すと、
  記録を守る仕組みが記録を壊す。加えて prune は (1) スロット待ちでまだ pid の無い
  自分の run、(2) 完了から `PRUNE_GRACE_MS` 以内の run を残し、run 完了からの実行自体も
  `PRUNE_DELAY_MS` 遅らせる。**保持上限を小さくすると、応答を組み立てる前に記録が
  消えて「報告を返しませんでした」になる**ため。
- **予約した SIGKILL**: `killRun` が仕掛ける SIGKILL のタイマーは `finalize` で必ず解除し、
  発火時にも状態を確かめる。完了後に撃つと、PID が再利用された別のプロセスグループを
  巻き込む。
- **サーバの同定**: 孤児回収で「他のサーバが見ている run」を避ける判定は、`server_pid` の
  生存だけでなく `/proc/<pid>/stat` の起動時刻まで一致を見る。PID が再利用されていると、
  本物の孤児を永久に回収できなくなるため。
- **git は同期実行**: `execFileSync` なので、待っている間は他の run のイベント処理も
  タイマーも止まる。タイムアウトは 5 秒。大きな repo や遅い FS では応答が引っ張られる。
- **codex 側のエラー**: `turn.failed` / `error` イベントを拾い、API のエラー本文を
  そのまま応答に載せる。これが無いと「報告を返しませんでした」としか言えず、原因
  （例: そのモデルはこのアカウントで使えない）が伝わらない。
- **モデルの提供終了**: `models_cache.json` は codex 実行のたびに更新される。実際に
  `gpt-5.3-codex-spark` が一覧から消え、指定すると 400 で弾かれるようになった。
  起動時の `checkDefaults` はキャッシュとの照合なので、キャッシュが古いと気づけない。
- **同時実行**: 既定 3 本。切り離した run もスロットを保持する（codex は走り続けている
  ため）。空きを `timeout_ms` 待っても取れなければエラーを返す。
- **同じ repo での並行 apply**: 拒否する。同時に走らせると互いの変更を奪い合ううえ、
  git 差分がどちらのものか分からなくなる。`codex_consult` / `codex_verify` は読むだけ
  なので並行して使える。
- **検証モードの作業ディレクトリ**: `runs/<run_id>/workspace/` に残る（テスト成果物や
  キャッシュを含む）。run の prune と一緒に消える。
- **stdout の純度**: MCP の stdout は JSON-RPC 専用。ログは必ず stderr へ出すこと
  （テストが全 stdout 行を JSON-RPC としてパースできることを検証している）。
  `git` の呼び出しも `stdio: [ignore, pipe, ignore]` で stderr を捨てている。
- **git の出力を trim しない**: `git status --porcelain` は行頭の空白が意味を持つ
  （` M path` は未ステージの変更）。出力全体を trim すると 1 行目だけ 1 文字ずれ、
  パスが壊れるうえ「run 前からあった変更」の判定まで狂う。`--porcelain -z` を使い、
  1 行の値を取るときだけ trim する。
- **run_id**: `YYYYMMDD-HHMMSS-mmm-xxxx`。ミリ秒まで入れるのは、`runs/` を名前順に
  並べて新旧を判断しているため。ディレクトリは `mkdir`（recursive なし）で排他的に
  作るので、採番が衝突しても既存の run を上書きしない。
- **サイズの上限**: codex の stdout は改行が来ないまま 4 MB を超えたら破棄、
  `events.jsonl` の 1 行は 256 KB で切り詰め、読み出しは末尾 2 MB だけ。
  長時間の apply でも `codex_status` が重くならないようにするため。
- **未知ツール・引数不正**: JSON-RPC の `-32602` ではなく `isError: true` の結果として返す。
  呼び出し側の LLM が内容を読んで自己修正できるようにするため（意図的な選択）。
- **イベントの解釈**: 実測できているのは `thread.started` / `turn.started` /
  `item.completed` / `turn.completed` と `item.type = agent_message` の `text` だけ。
  未知の item は type を数えるに留め、中身の解釈は `events.jsonl` に委ねている。
- **進捗通知**: `tools/call` に `_meta.progressToken` があれば 15 秒ごとに
  `notifications/progress` を送る。受信の有無は stderr に記録するので、Claude Code が
  これを送るかどうかは実利用のログで確認できる。
