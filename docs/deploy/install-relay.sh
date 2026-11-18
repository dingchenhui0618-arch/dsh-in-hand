#!/usr/bin/env bash
# ============================================================================
#  taskwatch-relay 一键安装（Debian / Ubuntu）
#
#  ⚠️  先读 README：docs/deploy/README.md
#      这个脚本会改系统：建用户、写 /etc/taskwatch-relay/env、装 systemd
#      单元、systemctl enable --now。第一次跑之前请至少看懂 README 的
#      第 1、2 步。它**不会**替你装 nginx、不会签证书、不会 reload nginx。
#
#  幂等：重复执行不会重新生成令牌，不会覆盖已有 env，不会重复建用户。
#  卸载：见 README 的「升级 / 卸载」。
# ============================================================================
set -euo pipefail

APP_DIR=/opt/taskwatch-relay
CONF_DIR=/etc/taskwatch-relay
ENV_FILE=$CONF_DIR/env
STATE_DIR=/var/lib/taskwatch-relay
SVC_USER=taskwatch
SVC_NAME=taskwatch-relay
REPO_URL=${TASKWATCH_RELAY_REPO:-https://github.com/dingchenhui0618-arch/dsh-in-hand-relay.git}
UPSTREAM=${RELAY_UPSTREAM:-http://127.0.0.1:3080}
PUBLIC_URL=${RELAY_PUBLIC_URL:-}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }

# ── 扫码用到的票据密钥 ─────────────────────────────────────────────────────
# 插件 v1.9.0 起，桌面侧栏「手机配对」签的是一张 v3 换路票，画成二维码给手机扫；兑现方是
# **中继**。中继要认这张票，就得和插件宿主用同一个票据密钥（中继 v1.1.0 起支持）。两种给法：
#   TASKWATCH_TICKET_SECRET=<值> sudo -E bash install-relay.sh
#   sudo bash install-relay.sh --ticket-secret-file /tmp/taskwatch-ticket.key
# 不给也能装：手机仍然可以用 6 位码，只是扫出来的码会在中继这里 401 后落到配对页。
TICKET_SECRET=${TASKWATCH_TICKET_SECRET:-}
TICKET_SECRET_FILE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --ticket-secret-file)
      shift
      [ $# -gt 0 ] || die "--ticket-secret-file 需要一个文件路径"
      TICKET_SECRET_FILE=$1
      ;;
    *) die "不认识的参数：$1（只支持 --ticket-secret-file <path>）" ;;
  esac
  shift
done
if [ -z "$TICKET_SECRET" ] && [ -n "$TICKET_SECRET_FILE" ]; then
  [ -r "$TICKET_SECRET_FILE" ] || die "读不到 $TICKET_SECRET_FILE（先把插件那台机器上的 key 拷过来）"
  TICKET_SECRET=$(tr -d '\r\n' < "$TICKET_SECRET_FILE")
fi
if [ -n "$TICKET_SECRET" ] && [ "${#TICKET_SECRET}" -lt 32 ]; then
  die "票据密钥至少 32 个字符；它应该就是插件宿主 ~/.dsh/taskwatch-ticket.key 里的那一行"
fi
TICKET_SECRET_MISSING=0
SVC_WAS_ACTIVE=$(systemctl is-active "$SVC_NAME" 2>/dev/null || true)

# ── 基本检查 ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"
[ -r /etc/debian_version ] || die "这个脚本只在 Debian / Ubuntu 上验证过；其它发行版请按 README 手工执行。"
command -v systemctl >/dev/null 2>&1 || die "没有 systemd，无法安装服务。"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl：apt-get install -y openssl"

say "检查 Node.js"
command -v node >/dev/null 2>&1 || die "没装 Node.js。先按 README 第 1 步装 Node 20（中继要求 >= 18）。"
NODE_BIN=$(command -v node)
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node $(node -v) 太旧，中继要求 >= 18（建议 20）。"
echo "    node: $NODE_BIN ($(node -v))"

# 3099 被别的进程占着时，装完也起不来。最常见的是旧方案留下的 ssh -R 隧道。
if systemctl is-active --quiet "$SVC_NAME"; then
  echo "    已有 $SVC_NAME 在运行，跳过端口占用检查。"
elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE '[:.]3099$'; then
  die "3099 已被占用（可能是旧的 ssh -R 隧道或另一个中继）。先停掉它，或改 RELAY_PORT。"
fi

# ── 用户与目录 ─────────────────────────────────────────────────────────────
say "创建系统用户与目录"
if ! getent group "$SVC_USER" >/dev/null 2>&1; then
  groupadd --system "$SVC_USER"
fi
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SVC_USER" --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -m 0755 -o root -g root "$APP_DIR" "$CONF_DIR"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$STATE_DIR"

# ── 中继代码 ───────────────────────────────────────────────────────────────
if [ -f "$APP_DIR/server.mjs" ]; then
  say "中继代码已存在，跳过下载"
  echo "    升级：sudo git -C $APP_DIR pull --ff-only && sudo systemctl restart $SVC_NAME"
else
  command -v git >/dev/null 2>&1 || die "缺少 git：apt-get install -y git"
  say "下载中继代码到 $APP_DIR"
  # 目录此时是空的（install -d 刚建），git clone 允许克隆进已存在的空目录。
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

# ── 环境变量与令牌 ─────────────────────────────────────────────────────────
say "配置 $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  grep -qE '^RELAY_TOKEN=.+' "$ENV_FILE" || die "$ENV_FILE 里没有 RELAY_TOKEN；请补一行再重跑。"
  echo "    保留已有 env 与令牌（不会重新生成）。"
  if [ -n "$TICKET_SECRET" ]; then
    if grep -qE '^TASKWATCH_TICKET_SECRET=' "$ENV_FILE"; then
      sed -i "s#^TASKWATCH_TICKET_SECRET=.*#TASKWATCH_TICKET_SECRET=$TICKET_SECRET#" "$ENV_FILE"
    else
      printf 'TASKWATCH_TICKET_SECRET=%s\n' "$TICKET_SECRET" >> "$ENV_FILE"
    fi
    echo "    票据密钥已写入（扫码可兑现，与插件宿主同源）。"
  elif grep -qE '^TASKWATCH_TICKET_SECRET=.+' "$ENV_FILE"; then
    echo "    沿用已有票据密钥（扫码可兑现）。"
  else
    TICKET_SECRET_MISSING=1
  fi
else
  # 32 字节随机数 -> base64url（+ / = 换成 URL 安全字符），43 个字符。
  # 转换成 base64url 是为了能直接放进首次配对的 ?k= 查询串，不用再做百分号编码。
  TOKEN=$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
  umask 077
  cat > "$ENV_FILE" <<EOF
# taskwatch-relay 环境变量。systemd 以 root 读取本文件，再把进程降权到 $SVC_USER。
# 改完必须：sudo systemctl restart $SVC_NAME
# 本文件含令牌，权限必须是 600 root:root，不要提交到任何仓库。
RELAY_PORT=3099
RELAY_BIND=127.0.0.1
RELAY_UPSTREAM=$UPSTREAM
RELAY_TOKEN=$TOKEN
RELAY_PUBLIC_URL=$PUBLIC_URL
EOF
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if [ -n "$TICKET_SECRET" ]; then
    printf 'TASKWATCH_TICKET_SECRET=%s\n' "$TICKET_SECRET" >> "$ENV_FILE"
    echo "    已写入票据密钥（扫码可兑现）。"
  else
    TICKET_SECRET_MISSING=1
  fi
  echo "    已生成新令牌（43 字符，不显示）。"
fi
echo "    权限：$(stat -c '%a %U:%G' "$ENV_FILE")"

# 中继会把学到的公网入口写到代码目录的 .public-url；ProtectSystem=strict 下
# 代码目录只读，所以把这两个运行状态文件软链到可写的 /var/lib 下。
ln -sfn "$STATE_DIR/token" "$APP_DIR/.token"
ln -sfn "$STATE_DIR/public-url" "$APP_DIR/.public-url"
chown -h "$SVC_USER:$SVC_USER" "$APP_DIR/.token" "$APP_DIR/.public-url"

# ── systemd 单元 ───────────────────────────────────────────────────────────
say "安装 systemd 单元"
[ -f "$SCRIPT_DIR/taskwatch-relay.service" ] || \
  die "找不到 $SCRIPT_DIR/taskwatch-relay.service；请把 install-relay.sh 和它放在同一目录。"
install -m 0644 "$SCRIPT_DIR/taskwatch-relay.service" "/etc/systemd/system/$SVC_NAME.service"

# 单元文件按 NodeSource 的默认路径写成 /usr/bin/node；如果实际不在那里，改成本机路径。
if [ "$NODE_BIN" != "/usr/bin/node" ]; then
  sed -i "s#^ExecStart=/usr/bin/node #ExecStart=$NODE_BIN #" "/etc/systemd/system/$SVC_NAME.service"
  echo "    ExecStart 已改为 $NODE_BIN"
fi

systemctl daemon-reload
if ! systemctl enable --now "$SVC_NAME"; then
  journalctl -u "$SVC_NAME" -n 40 --no-pager || true
  die "$SVC_NAME 启动失败，先看上面的日志（常见原因：3099 被占、Node 路径不对）。"
fi

for _ in 1 2 3 4 5; do
  systemctl is-active --quiet "$SVC_NAME" && break
  sleep 1
done
if systemctl is-active --quiet "$SVC_NAME"; then
  say "服务已启动"
else
  journalctl -u "$SVC_NAME" -n 40 --no-pager || true
  die "$SVC_NAME 没起来，先看上面的日志。"
fi

# env 只在启动时读一次；已经跑着的服务不会因为改了 env 就换密钥。
if [ -n "$TICKET_SECRET" ] && [ "$SVC_WAS_ACTIVE" = "active" ]; then
  say "重启中继让新的票据密钥生效"
  systemctl restart "$SVC_NAME"
  sleep 1
  systemctl is-active --quiet "$SVC_NAME" || die "重启后服务没起来：journalctl -u $SVC_NAME -n 40"
fi

# ── 收尾提示 ───────────────────────────────────────────────────────────────
cat <<EOF

安装完成。接下来按 docs/deploy/README.md 做三件事：

  1. 在家里的电脑上建立反向隧道（不是在这台服务器上）：
       ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:3080:127.0.0.1:3080 root@<服务器IP>

  2. 确认公网入口（可选，但建议）：
       sudo sed -i 's#^RELAY_PUBLIC_URL=.*#RELAY_PUBLIC_URL=https://<你的域名>#' $ENV_FILE
       sudo systemctl restart $SVC_NAME

  3. 第 3 步：nginx + 证书。然后自检：
       sudo bash /tmp/taskwatch-deploy/check-relay.sh https://<你的域名>

令牌在 $ENV_FILE（600 root:root）。不要提交、不要贴聊天、不要放截图；
换令牌 = 改这一行 + systemctl restart，所有手机都要重新配对。
EOF

if [ "$TICKET_SECRET_MISSING" = "1" ]; then
  cat <<EOF

想用手机**扫码**直接进来（插件 v1.9.0 的侧栏「手机配对」），还差一步：
  服务器上这份中继要和插件宿主用同一个票据密钥。不配也能用 —— 手机走配对页输 6 位码，
  只是扫出来的码会在中继这里 401，然后落到配对页。

  1. 在**你自己电脑**上取出那一行：
       cat ~/.dsh/taskwatch-ticket.key
  2. 传到服务器，再重跑本脚本（幂等，不会重新生成令牌、不会丢已有配置）：
       scp ~/.dsh/taskwatch-ticket.key root@<服务器IP>:/tmp/taskwatch-ticket.key
       sudo bash install-relay.sh --ticket-secret-file /tmp/taskwatch-ticket.key
  3. 删掉传过去的那份副本：rm /tmp/taskwatch-ticket.key

  票据密钥是凭据（等于"能签一张 60 秒一次性换路票"的能力）：600 权限、不要提交、不要贴聊天。
  轮换它只作废还没兑换的票，已经发出去的 30 天 cookie 不受影响。
EOF
fi