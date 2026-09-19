# agent-exec MCP サーバ

エージェント CLI を MCP の tool として Claude Code へ公開する stdio サーバ。
Codex CLI (`codex exec`) と Claude Code (`claude -p`) を動かせる。

## モデル名で起動する CLI が決まる

**`backend` のような引数は無い。** 利用者が決めるのはモデルと effort だけで
（[tool の引数ではなく環境変数](#モデルと-effort-は利用者だけが決める)）、モデルが
決まれば行き先も決まる。

```
gpt-6-astra / gpt-5.6-luna / gpt-* / models_cache.json にあるもの → codex exec
opus / sonnet / haiku / fable / claude-* / us.anthropic.*         → claude -p
```

前方一致なので `opus-4.5` / `sonnet[1m]` / `claude-opus-5[1m]` も拾う。**未知の名前は
拒否せず** codex（従来の既定）へ倒し、起動時に警告を出す。キャッシュが古い／新しい
モデルが出た、で正当な設定を弾くと毎 run 失敗するため。命名規則が破られたときは
`claude:<名前>` / `codex:<名前>` と接頭辞で明示できる。

どの tool がどこへ行くかは、起動時に必ず stderr へ出る:

```
consult: model=haiku effort=low → claude (read-only(tool 制限) / tool-allowlist)
apply:   model=gpt-5.6-luna effort=max → codex (workspace-write / os-sandbox)
```

## 構成

CLI 固有の部分はアダプタに閉じてあり、実行の骨格（起動・監視・打ち切り・記録・
同時実行）はどの CLI にも依存しない。

```
server.mjs               MCP プロトコル・tool 定義・引数検証・応答の組み立て
lib/engine.mjs           プロセスの起動/監視/打ち切り/完了判定/孤児回収と永続化
lib/git.mjs              git の状態取得と差分
lib/runs.mjs             run の記録
lib/platform.mjs         プロセスの同定（OS 差の吸収）
lib/env.mjs              環境変数の読み出し（旧名の互換込み）
lib/backends/index.mjs   モデル名 → アダプタの解決
lib/backends/codex.mjs   codex exec 固有
lib/backends/claude.mjs  claude -p 固有
```

アダプタは `runs.mjs` も `child_process` も import しない。永続化も spawn もせず、
**純関数だけを公開する**。イベント解析は「1 行 → delta」を返すだけで、meta の更新・
セッション索引の登録・報告の追記は engine 側が行う。おかげで argv 組み立てとイベント
解釈が spawn 無しでテストでき、その部分は **Windows でも走る**（`test/resolve.test.mjs`）。

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
| `consult` | 別系統のモデルによる読み取り専用の独立レビュー。resume で同じレビュー役に段階をまたいで見せられる |
| `apply` | 書き込み可で作業させる。git 管理下のみ |
| `status` | 切り離した run の進捗を見る |
| `result` | 切り離した run の報告を取る |
| `runs` | 最近の run を一覧する。モデル・effort・所要時間・失敗理由が出る |

### consult / apply

| 引数 | 必須 | 説明 |
|---|---|---|
| `prompt` | ✓ | 委譲先への指示 |
| `cwd` | `apply` のみ | 作業ディレクトリ（絶対パス）。symlink と `..` は実体へ正規化する |
| `timeout_ms` | | **同期で待つ上限**（既定 600000 = 10分、上限 1500000 = 25分）。待ち行列と実行待ちの合計がこれを超えない（`kill_on_timeout: true` のときは打ち切り待ちが最大 10 秒加わる）。超えても codex は止めない |
| `delegate` | | codex がサブエージェントへ委譲し独立レビューまで自走することを許すか。既定は tool ごと（下記） |
| `resume_session_id` | | 前回の `session_id`。会話を継続する |
| `kill_on_timeout` | | true なら `timeout_ms` で打ち切る（既定 false） |
| `scope` | `apply` のみ | `strict`（既定）/ `open` |

`apply` を git 管理下に限っているのは、Codex の変更を `git diff` で確認して戻せる
状態を保つため。判定は `git rev-parse --show-toplevel` で行う（`.git` の存在だけを見ると、
空の `.git` ディレクトリ——実際に `/tmp` にあった——を誤ってリポジトリと見なす）。

### モデルと effort は利用者だけが決める

| tool | モデル | effort |
|---|---|---|
| `consult` | `gpt-6-astra` | `xhigh` |
| `apply` | `gpt-5.6-luna` | `max` |

コードを書くのは `apply` だけなので、そこだけ別のモデルにしている。レビューを
別系統のモデル（astra）に任せることで、書いたモデルと同じ癖で見落とすのを避ける。

**`model` と `reasoning_effort` は tool の引数ではない。** 呼び出し側の LLM からは
指定できない（渡すと「未知の引数です」で弾く）。

そうしたのは、**呼び出し側が既定を無視するのを実測したため**である。保持していた 25 run
すべてが `gpt-6-astra` で、`apply` の既定 `gpt-5.6-luna` は一度も発動していなかった
（呼び出し側が毎回 `model` を明示していた）。effort も 4 run で勝手に下げられていた。
どのモデルにいくら払うかは利用者が決めることなので、入口を塞ぐ。

既定の effort がそのモデルで非対応の場合は押し付けず、Codex 側の既定に委ねる。判定は
**起動時**に行い（呼び出し側から渡せない以上、実行時に弾いても直す手段が無い）、
落とした場合は stderr に warning を出す。

### どこで変えるか

```
呼び出し側の LLM       → 渡せない
環境変数               → その端末だけの上書き
TOOL_MODES の既定      ← 全端末の基準
~/.codex/config.toml   → 環境変数に空文字を渡したときだけ
```

| 変える場所 | 効く範囲 | 使いどころ |
|---|---|---|
| `server.mjs` の `TOOL_MODES` | **全端末**（push → pull → サーバ再起動） | 基準を変えるとき |
| 環境変数（[下記](#環境変数)） | その端末だけ | 一時的に別のモデルを試すとき |

`envDefault(process.env.X, "fallback")` の**第 2 引数がコードの既定**なので、基準を
変えるならそこを書き換える。

**全端末で揃えたいなら、環境変数ではなくコードの既定を変えること。** `~/.claude.json`
は端末間で同期されないので、環境変数でやると入れ忘れた端末が黙って別のモデルで動き、
しかも気づく手段がない。`claude mcp add -e ...` は履歴にも残らず、後から「なぜこの
モデルなのか」を追えない。コードなら `git log -p` に理由が残り、各端末のセットアップ
手順も 1 行のままで済む（既に `git pull` する運用があるので、配布経路を増やさずに済む）。

**既定を変えたら `SERVER_VERSION` を上げること。** `git pull` してもプロセスは古い
コードを持ち続けるため（[変更を反映させる](#変更を反映させる)）、「ファイルは新しいが
プロセスは古い」状態が必ず起きる。これを外から見分ける手段は `serverInfo.version` しか
ない。既定モデルの変更は挙動の変更なので、版を上げる対象に含める。

## テストを誰が走らせるか（`codex_verify` を廃した理由）

4.0.0 まで `codex_verify` があった。対象を読めるが書けないサンドボックスでテストを
走らせる tool で、「実装者の自己申告を信じない」ための独立した検証役だった。

**保持していた 25 run で一度も使われなかった**（`apply` 13 / `consult` 12 /
`codex_verify` 0）。振り返ると、この tool には 3 つ問題があった:

1. **出自が役割ではなく技術的制約だった。** `read-only` では uv や pytest がキャッシュを
   書けずテストが落ちる、という回避策として生まれた。「独立した検証役が要る」という
   要請から設計したわけではない。
2. **「実行するだけ」なら呼び出し側の Bash が圧倒的に安い。** 同じマシンで動く以上、
   できることは変わらない。model 1 run（数分 + 枠）を使う理由が無い。
3. **自己申告の検証は、すでに git 差分が担っていた。** テストを緩める・xfail を付ける
   といった改変は、`apply` が応答に添える変更ファイル一覧と `diff --stat` に出る。

代わりに `apply` は、prompt の末尾で**テストの実行と申告**を求める:

> 変更後はプロジェクト規則に従ってテストを実行し、実行したコマンドと結果（件数・
> 失敗の有無）を報告に含めてください。実行しなかった場合は、その理由を報告に明記して
> ください。

実行したコマンドを書かせるのが肝で、呼び出し側は同じコマンドを 1 回打つだけで裏取り
できる。`scope: "open"` でも外れない（範囲の指示とは別の話なので）。`consult` には
添えない——read-only ではそもそも走らないため。

## claude バックエンドについて実測したこと（2.1.277 / Windows）

| 確かめたこと | 結果 |
|---|---|
| `--verbose` | `--output-format stream-json` は `--verbose` が無いと JSONL を吐かない。**静かに壊れる**ので無条件で付け、argv をテストで固定している |
| 委譲の禁止 | `--tools` に `Task` を含めなければサブエージェントは**物理的に存在しない**。codex では prompt で頼むしかなかったものが、ここでは強制できる。よって `SOLO_NOTE` は claude では添えない |
| 再帰の防止 | `--strict-mcp-config`（`--mcp-config` 無し）で `mcp_servers: []`。これが無いと子がこのサーバ自身を読み込む |
| effort | `low` / `medium` / `high` / `xhigh` / `max`。**`ultra` は無い**（codex にはある） |
| 孤児回収のマーカー | `-n <run_id>` が実プロセスのコマンドラインにそのまま現れる。`claude.exe` は node ラッパーではなく単一のネイティブプロセス |
| resume | 通常の argv に `--resume <id>` を足すだけ。`--model` / `--effort` / `--tools` もそのまま通る（codex の resume は `-s` / `-C` / `--color` を拒否する） |
| session_id | resume しても**同じ値**が返る。既存のセッション索引がそのまま使える |
| 認証 | `apiKeySource: "none"` = **前景セッションと同じサブスク枠**を消費する |

### 書き込みの制限は OS サンドボックスではない

ここが codex との最大の非対称。実測した挙動:

| モード | `node --test` | cwd の外への書き込み |
|---|---|---|
| `acceptEdits` | **拒否** | 拒否 |
| `acceptEdits` + `--allowedTools "Bash(node --test*)"` | **通る** | 拒否 |
| `bypassPermissions` | 通る | **通る（拘束が外れる）** |

- `acceptEdits` は Bash を「安全と判定できるコマンド」だけ自動承認する。`echo` や
  `git status --porcelain` は通るが、`node --test` は拒否される（`--permission-prompts none`
  なので承認者が居らず deny になる）。
- cwd の外への書き込みは、`Write` でも `Bash` でも、`node -e` で間接的に書こうとしても
  **すべて拒否された**。codex の `workspace-write` ほど強い保証ではないが、想定より近い。
- `bypassPermissions` にすると `printf > <cwd 外の絶対パス>` が**通ってしまう**ことを
  実測で確認した。拘束が完全に外れるので**採らない**。

したがって `apply` は **`acceptEdits`** で動かし、`apply` の応答にはこの非対称を注記として
添える。戻せることは「cwd が git 管理下であること」と応答に付く `git diff` が担保する。

### テストを走らせるには許可リストが要る

上のとおり `node --test` や `uv run pytest` は既定では拒否される。つまり claude の `apply`
では、そのままだと [`TEST_NOTE`](#作業範囲) を満たせない。許可するコマンドは利用者が
環境変数で宣言する:

```bash
AGENT_EXEC_CLAUDE_ALLOWED_TOOLS='Bash(node --test*)  Bash(uv run pytest*)'
```

**既定は空にしてある。** ここに何を書くかは「どのコマンドを無条件で実行してよいか」の
宣言そのものなので、こちらで埋めると利用者が意図しないコマンドが走る。未設定のときは
テストが拒否され、その事実が応答に出る:

```
⚠ 次の操作は許可されていないため実行されませんでした:
  - Bash: node --test
  許可するには AGENT_EXEC_CLAUDE_ALLOWED_TOOLS に追加してください（例: "Bash(node --test*)"）。
```

黙って「テストは走りませんでした」で終わらせないのが肝で、原因と直し方が同じ場所に出る。

### 親セッションの環境変数を子から消す

このサーバは Claude Code の子プロセスとして動くので、`CLAUDE_CODE_*` / `CLAUDECODE` /
`CLAUDE_PID` / `CLAUDE_EFFORT` が環境に入っている（実測で 10 個）。そのまま渡すと、子が
親のセッション ID や messaging socket を受け取り、`CLAUDE_EFFORT` は `--effort` と競合する。
`AGENT_EXEC_*` / `CODEX_MCP_*` も消す（子が万一このサーバを読み込んでも同じ `runs/` を
共有しないため）。

`ANTHROPIC_*` は**消さない**。利用者がどの認証で課金するかを勝手に変えないため。

## 外部レビューで直した 6 件（6.2.0）

6.1.1 に対する外部レビューで挙がったもの。いずれも実コードで裏を取ったうえで直し、
**修正前に落ちる回帰テストを 6 件足した**（ソースだけ戻して 140 中 134 pass に
なることを確認済み）。

| 直したこと | なぜ壊れていたか |
|---|---|
| **repo 予約の競合** | 使用中チェックと予約の間に `await acquireSlot` があり、同じ repo への 2 本がどちらも「未使用」と判定してから待機に入れた。予約を最初の `await` より前へ移した |
| **打ち切り中に SIGKILL が取り消される** | 親 CLI が SIGTERM で落ちると 1 秒後に `finalize` が走り、3 秒後の SIGKILL 予約を解除していた。SIGTERM を無視する孫が同じプロセスグループに残る。`record.killing` が立っている間は解除しない |
| **`result` に拒否・失敗が出ない** | `formatDenials()` が同期経路にしか無く、切り離した run では「テストを実行できなかった」が消えていた。記録にある denials 4 件のうち **3 件が切り離し経路**で、実害が出ていた。あわせて `meta.failure` も見るようにし、失敗イベント + exit 0 の食い違いも解消 |
| **セッション索引に `backend` が無い** | run 本体から引いていたため、prune で run が消えると `undefined` → codex 扱いになり、claude のセッションが「別の CLI で作られています」と拒否された。索引に書き、読み出し側でも優先する |
| **接続先の環境変数を巻き添えで消す** | `CLAUDE_CODE` の前方一致で消していたので `CLAUDE_CODE_USE_BEDROCK` 等まで落ちていた。前方一致をやめ、実測したセッション固有の変数を名指しで消す |
| **ダミーの実行権限** | `fake-claude.sh` が git 上 `100644`。クリーンな checkout では `EACCES` で claude のテストが起動できなかった |

環境変数の扱いだけ、判断の理由を書いておく。**失敗の重さが非対称**である。

- セッション固有の変数が消し漏れる → 子が自分のセッション ID を誤認する程度
- 接続先の変数を消してしまう → run そのものが意図と違う所へ行く

そのため前方一致（消しすぎる側）ではなく、名指し（消し漏れる側）に倒した。Claude Code が
新しいセッション変数を増やしたら `SCRUB_EXACT` に足す。

## モデルの問題にどう気づくか

**MCP サーバから利用者へ直接届く経路は無い。** stdout は JSON-RPC として呼び出し側の
エージェントへ渡り、stderr はどこにも表示されない（`/mcp` の接続エラー時や `--debug`
を除く）。つまり**利用者に届くのはエージェントが口に出したものだけ**で、そこには裁量が
ある。起動時のルーティングログも、実質は開発時にしか見えない。

そのため「利用者が聞いたらエージェントが答えられる」形を優先している。`runs` が
モデル・effort・所要時間・失敗理由を返すのはこのためで、これが無いと正しい tool を
呼んでも答えが返らず、エージェントが `meta.json` を自力で漁れるかどうかの運になる。

```
20260919-062802-424-rgsi  apply  state=failed  23m04s  gpt-6-astra/max (codex)  ...
    失敗: Selected model is at capacity. Please try a different model.
20260919-073205-880-tuab  apply  state=completed  50m53s  gpt-6-astra/max (codex)  ...
20260919-085725-835-9gat  consult  state=completed  13m51s  gpt-6-astra/xhigh (codex)  ...
```

`limit` を増やして並べると偏りが見える。実際この記録からは「`max` は `xhigh` の 2.5 倍
（中央値 26 分）かかっていて、失敗も `max` にだけ出ている」ことが読み取れた。1 run ずつ
見ていても気づけない類の問題である。

集計まではまだ入れていない。10〜20 件並べば人にもエージェントにも偏りは見えるので、
足りないと分かってから足す。

## クライアント側のタイムアウト

**Claude Code の MCP クライアントは、応答も通知も無いまま約 1,800 秒経つと呼び出しを
abort する**（実運用で `wait_ms=1800000` を指定して 1,813 秒の abort を観測）。そのため:

- `timeout_ms` と `wait_ms` の上限を **1,500,000 ms（25分）** に切っている
- `result` の待機中も `notifications/progress` を 15 秒ごとに送る
  （`_meta.progressToken` がある場合）

25 分を超えて待ちたい場合は、切り離したうえで `result` を繰り返し呼ぶ。

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
| `consult` | `false` | レビューは呼び出し側が回すので、内部で自走させない |
| `apply` | `false` | 実装は自分で進めてもらう |

どちらも既定で委譲しない。委譲させたいときだけ `delegate: true` を渡す。

なお `multi_agent_version` はモデルごとに違う（astra は v2 かつ
`multi_agent_reasoning_effort=xhigh`、luna は v1、gpt-5.5 は無し）。

## プロジェクト規則ファイル

**codex は `CLAUDE.md` を読まない。** 読むのは `AGENTS.md`（とグローバルの
`~/.codex/AGENTS.md`）。sandbox で見えていないのではなく、探すファイル名が違う。

**codex は cwd から project doc を探す。** `consult` / `apply` はどちらも
cwd が対象ディレクトリなので、対象の `AGENTS.md` はそのまま届く（実測で確認）。
`codex_verify` は cwd が使い捨ての workspace だったためこれが届かず、対象の `AGENTS.md`
をコピーして持ち込んでいたが、tool ごと廃したのでその仕掛けも無くなった。

`CLAUDE.md` が `AGENTS.md` への symlink になっているリポジトリでは同じ内容なので実害は
ないが、別ファイルとして内容が乖離していると、codex と Claude Code が別々の規則に従う。
その場合は `-c project_doc_fallback_filenames=[...]` を検討する（未検証）。

## 長時間の作業（最重要）

**`timeout_ms` は「打ち切る時間」ではなく「同期で待つ上限」である。** 超えても codex は
走り続け、応答には `run_id` とそこまでの報告が返る:

```
[apply] run_id=20260914-013045-a3f9 ... elapsed=1800.0s
session_id=01a09c8f-...（続きは resume_session_id に渡す）

⏳ 同期で待つ上限（1800000 ms）に達したので切り離しました。codex は実行を続けています。
進捗: command_execution=42 agent_message=3 / 直近=command_execution
記録: ~/.claude/agent-exec/runs/20260914-013045-a3f9
続きは result(run_id="20260914-013045-a3f9") で取得できます。

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
~/.claude/agent-exec/runs/
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

サーバを再起動して追跡が切れた run も、`status` / `result` が
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
sandbox が変わるので、応答に「consult のセッションを apply = workspace-write
で継続します」と明示する。

## 変更内容の確認

`apply` は**終了時点の git 状態**（変更ファイル一覧と `diff --stat`）を応答に添える。
codex のイベント形式に依存しないので、打ち切られた場合でも取得できる。

「この run が変えたぶん」だけを厳密に切り出すには開始時点の内容そのものを保存する必要が
あるため、そこまではやっていない。代わりに開始前から変更があったファイルには
`← run 開始前から変更あり` と印を付ける。開始前の変更を一覧から**除外**すると、
codex がそのファイルを追加編集した場合に消えてしまう（run 前から dirty だったという
理由だけで）。HEAD が動いた場合は、作業ツリーが clean でもその旨を表示する。

## 作業範囲

`apply` は既定（`scope: "strict"`）で、prompt の末尾に次の指示を添える:

> 指示された範囲のみを変更してください。範囲外で問題や弱点を見つけた場合は、その場で
> 修正せず、報告に「範囲外の気づき」として記載してください。

「抽出だけ」と指示したのに周辺を直され差し戻しになった事例があったため。`scope: "open"`
で外せる。テストの実行を求める指示（上記）は `scope` とは別系統なので、`open` でも残る。

## 登録

```bash
claude mcp add agent -s user -- node ~/projects/agent-tools/mcp-servers/agent-exec/server.mjs
claude mcp list   # ✔ Connected を確認
```

`consult` は read-only なので `permissions.allow` に入れてよい。`apply` は
書き込みが走るため、都度承認を勧める。

## テスト

```bash
cd ~/projects/agent-tools/mcp-servers/agent-exec && node --test test/*.test.mjs
```

実 Codex は呼ばず、`test/fake-codex.sh` を `CODEX_BIN` として差し替える。ダミーは
`--json` のイベント列を模し、環境変数で遅延・異常終了・孫プロセス・ファイル変更を再現する。
140 件。

**Windows では走らない。** ダミーが shebang 付きの `.sh` で、Windows は shebang を
実行できない（`spawn EFTYPE`）。spawn を伴わない検証は通るが、それ以外は全滅する。
WSL / Linux / macOS で実行すること。なお `core.autocrlf=true` の Windows で clone すると
`.sh` が CRLF になり、WSL 側でも `/usr/bin/env: 'bash\r'` で落ちる。repo 直下の
`.gitattributes` が `*.sh text eol=lf` で固定している。

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
現在: 6.2.0
```

| version | 変更 |
|---|---|
| 1.0.0 | 初版（consult / apply の 2 ツール、同期のみ） |
| 2.0.0 | `--json` へ移行、run の永続化、切り離し（detach）、会話継続、status/result/runs |
| 3.0.0 | `codex_verify` を追加、同じ repo での並行 apply を拒否 |
| 3.1.0 | `apply` の既定を gpt-5.6-luna / max に変更 |
| 3.2.0 | `codex_verify` の既定 effort を low に変更 |
| 3.3.0 | 同期で待つ上限を 25 分へ引き下げ、`result` の待機中も進捗通知を送る |
| 3.4.0 | `delegate` 引数を追加、codex 側のエラー（turn.failed）を応答に載せる |
| 3.5.0 | `codex_verify` が対象の AGENTS.md を workspace へ持ち込むよう修正 |
| 3.6.0 | `delegate: false` の指示文で、AGENTS.md の委譲指示との競合を明示的に解く |
| 3.7.0 | `consult` の `delegate` も既定 false に（3 ツールとも委譲しない） |
| 3.8.0 / 3.9.0 | （記録漏れ。コードは 3.9.0 だったが、この表は 3.7.0 で止まっていた） |
| 4.0.0 | `codex_verify` を削除。`model` / `reasoning_effort` を tool 引数から外し、環境変数のみに。`apply` にテスト実行と申告の指示を追加 |
| 5.0.0 | `codex-exec` → `agent-exec` に改名（tool 名も `consult` / `apply` / …）。CLI 固有の部分を `lib/backends/` のアダプタへ分離。環境変数を `AGENT_EXEC_*` へ（旧名も読む）。生死判定を 3 値化 |
| 6.0.0 | `claude -p` を追加。**モデル名で起動する CLI が決まる**（`backend` 引数は作らない）。claude では委譲を argv で禁止し、拒否された操作を応答に載せる。backend をまたぐ resume を拒否 |
| 6.0.1 | Windows でコンソールウィンドウが明滅する問題を修正（`git.mjs` に `windowsHide`、`currentBootId()` をキャッシュ。prune が 25 run で PowerShell を 25 回起こしていた） |
| 6.1.0 | `runs` にモデル・effort・所要時間・失敗理由・記録の場所を出す（「どのモデルで問題が起きているか」を聞かれたとき、記録はあるのに答えられなかった） |
| 6.1.1 | `consult` の説明文をレビュー役として書き直す（記録では用途の 100% がレビューで、調査は 0 件だった）。tool 説明から codex 固有の表現を除く |
| 6.2.0 | 外部レビューで挙がった 6 件を修正（下記）。repo 予約の競合、打ち切り中の SIGKILL 取り消し、`result` に拒否・失敗が出ない、セッション索引の `backend` 欠落、接続先の環境変数の巻き添え削除、ダミーの実行権限 |

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `CODEX_BIN` | `codex` | codex 実行ファイル |
| `CODEX_HOME` | `~/.codex` | `models_cache.json` の探索先 |
| `CLAUDE_BIN` | `claude` | claude 実行ファイル |
| `AGENT_EXEC_CLAUDE_ALLOWED_TOOLS` | （空） | claude で無条件に許すコマンド。テストを走らせるために要る（[上記](#テストを走らせるには許可リストが要る)）。2 個以上の空白かカンマ区切り |
| `AGENT_EXEC_RUNS_DIR` | `~/.claude/agent-exec/runs` | run の記録先（clone の外に置く） |
| `AGENT_EXEC_CONSULT_MODEL` | `gpt-6-astra` | `consult` のモデル |
| `AGENT_EXEC_CONSULT_EFFORT` | `xhigh` | `consult` の effort |
| `AGENT_EXEC_APPLY_MODEL` | `gpt-5.6-luna` | `apply` のモデル |
| `AGENT_EXEC_APPLY_EFFORT` | `max` | `apply` の effort |
| `AGENT_EXEC_MAX_CONCURRENCY` | `3` | 同時に走らせる codex の本数 |
| `AGENT_EXEC_MAX_RUNS` | `50` | 保持する run の件数 |
| `AGENT_EXEC_PRUNE_GRACE_MS` | `120000` | 完了直後の run を保護する時間 |
| `AGENT_EXEC_PRUNE_DELAY_MS` | `10000` | run 完了から prune までの遅延 |
| `AGENT_EXEC_HARD_LIMIT_MS` | `7200000` | 1 run の絶対上限（2時間）。超えたら強制的に打ち切る |

**5.0.0 で `CODEX_MCP_*` を `AGENT_EXEC_*` に改名した。** 旧名も読むが、読んだときは
stderr に warning を出す。端末ごとにセットアップする運用では「片方の端末だけ旧名のまま」
が必ず起きるので、黙って無視せず気づけるようにしてある。`CODEX_BIN` と `CODEX_HOME` は
codex というバックエンド固有の設定なので改名していない。

記録先も `~/.claude/codex-exec/runs` → `~/.claude/agent-exec/runs` に変わった。新パスが
無くて旧パスがある端末では**旧パスを使い続ける**（勝手に切り替えると、既存の run と
セッション索引が消えたように見えて resume が全部切れる）。移行は `mv` 一発:

```bash
mv ~/.claude/codex-exec ~/.claude/agent-exec
```

モデル / effort の環境変数に**空文字**を渡すと「既定なし」になり、`~/.codex/config.toml`
に委ねる。

環境変数は**その端末だけの上書き**である（→ [どこで変えるか](#どこで変えるか)）。
既存サーバの `env` を書き換えるサブコマンドは無いので、登録し直すか `~/.claude.json` を
直接編集する:

```bash
claude mcp remove agent -s user
claude mcp add agent -s user \
  -e AGENT_EXEC_APPLY_MODEL=gpt-6-astra \
  -- node ~/projects/agent-tools/mcp-servers/agent-exec/server.mjs
```

全端末で揃えたい場合はここではなく `TOOL_MODES` を変える。

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
- **走っているかの判定**: 追跡が切れた run は、まず終端の証跡（`meta.terminal_seen`、
  無ければ events）を見る。証跡があればそれが最も確かなので「完了」とする。無ければ
  身元確認つきの生存判定へ進む。逆順にすると、PID 再利用で**終わった run が永久に
  実行中に見え**、呼び出し側が無限にポーリングする。
- **生死判定は 3 値**: `alive` / `dead` / **`unknown`**。マーカーを argv に確認できない
  まま起動した run は `unknown` を返す。ここで `dead` に倒すと、実際には走っている run に
  「報告が記録されていません」と**断言**してしまい、呼び出し側が失敗と判断して高価な
  （apply なら破壊的な）再実行に走る。prune は `unknown` を残し、孤児回収は触らず、
  `status` / `result` は「まだ動いているかもしれません」と返す。
- **argv マーカーはアダプタの義務**: 孤児回収の身元確認は「そのプロセスの argv に
  run_id が含まれる」ことに依存している。codex では `-o <runs>/<run_id>/last-message.txt`
  が偶然それを保証していた。アダプタに `marker` を申告させ、**engine が起動前に argv へ
  実際に現れるか検証する**。満たさなければ `reclaimable: false` を記録して警告し、
  その run は回収対象から外す（誤爆して無関係なプロセスグループを巻き込むより、
  取り逃がす方を選ぶ）。
- **終端フラグの後方互換**: 5.0.0 で `meta.turn_completed`（codex のイベント名がそのまま
  漏れていた）を `meta.terminal_seen` に改めた。書くときは両方、読むときも両方見る。
  これは「PID 再利用で終わった run が永久に実行中に見える」問題への唯一の対策なので、
  移行中に落とすと呼び出し側が無限ポーリングする。
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
- **Windows でコンソールを出さない**: このサーバは stdio をパイプで繋がれた子として動く
  ので、自分のコンソールを持たない。その状態で `git.exe` や `powershell.exe` を起こすと、
  Windows が**新しいコンソールウィンドウを作る**（画面が明滅する）。子プロセスを起こす
  箇所には必ず `windowsHide: true` を付ける。`git.mjs` にこれが無く、`apply` のたびに
  git を 6 回呼んでウィンドウが明滅していた。
- **起動時刻はキャッシュする**: `currentBootId()` は Windows で PowerShell を起こすため
  **1 回 350ms** かかる（実測）。キャッシュが無いと `prune` が保持 run の数だけ呼ぶので、
  25 run で 9 秒近くかかっていた。このプロセスが生きている間は値が変わらないので、
  一度引いたら覚える（`null` も「引けなかった」という結果として覚える）。
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
  git 差分がどちらのものか分からなくなる。`consult` は読むだけなので並行して使える。
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
  長時間の apply でも `status` が重くならないようにするため。
- **未知ツール・引数不正**: JSON-RPC の `-32602` ではなく `isError: true` の結果として返す。
  呼び出し側の LLM が内容を読んで自己修正できるようにするため（意図的な選択）。
- **イベントの解釈**: 実測できているのは `thread.started` / `turn.started` /
  `item.completed` / `turn.completed` と `item.type = agent_message` の `text` だけ。
  未知の item は type を数えるに留め、中身の解釈は `events.jsonl` に委ねている。
- **進捗通知**: `tools/call` に `_meta.progressToken` があれば 15 秒ごとに
  `notifications/progress` を送る。受信の有無は stderr に記録するので、Claude Code が
  これを送るかどうかは実利用のログで確認できる。
