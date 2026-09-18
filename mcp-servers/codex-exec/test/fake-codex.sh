#!/usr/bin/env bash
# テスト用のダミー codex。`codex exec --json` の出力を模し、受け取った引数と stdin を
# 記録する。環境変数で挙動を変える:
#   CODEX_FAKE_EXIT        終了コード
#   CODEX_FAKE_SLEEP       イベントを出した後に待つ秒数
#   CODEX_FAKE_NO_OUTPUT   -o のファイルに最終メッセージを書かない
#   CODEX_FAKE_NO_EVENTS   JSONL イベントを出さない
#   CODEX_FAKE_TURN_FAILED turn.failed を出す（API エラーの再現）
#   CODEX_FAKE_WEIRD      壊れた行・未知 item・巨大行を出す
#   CODEX_FAKE_TOUCH       cwd 配下のこのパスへ追記する（git 差分の確認用）
#   CODEX_FAKE_ORPHAN      stdout を握ったまま別プロセスグループへ逃げる孫を作る（秒数）
#   CODEX_FAKE_THREAD_ID   thread.started で返す id
#   CODEX_FAKE_STDERR      stderr へ出す文字列
set -u
: "${CODEX_FAKE_ARGV_FILE:=/dev/null}"
: "${CODEX_FAKE_STDIN_FILE:=/dev/null}"
: "${CODEX_FAKE_THREAD_ID:=01a09c85-9969-7611-97f2-0d00bf50a7f9}"
printf '%s\n' "$@" > "$CODEX_FAKE_ARGV_FILE"
if [ -n "${CODEX_FAKE_ENV_FILE:-}" ]; then
  env | grep -E '^(UV_CACHE_DIR|XDG_CACHE_HOME|TMPDIR|PYTHONDONTWRITEBYTECODE|PYTEST_ADDOPTS)=' \
    > "$CODEX_FAKE_ENV_FILE" || true
fi
printf '%s\n' "$PWD" > "${CODEX_FAKE_PWD_FILE:-/dev/null}"
cat > "$CODEX_FAKE_STDIN_FILE"

out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# 親の stdout を継いだまま別セッションへ逃げる孫。これが居ると close は発火しない。
if [ -n "${CODEX_FAKE_ORPHAN:-}" ]; then
  setsid bash -c "sleep ${CODEX_FAKE_ORPHAN}" &
fi

# イベントは先に出す。打ち切られても「ここまでの報告」が残ることを再現する。
if [ -z "${CODEX_FAKE_NO_EVENTS:-}" ]; then
  printf '{"type":"thread.started","thread_id":"%s"}\n' "$CODEX_FAKE_THREAD_ID"
  printf '{"type":"turn.started"}\n'
  printf '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls"}}\n'
  printf '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PARTIAL_REPORT"}}\n'
fi

# 作業したことにして cwd 配下のファイルを変える（git 差分の確認用）
if [ -n "${CODEX_FAKE_TOUCH:-}" ]; then
  printf 'changed by fake codex\n' >> "$CODEX_FAKE_TOUCH"
fi

# 壊れた行・未知 item type・巨大行をわざと出す
if [ -n "${CODEX_FAKE_WEIRD:-}" ]; then
  printf 'this is not json at all\n'
  printf '{"type":"item.completed","item":{"id":"w1","type":"file_change","changes":[]}}\n'
  printf '{"type":"totally_unknown_event"}\n'
  big=$(head -c 300000 /dev/zero | tr '\0' 'A')
  printf '{"type":"item.completed","item":{"id":"w2","type":"agent_message","text":"%s"}}\n' "$big"
fi

if [ -n "${CODEX_FAKE_SLEEP:-}" ]; then
  sleep "$CODEX_FAKE_SLEEP"
fi

if [ -n "${CODEX_FAKE_TURN_FAILED:-}" ]; then
  # codex は API のエラー本文を JSON 文字列のまま載せてくる
  printf '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"message\\":\\"%s\\"}}"}}\n' "$CODEX_FAKE_TURN_FAILED"
elif [ -z "${CODEX_FAKE_NO_EVENTS:-}" ]; then
  printf '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}\n'
fi
if [ -n "$out" ] && [ -z "${CODEX_FAKE_NO_OUTPUT:-}" ]; then
  printf 'FAKE_ANSWER' > "$out"
fi
if [ -n "${CODEX_FAKE_STDERR:-}" ]; then
  printf '%s\n' "$CODEX_FAKE_STDERR" >&2
fi
exit "${CODEX_FAKE_EXIT:-0}"
