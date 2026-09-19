#!/usr/bin/env bash
# テスト用のダミー claude。`claude -p --output-format stream-json --verbose` の出力を
# 模し、受け取った引数と stdin を記録する。
#
# fake-codex.sh と共通部分があるが、source せずコピーしている。shebang 付き .sh を
# 増やすのは承知のうえで、ファイル間の依存を増やして CRLF / 実行権限の問題を
# 広げるより、それぞれ独立に読める方を選んだ。
#
# 環境変数で挙動を変える:
#   CLAUDE_FAKE_EXIT          終了コード
#   CLAUDE_FAKE_SLEEP         イベントを出した後に待つ秒数
#   CLAUDE_FAKE_NO_EVENTS     JSONL イベントを出さない
#   CLAUDE_FAKE_NO_RESULT     result に本文を載せない（last-message.txt が書かれない経路）
#   CLAUDE_FAKE_ERROR_RESULT  result を is_error で返す
#   CLAUDE_FAKE_MCP_LEAK      init の mcp_servers を非空にする（再帰検知の確認）
#   CLAUDE_FAKE_TASK_TOOL     init の tools に Task を混ぜる（委譲禁止の綻び検知）
#   CLAUDE_FAKE_SUBAGENTS     result の subagent_stats.spawned に入れる数
#   CLAUDE_FAKE_DENIAL        result の permission_denials に 1 件入れる（コマンド名）
#   CLAUDE_FAKE_WEIRD         壊れた行・未知イベント・巨大な thinking / text を出す
#   CLAUDE_FAKE_TOUCH         cwd 配下のこのパスへ追記する（git 差分の確認用）
#   CLAUDE_FAKE_ORPHAN        stdout を握ったまま別プロセスグループへ逃げる孫（秒数）
#   CLAUDE_FAKE_SESSION_ID    init で返す session_id
#   CLAUDE_FAKE_STDERR        stderr へ出す文字列
set -u
: "${CLAUDE_FAKE_ARGV_FILE:=/dev/null}"
: "${CLAUDE_FAKE_STDIN_FILE:=/dev/null}"
: "${CLAUDE_FAKE_SESSION_ID:=2a09c9a8-ac59-4508-b9ea-8dddcd38aaf2}"
printf '%s\n' "$@" > "$CLAUDE_FAKE_ARGV_FILE"
printf '%s\n' "$PWD" > "${CLAUDE_FAKE_PWD_FILE:-/dev/null}"
# 子に漏れてはいけない環境変数が消えているかを確認するため、見えている分を記録する。
if [ -n "${CLAUDE_FAKE_ENV_FILE:-}" ]; then
  env | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AGENT_EXEC_|CODEX_MCP_)' \
    > "$CLAUDE_FAKE_ENV_FILE" || true
fi
cat > "$CLAUDE_FAKE_STDIN_FILE"

# 親の stdout を継いだまま別セッションへ逃げる孫。これが居ると close は発火しない。
if [ -n "${CLAUDE_FAKE_ORPHAN:-}" ]; then
  setsid bash -c "sleep ${CLAUDE_FAKE_ORPHAN}" &
fi

mcp_servers='[]'
if [ -n "${CLAUDE_FAKE_MCP_LEAK:-}" ]; then
  mcp_servers='[{"name":"agent","status":"connected"}]'
fi
tools='["Read","Grep","Glob"]'
if [ -n "${CLAUDE_FAKE_TASK_TOOL:-}" ]; then
  tools='["Read","Grep","Glob","Task"]'
fi

# イベントは先に出す。打ち切られても「ここまでの報告」が残ることを再現する。
if [ -z "${CLAUDE_FAKE_NO_EVENTS:-}" ]; then
  printf '{"type":"system","subtype":"init","session_id":"%s","tools":%s,"mcp_servers":%s,"apiKeySource":"none","model":"claude-haiku-4-5"}\n' \
    "$CLAUDE_FAKE_SESSION_ID" "$tools" "$mcp_servers"
  printf '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"考えている"}]},"session_id":"%s"}\n' "$CLAUDE_FAKE_SESSION_ID"
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]},"session_id":"%s"}\n' "$CLAUDE_FAKE_SESSION_ID"
  printf '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]},"session_id":"%s"}\n' "$CLAUDE_FAKE_SESSION_ID"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"PARTIAL_REPORT"}]},"session_id":"%s"}\n' "$CLAUDE_FAKE_SESSION_ID"
  printf '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.12}}}}\n'
fi

# 作業したことにして cwd 配下のファイルを変える（git 差分の確認用）
if [ -n "${CLAUDE_FAKE_TOUCH:-}" ]; then
  printf 'changed by fake claude\n' >> "$CLAUDE_FAKE_TOUCH"
fi

# 壊れた行・未知イベント・巨大な本文をわざと出す
if [ -n "${CLAUDE_FAKE_WEIRD:-}" ]; then
  printf 'this is not json at all\n'
  printf '{"type":"totally_unknown_event"}\n'
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{}}]}}\n'
  big=$(head -c 300000 /dev/zero | tr '\0' 'A')
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$big"
fi

if [ -n "${CLAUDE_FAKE_SLEEP:-}" ]; then
  sleep "$CLAUDE_FAKE_SLEEP"
fi

denials='[]'
if [ -n "${CLAUDE_FAKE_DENIAL:-}" ]; then
  denials=$(printf '[{"tool_name":"Bash","tool_input":{"command":"%s"}}]' "$CLAUDE_FAKE_DENIAL")
fi
subagents="${CLAUDE_FAKE_SUBAGENTS:-0}"

if [ -z "${CLAUDE_FAKE_NO_EVENTS:-}" ]; then
  if [ -n "${CLAUDE_FAKE_ERROR_RESULT:-}" ]; then
    printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"%s","api_error_status":400,"num_turns":1,"permission_denials":%s,"subagent_stats":{"spawned":%s}}\n' \
      "$CLAUDE_FAKE_ERROR_RESULT" "$denials" "$subagents"
  elif [ -n "${CLAUDE_FAKE_NO_RESULT:-}" ]; then
    printf '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":100,"output_tokens":20},"total_cost_usd":0.01,"num_turns":3,"permission_denials":%s,"subagent_stats":{"spawned":%s}}\n' \
      "$denials" "$subagents"
  else
    printf '{"type":"result","subtype":"success","is_error":false,"result":"FAKE_ANSWER","usage":{"input_tokens":100,"output_tokens":20},"total_cost_usd":0.01,"num_turns":3,"permission_denials":%s,"subagent_stats":{"spawned":%s}}\n' \
      "$denials" "$subagents"
  fi
fi

if [ -n "${CLAUDE_FAKE_STDERR:-}" ]; then
  printf '%s\n' "$CLAUDE_FAKE_STDERR" >&2
fi
exit "${CLAUDE_FAKE_EXIT:-0}"
