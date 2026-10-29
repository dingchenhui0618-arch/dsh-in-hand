#!/usr/bin/env bash
# ============================================================================
#  taskwatch-relay 只读自检
#
#    sudo bash check-relay.sh https://dsh.example.com
#    RELAY_TOKEN=... bash check-relay.sh https://dsh.example.com
#    bash check-relay.sh https://dsh.example.com --token-file /path/to/env
#
#  只发 GET；不改配置、不重启服务、不写服务器文件。
#  **绝不打印令牌**：失败信息里只有 HTTP 状态和建议。
#
#  退出码：0 全部通过 / 1 有失败 / 2 用法或令牌问题
# ============================================================================
set -uo pipefail

usage() {
  cat <<'EOF'
用法:
  check-relay.sh https://你的域名 [--token-file /path/to/env]

令牌来源（按顺序）:
  1. 环境变量 RELAY_TOKEN
  2. --token-file 指定的文件里的 RELAY_TOKEN=...
  3. /etc/taskwatch-relay/env（在服务器上跑时）

例:
  sudo bash check-relay.sh https://dsh.example.com
  read -rsp '中继令牌: ' RELAY_TOKEN; echo; export RELAY_TOKEN
  bash check-relay.sh https://dsh.example.com
EOF
}

BASE=""
TOKEN_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    http://*|https://*) BASE=$1; shift ;;
    --token-file)
      [ $# -ge 2 ] || { echo "错误：--token-file 需要一个路径" >&2; exit 2; }
      TOKEN_FILE=$2; shift 2 ;;
    *) echo "错误：未知参数 $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$BASE" ] || { usage >&2; exit 2; }
BASE=${BASE%/}
# 允许直接贴带 /taskwatch 的入口地址。
case "$BASE" in
  */taskwatch) BASE=${BASE%/taskwatch} ;;
esac

command -v curl >/dev/null 2>&1 || { echo "错误：没有 curl" >&2; exit 2; }

read_token_from() {
  [ -r "$1" ] || return 1
  # 去掉可能存在的引号，兼容 RELAY_TOKEN="..." 这种写法。
  awk '/^RELAY_TOKEN=/ {
         sub(/^RELAY_TOKEN=/, "");
         gsub(/^["\047]|["\047]$/, "");
         print; exit
       }' "$1" | tr -d '\r'
}

TOKEN=${RELAY_TOKEN:-}
if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
  TOKEN=$(read_token_from "$TOKEN_FILE" || true)
fi
if [ -z "$TOKEN" ] && [ -r /etc/taskwatch-relay/env ]; then
  TOKEN=$(read_token_from /etc/taskwatch-relay/env || true)
fi
if [ -z "$TOKEN" ]; then
  echo "FAIL 没有可用的中继令牌。" >&2
  echo "     在服务器上请用 sudo；在别处请设 RELAY_TOKEN，或用 --token-file 指向 env。" >&2
  exit 2
fi

# 输出小工具。注意：任何分支都不打印 $TOKEN。
OK=0
FAIL=0
pass() { printf '  OK   %-36s %s\n' "$1" "$2"; OK=$((OK + 1)); }
fail() {
  printf '  FAIL %-36s %s\n' "$1" "$2"
  FAIL=$((FAIL + 1))
  if [ -n "${3:-}" ]; then printf '       建议：%s\n' "$3"; fi
}

hint() {
  case "$1" in
    000) echo "连不上：检查 DNS、证书、云安全组/防火墙；先 curl -v $BASE/healthz。" ;;
    401) echo "令牌不对或没带上；见 README 的「401」一节，重开 ?k= 地址。" ;;
    403) echo "被 nginx allow/deny、云 WAF 或 TLS 校验拦了。" ;;
    404) echo "nginx 没有这条路径的 location，或中继路由/本地文件缺失。" ;;
    502|503|504) echo "中继或上游没起来：服务器上 curl http://127.0.0.1:3099/healthz，再查 3080 隧道。" ;;
    301|302|307|308) echo "被重定向了；检查 80→443 规则是否误伤了这条路径。" ;;
    *) echo "HTTP $1；对照 README 的「三条最常见故障」。" ;;
  esac
}

# 返回 "<状态码> <content-type>"，不读响应体。
probe() {
  local url=$1 auth=${2:-0} out
  if [ "$auth" = 1 ]; then
    out=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code} %{content_type}' \
      -H "Authorization: Bearer $TOKEN" "$url" 2>/dev/null) || out='000 -'
  else
    out=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code} %{content_type}' \
      "$url" 2>/dev/null) || out='000 -'
  fi
  [ -n "$out" ] || out='000 -'
  printf '%s' "$out"
}

split_probe() {
  CODE=${1%% *}
  CTYPE=${1#* }
  [ "$CTYPE" = "$1" ] && CTYPE='-'
}

is_prefix() {
  case "$2" in
    "$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "自检目标：$BASE"
echo "（令牌只用于请求头，不会打印）"
case "$BASE" in
  http://*) echo "提示：http 不是安全上下文；PWA / 离线壳只在 https 下可用。" ;;
esac
echo

# 1) /healthz：免鉴权，任何能到 80/443 的人都能看，但只回 "ok"。
r=$(probe "$BASE/healthz"); split_probe "$r"
if [ "$CODE" = 200 ]; then
  pass "/healthz" "200"
else
  fail "/healthz" "HTTP $CODE" "$(hint "$CODE")"
fi

# 2) 页面：带 Bearer 可以直接 200；不带 cookie 时 302 去配对页也算正常。
r=$(probe "$BASE/taskwatch" 1); split_probe "$r"
case "$CODE" in
  200|302) pass "/taskwatch（带 Bearer）" "$CODE" ;;
  *) fail "/taskwatch（带 Bearer）" "HTTP $CODE" "$(hint "$CODE")" ;;
esac

# 3) 数据：真正能证明「中继 -> 隧道 -> DSH」这段通了。
r=$(probe "$BASE/taskwatch/data" 1); split_probe "$r"
if [ "$CODE" = 200 ] && is_prefix 'application/json' "$CTYPE"; then
  pass "/taskwatch/data（带 Bearer）" "200 application/json"
elif [ "$CODE" = 200 ]; then
  fail "/taskwatch/data（带 Bearer）" "200 但 content-type=$CTYPE" "上游返回的不是 JSON；看 DSH 是否在 3080、插件是否挂载。"
else
  fail "/taskwatch/data（带 Bearer）" "HTTP $CODE" "$(hint "$CODE")"
  if [ "$CODE" = 502 ]; then
    # 502 分两段：nginx->中继，还是中继->DSH。中继自己发的 502 带这个头。
    HOP=$(curl -sS --max-time 20 -D - -o /dev/null \
      -H "Authorization: Bearer $TOKEN" "$BASE/taskwatch/data" 2>/dev/null \
      | tr -d '\r' | awk 'tolower($1)=="x-taskwatch-hop:" { print $2; exit }' || true)
    if [ -n "$HOP" ]; then
      printf '       来源：x-taskwatch-hop=%s（中继活着，问题在它到 DSH 的上游）\n' "$HOP"
    else
      printf '       来源：没有 x-taskwatch-hop（问题在 nginx 到中继这一段）\n'
    fi
  fi
fi

# 4) PWA manifest：中继本地文件，不经过 DSH。
r=$(probe "$BASE/taskwatch/manifest.webmanifest" 1); split_probe "$r"
if [ "$CODE" = 200 ] && is_prefix 'application/manifest+json' "$CTYPE"; then
  pass "/taskwatch/manifest.webmanifest" "200 manifest"
else
  fail "/taskwatch/manifest.webmanifest" "HTTP $CODE $CTYPE" "$(hint "$CODE")"
fi

# 5) 图标：同样来自中继本地 public/。
r=$(probe "$BASE/taskwatch/icon-192.png" 1); split_probe "$r"
if [ "$CODE" = 200 ] && is_prefix 'image/png' "$CTYPE"; then
  pass "/taskwatch/icon-192.png" "200 image/png"
else
  fail "/taskwatch/icon-192.png" "HTTP $CODE $CTYPE" "$(hint "$CODE")"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "全部通过（$OK 项）。"
  exit 0
fi
echo "有 $FAIL 项失败（通过 $OK 项）。按上面的建议逐项排查。"
exit 1
