#!/usr/bin/env bash
#
# hbook —— 一键启动。
#
# 做五件事：确认数据库在、停掉上一个实例、编译、用对的环境变量起服务、等到它真的能回话为止。
#
#   ./start-reader.sh              重启（默认）
#   ./start-reader.sh --port 8080  换个端口
#   ./start-reader.sh --stop       只停
#   ./start-reader.sh --status     只看状态
#   ./start-reader.sh --no-build   不编译（改了 bff/src 才需要编译）
#
# 为什么不用 npm start：它不带 WEB_ROOT，服务器会去发上游那个完整应用（要登录），
# 而不是 reader 应用。环境变量在这里写死，端口、数据库地址都可以用环境变量覆盖。
#
# 服务用 setsid 起 —— 它自己成为一个会话的领头人，父 shell 退出时不会被连坐杀掉。
# 没有这一步，网站会随着启动它的终端一起消失。

set -euo pipefail

# 自己的位置（跟着符号链接走），仓库根目录就是脚本所在的地方。
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(dirname "$SELF")"
BFF="$ROOT/bff"

# 本机的 .env（.gitignore 里，不进版本库）可以放 DATABASE_URL 之类的本地设置：compose 用它，
# 本机跑也用它。带不带引号都行（shell 认得 KEY="value"）。
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
DATABASE_URL="${DATABASE_URL:-postgres://hbook:hbook@127.0.0.1:5432/hbook}"
WEB_ROOT="${WEB_ROOT:-$ROOT/reader}"
NOVEL_SOURCES_PATH="${NOVEL_SOURCES_PATH:-$ROOT/novel-sources}"
# The Cloudflare solver. Most of the Chinese manga sites put a challenge in front of their pages, and
# a challenge cannot be answered without a browser. Run FlareSolverr (docker run -p 8191:8191
# ghcr.io/flaresolverr/flaresolverr:latest) and point this at it; without it, the sites that answer
# a plain GET still work and the ones behind a challenge do not.
FLARESOLVERR_URL="${FLARESOLVERR_URL:-http://127.0.0.1:8191}"
LOG="${LOG:-}"
PIDFILE=""

DO_BUILD=1
DO_STOP=1
DO_START=1
STATUS_ONLY=0

# 用 while 而不是 for：for 的循环体无视 shift，所以 `--port 8080` 里的 8080 会被当成
# 另一个参数，再报一次"不认识的参数"。
while [ $# -gt 0 ]; do
  case "$1" in
    --port)      PORT="${2:?--port 需要一个端口号}"; shift 2 ;;
    --port=*)    PORT="${1#*=}"; shift ;;
    --stop)      DO_START=0; shift ;;
    --status)    STATUS_ONLY=1; DO_STOP=0; DO_START=0; shift ;;
    --restart)   DO_STOP=1; DO_START=1; shift ;;
    --no-build)  DO_BUILD=0; shift ;;
    -h|--help)   sed -n '3,20p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

# 日志和 pid 文件的名字要等端口定下来才能算 —— 参数是在上面才改的 PORT。
[ -n "$LOG" ] || LOG="/tmp/hbook-reader-$PORT.log"
[ -n "$PIDFILE" ] || PIDFILE="/tmp/hbook-reader-$PORT.pid"

say()  { printf '\033[36m•\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# 我们自己的实例是哪些
#
# 命令行只有 `node dist/server.js`，看不出是哪个仓库的 —— 所以看它的工作目录。这台机器上可能
# 同时跑着别的 hbook，不该被这个脚本动。
# ---------------------------------------------------------------------------------------------
our_pids() {
  local p cmd cwd
  for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    # 进程随时可能退出，所以整个替换都要静音 —— 光给 tr 加 2>/dev/null 不够，
    # shell 自己在重定向失败时也会报错。
    cmd=$( { tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null ) || continue
    case "$cmd" in
      "node dist/server.js "*|"node dist/server.js")
        cwd=$(readlink "/proc/$p/cwd" 2>/dev/null) || continue
        [ "$cwd" = "$BFF" ] && echo "$p" ;;
    esac
  done
  return 0
}

port_owner() {
  # 谁占着这个端口。从 /proc/net/tcp 拿 inode，再对回 /proc/*/fd。
  local hexport inode pid
  hexport=$(printf '%04X' "$PORT")
  inode=$(awk -v p=":$hexport" '$4=="0A" && $2 ~ p"$" {print $10}' /proc/net/tcp 2>/dev/null | head -1)
  [ -n "$inode" ] || return 1
  for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    if ls -l "/proc/$pid/fd" 2>/dev/null | grep -q "socket:\[$inode\]"; then
      echo "$pid $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-70)"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------------------------
if [ "$STATUS_ONLY" = 1 ]; then
  pids=$(our_pids)
  if [ -n "$pids" ]; then
    say "运行中：PID $(echo "$pids" | tr '\n' ' ')"
  else
    say "没在运行"
  fi
  if curl -fsS -m 5 "http://$HOST:$PORT/api/reader/sources" >/dev/null 2>&1; then
    say "接口有回音：http://$HOST:$PORT"
  else
    warn "接口没回音（服务可能刚起，或端口不对）"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 数据库
#
# 数据库是**必需的**：服务器启动时跑迁移，连不上就直接退出。所以这里得把它拉起来。
#
# 读漫画和读小说都只走那些规则源，不查库；但迁移、阅读日志、下载、备份都在库里。
# DATABASE_URL 指向别处（Docker 里的 Postgres）时，那就不是本机的事，这里只负责确认它通。
# ---------------------------------------------------------------------------------------------
db_host() { echo "${DATABASE_URL#*://}" | cut -d@ -f2 | cut -d: -f1 | cut -d/ -f1; }
db_port() { echo "${DATABASE_URL#*://}" | cut -d@ -f2 | cut -d: -f2 | cut -d/ -f1; }
db_host=$(db_host); db_port=$(db_port)
[ -n "$db_host" ] || db_host=127.0.0.1
[ -n "$db_port" ] || db_port=5432

db_up() { pg_isready -h "$db_host" -p "$db_port" >/dev/null 2>&1; }

if ! db_up; then
  # 只有本机才管得着；有 service 才拉得动。
  if [ "$db_host" = "127.0.0.1" ] || [ "$db_host" = "localhost" ] || [ "$db_host" = "::1" ]; then
    if command -v service >/dev/null 2>&1 && [ -x /etc/init.d/postgresql ]; then
      say "拉起 Postgres…"
      service postgresql start >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do db_up && break; sleep 0.5; done
    fi
  fi
fi

if ! db_up; then
  die "数据库连不上（$db_host:$db_port）。
   本机的话：service postgresql start
   或者把 DATABASE_URL 指到别处，例如 postgres://hbook:密码@主机:5432/hbook"
fi

# ---------------------------------------------------------------------------------------------
# 停
# ---------------------------------------------------------------------------------------------
if [ "$DO_STOP" = 1 ]; then
  pids=$(our_pids)
  if [ -n "$pids" ]; then
    # 停的是**本仓库的所有实例**，不只当前这个端口上的那个：换端口起服务时，
    # 旧的那个还在跑，两份一起抢数据库和规则源没有好处。
    say "停掉 PID $(echo "$pids" | tr '\n' ' ')（本仓库的所有实例）"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
  [ -f "$PIDFILE" ] && rm -f "$PIDFILE"

  # 端口要等它真的松开。上一次就撞过 EADDRINUSE：进程退了，socket 还在。
  for _ in $(seq 1 20); do
    pids=$(our_pids)
    [ -z "$pids" ] && ! port_owner >/dev/null && break
    sleep 0.5
  done
  if owner=$(port_owner); then
    die "端口 $PORT 还被别的东西占着：$owner
   先把它停掉，或者换个端口：./start-reader.sh --port 8080"
  fi
fi

[ "$DO_START" = 0 ] && exit 0

# ---------------------------------------------------------------------------------------------
# 编译
# ---------------------------------------------------------------------------------------------
if [ "$DO_BUILD" = 1 ]; then
  say "编译…"
  (cd "$BFF" && npm run build) >/tmp/hbook-build.log 2>&1 || {
    cat /tmp/hbook-build.log >&2
    die "编译失败（上面是输出）"
  }
fi
[ -f "$BFF/dist/server.js" ] || die "没有 $BFF/dist/server.js —— 去掉 --no-build 再跑一次"

# ---------------------------------------------------------------------------------------------
# 起
#
# 静态文件是在**注册时**扫目录建路由的：往 reader/ 里加了新文件，不重启是看不到的。
# 所以这个脚本每次都是完整重启，而不是热重载。
# ---------------------------------------------------------------------------------------------
say "启动（端口 $PORT，前端 $WEB_ROOT）…"
mkdir -p "$(dirname "$LOG")"
cd "$BFF"

# setsid 让服务自己成为一个会话的领头人：**父 shell 一退出，它不会被连坐杀掉。**
#
# 这一步不是锦上添花。之前用 `nohup ... &` 起的服务，活不过启动它的那个终端会话——
# 会话一结束，整个进程组被清掉，网站就"自己挂了"。setsid 把它从那个进程组里摘出来。
if command -v setsid >/dev/null 2>&1; then
  setsid env \
    NODE_ENV=production \
    PORT="$PORT" \
    HOST="$HOST" \
    WEB_ROOT="$WEB_ROOT" \
    NOVEL_SOURCES_PATH="$NOVEL_SOURCES_PATH" \
    SOURCE_DIRECT_FETCH="${SOURCE_DIRECT_FETCH:-1}" \
    DATABASE_URL="$DATABASE_URL" \
    FLARESOLVERR_URL="$FLARESOLVERR_URL" \
    node dist/server.js >"$LOG" 2>&1 &
else
  nohup env \
    NODE_ENV=production \
    PORT="$PORT" \
    HOST="$HOST" \
    WEB_ROOT="$WEB_ROOT" \
    NOVEL_SOURCES_PATH="$NOVEL_SOURCES_PATH" \
    SOURCE_DIRECT_FETCH="${SOURCE_DIRECT_FETCH:-1}" \
    DATABASE_URL="$DATABASE_URL" \
    FLARESOLVERR_URL="$FLARESOLVERR_URL" \
    node dist/server.js >"$LOG" 2>&1 &
fi

pid=$!

# 等它真的能回话，而不是"进程还活着就算起来了"。
for _ in $(seq 1 40); do
  if curl -fsS -m 3 "http://$HOST:$PORT/api/reader/sources" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$pid" 2>/dev/null || {
    tail -25 "$LOG" >&2
    # 数据库认证失败是本地最常见的一种：角色改了名，密码没改。给它一句能直接抄的命令。
    if grep -q "auth_failed\|password authentication failed" "$LOG" 2>/dev/null; then
      printf '\n'
      warn "数据库认不出这个用户。角色是 hbook，密码得对上："
      printf '   su postgres -c "psql -c \\"ALTER ROLE hbook WITH PASSWORD \x27hbook\x27\\""\n'
      printf '   或者把 .env 里的 DATABASE_URL 改成那个角色真正的密码。\n\n'
    fi
    die "服务起不来（上面是日志；完整日志在 $LOG）"
  }
  sleep 0.5
done

# pid 文件里写**真正的**那个 PID。
#
# setsid 会 fork：$! 是 setsid 自己的号，node 是它的儿子。所以 $! 记下来的是个马上就退出的进程，
# --status 会说"没在运行"，而服务其实好好地开着。这里从 /proc 里按工作目录把真正的 node 找出来。
real_pid=$(our_pids | head -1)
[ -n "$real_pid" ] && pid="$real_pid"
echo "$pid" > "$PIDFILE"

curl -fsS -m 5 "http://$HOST:$PORT/api/reader/sources" >/dev/null 2>&1 || {
  tail -25 "$LOG" >&2
  die "服务起来了但接口不答应（上面是日志）"
}

# 顺带报一下它手上有什么，省得再问一次。
info=$(curl -fsS -m 10 "http://$HOST:$PORT/api/reader/sources?adult=1" 2>/dev/null || echo '{}')
counts=$(printf '%s' "$info" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    console.log([(j.manga || []).length, j.novelCount ?? "?", j.workingNovels ?? "?"].join(" "));
  } catch { console.log("? ? ?"); }
});
' 2>/dev/null || echo "? ? ?")
read -r manga novels working <<<"$counts"

printf '\n'
printf '\033[36m•\033[0m hbook已就绪 → \033[1mhttp://%s:%s\033[0m\n' "$HOST" "$PORT"
printf '   PID %s · 日志 %s\n' "$pid" "$LOG"
printf '   漫画源 %s 个 · 小说源 %s 个（实测可用 %s 个）\n' "${manga:-?}" "${novels:-?}" "${working:-?}"
printf '\n'
say "停：./start-reader.sh --stop    看状态：./start-reader.sh --status"
printf '\n'
printf '   第一次打开若是旧的界面（底部有“离线”标签）：那是上游应用的 service worker\n'
printf '   还占着屏幕，刷新一次即可；还不行就用无痕窗口打开。\n\n'
