# 中继一键部署：从一台新服务器到手机能连

这是 **P3「部署降到一条命令」** 的前半部分：把「服务器初始化 → 装中继 → nginx + 证书」
压成三步。照着做，最后手机打开 `https://你的域名/taskwatch` 就能用。

> **先选路径（30 秒版）**：已经有现成的 `dsh-in-hand-relay` 和中继模板，不需要从零写。
> 最省力的路径是**复用**仓库里的 systemd 单元、nginx 模板与安装脚本；不复用就得自己维护
> 三份容易写错、且安全相关的配置。验收标准：`check-relay.sh` 五项全 OK，手机能加载首页
> 并看到会话；不要求真的在新服务器上跑一遍（见文末「未验证」）。

---

## 前提（缺一不可）

| 你需要 | 说明 |
|---|---|
| 一台有公网 IP 的 Linux | 模板按 Debian 12 / Ubuntu 22.04+ 写；**1 核 1G 够用**。本次只做了模板级静态检查，没有在全新机器上跑过。 |
| 一个域名 + A 记录 | 例如 `dsh.example.com` → 服务器公网 IP。生效检查：`dig +short dsh.example.com`。 |
| 本机已有 DSH | `dsh-in-hand` 插件已装，且 DSH Web **固定监听 3080**。验证：`curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/taskwatch` 应回 `200`。端口怎么固定见主 README 的「DSH Web 端口固定为 3080」。 |
| 能从本机 SSH 到服务器 | 反向隧道由**你的电脑**主动连出，服务器不需要访问你的电脑。 |

本文用两个占位符，阅读时全局替换（邮箱是可选设置）：

- `dsh.example.com` → 你的域名（**不是真实部署**）
- `203.0.113.10` → 你的服务器 IP
- 证书续期失败通知邮箱（可选；本文用 `--register-unsafely-without-email` 跳过）

---

## 它长什么样

```text
手机 / 外网
  └─ HTTPS  https://dsh.example.com        nginx：TLS 终止、关 SSE 缓冲
       └─ http://127.0.0.1:3099            中继：令牌鉴权 + 路径白名单
            └─ http://127.0.0.1:3080       服务器上的 sshd 反向隧道端口
                 └─ ssh -R 隧道            由你的电脑主动连出
                      └─ 127.0.0.1:3080    DSH Web（dsh-in-hand 插件）
```

三个关键决定：

1. **中继跑在服务器上**，不在你家电脑上。这样公网入口只有 nginx 的 443，
   中继和隧道都只听 `127.0.0.1`；升级中继不用回家开电脑。
2. **反向隧道搬到 3080**（不是 3099）。服务器上的 `3080` 是 sshd 开的回环端口，
   中继的 `RELAY_UPSTREAM` 就指向它。
3. **中继有自己的令牌**，和 DSH 插件无关。它管的是「谁能通过这个公网入口」，
   手机第一次用令牌或 6 位配对码换一张 30 天 cookie。

> 本插件自己**不做鉴权**，只监听回环。所以 **绝对不要把 DSH 的 3080 直接暴露到公网**，
> 公网只能经过中继这一层。

---

## 第 1 步：服务器初始化

SSH 登录服务器（下面的命令都在服务器上跑）：

```bash
ssh root@203.0.113.10
```

装依赖、开防火墙、建 certbot 的 webroot：

```bash
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx git curl openssl ufw
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
mkdir -p /var/www/certbot
systemctl enable --now nginx
```

> **云服务器还要开安全组**：阿里云 / 腾讯云 / AWS 的控制台里放行入站 `80` 和 `443`。
> `ufw` 只管系统防火墙，管不到云平台那一层 —— 这是「本机 curl 通、外面打不开」最常见的原因。

装 Node.js（中继要求 ≥ 18，建议 20；已经有就跳过）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v
```

确认端口规划（**只应看到 80/443 对外**，3080/3099 后面才会出现，且都只听回环）：

```bash
ss -ltnp
```

---

## 第 2 步：装中继

先下载安装脚本、systemd 单元和两个配套文件（前两者必须放在同一目录）：

```bash
mkdir -p /tmp/taskwatch-deploy && cd /tmp/taskwatch-deploy
BASE=https://raw.githubusercontent.com/dingchenhui0618-arch/dsh-in-hand/main/docs/deploy
for f in install-relay.sh taskwatch-relay.service nginx.conf.example check-relay.sh; do
  curl -fsSLO "$BASE/$f"
done
sudo bash install-relay.sh
```

> **从旧方案迁移**：如果服务器上已经有一条 `ssh -R 127.0.0.1:3099:...` 的老隧道，
> 它占着 3099。新方案把 3099 交给服务器上的中继、隧道改用 3080，所以先停掉老隧道
> （或改 `RELAY_PORT`），否则安装脚本会以「3099 已被占用」退出。

脚本会做这些事（重复执行是安全的，**不会重新生成令牌**）：

- 建系统用户 `taskwatch`（无登录 shell）和目录 `/opt/taskwatch-relay`、`/var/lib/taskwatch-relay`；
- 把中继仓库浅克隆到 `/opt/taskwatch-relay`；
- 生成 `/etc/taskwatch-relay/env`（**权限 600、root 所有**），其中：
  - `RELAY_UPSTREAM=http://127.0.0.1:3080` —— 指向宿主的反向隧道端口；
  - `RELAY_BIND=127.0.0.1`、`RELAY_PORT=3099` —— 只监听回环；
  - `RELAY_TOKEN=...` —— 中继自己的令牌；
- 装 `/etc/systemd/system/taskwatch-relay.service` 并 `systemctl enable --now`。

### 中继的 token 从哪来、放哪、权限多少

- **从哪来**：安装脚本用 `openssl rand -base64 32` 生成 32 字节随机数，再转成
  base64url（`+`→`-`、`/`→`_`、去掉 `=`，共 43 个字符），这样能直接放进 `?k=` 查询串。
  脚本里**没有任何默认令牌**，也不从网络获取。
- **放哪**：`/etc/taskwatch-relay/env` 的 `RELAY_TOKEN=` 一行。systemd 以 root 读这个文件，
  再把进程降权到 `taskwatch`，所以文件可以是 `600 root:root`，服务仍然读得到。
- **权限**：`600`，属主 `root:root`。**不要**把它放进仓库、聊天记录、截图或 shell 历史。
- 查看（会打印密钥，注意别录屏）：

  ```bash
  sudo sed -n 's/^RELAY_TOKEN=//p' /etc/taskwatch-relay/env
  ```

- **换令牌** = 改这一行 + `sudo systemctl restart taskwatch-relay`。换完所有手机都要重新配对。

### 建反向隧道（在**你自己的电脑**上跑，不是在服务器上）

先确认本机 DSH 在 3080 上：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/taskwatch
```

应回 `200`。然后保持这条命令常驻（Windows / macOS / Linux 的 OpenSSH 都一样）：

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:3080:127.0.0.1:3080 root@203.0.113.10
```

要点：

- `-R 127.0.0.1:3080:...` 的**前半段必须显式写 `127.0.0.1`**，让服务器上的监听只开在回环；
  别写成 `-R 3080:...`，否则可能绕过 nginx 把这层直接暴露出去。
- `ExitOnForwardFailure=yes`：服务器端口被占时立刻失败，不会留一条「连上了但没转发」的假隧道。
- `ServerAliveInterval/CountMax`：家里宽带换 IP、NAT 过期、电脑睡眠后，SSH 自己能发现死连接。
- 电脑睡眠 / 断网后这条命令会退出，**需要重新执行**。要长期常驻，交给 systemd（Linux/WSL）
  或任务计划程序（Windows），本指南不展开。

在服务器上验证隧道（应回 `200`；回 `000`/`502` 说明隧道或 DSH 没起来）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/taskwatch
```

验证中继本身：

```bash
curl -sS http://127.0.0.1:3099/healthz
sudo systemctl status taskwatch-relay --no-pager
```

`/healthz` 应回 `ok`，服务应是 `active (running)`。

### 告诉中继公网入口

编辑 env，把 `RELAY_PUBLIC_URL` 填成你的 HTTPS 入口（不填也能从 `Host` 头学，但显式写更稳）：

```bash
sudo sed -i 's#^RELAY_PUBLIC_URL=.*#RELAY_PUBLIC_URL=https://dsh.example.com#' /etc/taskwatch-relay/env
sudo systemctl restart taskwatch-relay
```

> `RELAY_UPSTREAM` 是**启动时**读取的模块常量，改完必须重启才生效。

---

## 第 3 步：nginx（TLS + 反代 + SSE 关缓冲）

### 3.1 先把证书签下来（HTTP-only 引导）

完整的 443 配置引用证书文件，而证书文件还不存在 —— 所以先放一个只有 80 的临时配置，
用 certbot 的 webroot 模式签发，签完再换成正式配置。

```bash
sudo tee /etc/nginx/conf.d/taskwatch.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name dsh.example.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }
}
EOF
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d dsh.example.com \
  --agree-tos --register-unsafely-without-email --no-eff-email
```

成功后会看到 `/etc/letsencrypt/live/dsh.example.com/fullchain.pem` 与 `privkey.pem`。
**把上面的 `dsh.example.com` 全部换成你的域名**（包括 certbot 的 `-d`）。

> 想收「证书快过期」的邮件通知：去掉 `--register-unsafely-without-email`，换成
> `-m 你的邮箱`（certbot 会用它注册 ACME 账号）。本文默认不留邮箱，续期仍然照常自动跑。

### 3.2 换成完整配置

```bash
sudo curl -fsSL "https://raw.githubusercontent.com/dingchenhui0618-arch/dsh-in-hand/main/docs/deploy/nginx.conf.example" -o /etc/nginx/conf.d/taskwatch.conf
DOMAIN=dsh.example.com
sudo sed -i "s/dsh\.example\.com/$DOMAIN/g" /etc/nginx/conf.d/taskwatch.conf
sudo nginx -t
sudo systemctl reload nginx
```

正式配置里必须保留这几行（它们是「页面不刷新」的根因，删了就会出现逐字输出变成
「转圈到最后一起出来」）：

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
proxy_http_version 1.1;
```

还要保留 `X-Forwarded-For` —— 中继靠它判断「这不是本机直连」，否则会把公网请求当成
本机，配对码就可能暴露给互联网。

### 3.3 续期

certbot 包自带 systemd timer，签一次之后自动续。验证：

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

---

## 手机第一次怎么进

两条路，选一条：

### A. 用中继令牌（最快）

在手机浏览器打开（把 `<RELAY_TOKEN>` 换成第 2 步查到的 43 位令牌）：

```text
https://dsh.example.com/taskwatch?k=<RELAY_TOKEN>
```

中继会校验令牌、种一张 30 天 HttpOnly cookie，然后 302 到不带 `?k=` 的干净地址。
之后「添加到主屏幕」即可。**这个 URL 等于密码，别发到群里。**

### B. 用 6 位配对码（令牌不离开服务器）

6 位码只在**本机直连**中继时显示。在**你自己的电脑**上开一条本地转发
（用 13099，避免和你电脑上已有的 3099 中继冲突）：

```bash
ssh -N -L 13099:127.0.0.1:3099 root@203.0.113.10
```

浏览器打开 `http://127.0.0.1:13099/taskwatch/pair`，页面上会出现 6 位码。
手机打开 `https://dsh.example.com/taskwatch`，会跳到配对页，输入这 6 位码即可。
配对码 **2 分钟有效、最多试 5 次、只能用一次**；换到的 cookie 30 天、每次访问滑动续期。

---

## 自检：`check-relay.sh`

脚本只发 GET、不改配置、不重启服务，**失败时也不会回显令牌**。

在服务器上（能读 `600` 的 env）：

```bash
sudo bash /tmp/taskwatch-deploy/check-relay.sh https://dsh.example.com
```

在别的机器上（避免令牌进 shell 历史）：

```bash
read -rsp '中继令牌: ' RELAY_TOKEN; echo; export RELAY_TOKEN
bash check-relay.sh https://dsh.example.com
```

也可以指定 env 文件：

```bash
bash check-relay.sh https://dsh.example.com --token-file /path/to/env
```

预期输出五行 `OK`（退出码 0）：

| 检查 | 期望 | 失败时先看 |
|---|---|---|
| `/healthz` | `200` | DNS / 证书 / nginx 有没有转发这条路径 |
| `/taskwatch`（带 Bearer） | `200` 或 `302` | `401` 令牌；`404` location；`502` 上游 |
| `/taskwatch/data`（带 Bearer） | `200` + `application/json` | 中继到 DSH 的隧道 |
| `/taskwatch/manifest.webmanifest` | `200` + manifest 类型 | 中继本地 `public/` 是否完整 |
| `/taskwatch/icon-192.png` | `200` + `image/png` | 同上 |

手工复核（不打印令牌）：

```bash
curl -sS https://dsh.example.com/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://dsh.example.com/taskwatch
sudo journalctl -u taskwatch-relay -n 50 --no-pager
```

`/taskwatch` 不带 cookie 时应回 **302**（跳配对页），不是 200 —— 这是正常的。

---

## 三条最常见的故障

### 1）502 Bad Gateway

先分清 502 是哪一段发的：

| 现象 | 断在哪 | 处置 |
|---|---|---|
| 响应头 **没有** `x-taskwatch-hop` | nginx → 中继 | `curl http://127.0.0.1:3099/healthz`；不是 `ok` 就 `systemctl status taskwatch-relay`、`journalctl -u taskwatch-relay -n 50` |
| 响应头有 `x-taskwatch-hop: relay` | 中继 → DSH | 中继活着，是隧道/DSH 断了。服务器上 `ss -ltnp \| grep 3080` 应看到 sshd；`curl http://127.0.0.1:3080/taskwatch` 应回 200 |
| 手机反复看到 502，服务端已恢复 | 手机 service worker 缓存 | 强制刷新 / 清站点数据；v1.6.0 起只缓存 2xx，但旧缓存可能还在 |

最常见的根因就两个：**本机 DSH 没开**（或 3080 被别的程序占了），**隧道断了**（电脑睡眠、
换网、SSH 退出）。先 `curl http://127.0.0.1:3080/taskwatch`，再看 `RELAY_UPSTREAM` 有没有写错
端口（改完要重启中继）。

### 2）401 Unauthorized

401 只可能是「令牌或票据」这一层：

- URL 里的 `?k=` 被聊天软件截断、复制少了字符（令牌是 43 位）；
- `/etc/taskwatch-relay/env` 里的 `RELAY_TOKEN` 和手机用的不是同一个（换过令牌但没重启，
  或旧设备的 cookie 还在）；
- 手机浏览器清了 cookie，重新打开 `?k=` 地址或走一次配对码即可。

```bash
sudo systemctl restart taskwatch-relay
sudo journalctl -u taskwatch-relay -n 30 --no-pager
```

不要靠「多试几次」绕过 401 —— 那说明令牌本来就不对。

### 3）页面不刷新 / SSE 被 nginx 缓冲

现象：对话回复不是逐字出现，而是**停很久后整段一次性出现**；审批卡、状态条也不动，
手动刷新才更新。这不是插件的问题，是中间层把 `text/event-stream` 缓冲了。

检查正式配置的 `/taskwatch/chat/stream` 和 `/taskwatch/` 两段都有：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 1h;
proxy_send_timeout 1h;
proxy_http_version 1.1;
gzip off;                 # 只放在 stream 那段
```

改完 `sudo nginx -t && sudo systemctl reload nginx`。

如果域名前面还套了 CDN / WAF（Cloudflare 等），也要关掉它对 SSE 的缓冲/压缩；否则
nginx 这层关了也没用。中继自己会发 `x-accel-buffering: no`，但 nginx 的
`proxy_buffering` 是更硬的一层。

---

## 升级 / 卸载

升级中继代码（不改 env、不重新生成令牌）：

```bash
sudo git -C /opt/taskwatch-relay pull --ff-only
sudo systemctl restart taskwatch-relay
```

卸载（只动本指南装的东西）：

```bash
sudo systemctl disable --now taskwatch-relay
sudo rm -f /etc/systemd/system/taskwatch-relay.service
sudo systemctl daemon-reload
# 确认不再需要后再删：
# sudo rm -rf /opt/taskwatch-relay /etc/taskwatch-relay /var/lib/taskwatch-relay
```

nginx 配置与证书不在卸载脚本里，按需自行删除 `/etc/nginx/conf.d/taskwatch.conf`。

---

## 安全边界（部署完请复核）

- **只对公网开 80/443**。`3099`（中继）和 `3080`（隧道）必须只听 `127.0.0.1`：
  `ss -ltnp | grep -E ':3080|:3099'` 的地址列不应是 `0.0.0.0`。
- **令牌 = 这个入口的密码**。拿到它就等于拿到你电脑上的一个终端（DSH 默认
  `danger-full-access`）。不要提交、不要贴聊天、不要放截图。
- **access log 不记查询串**：模板用 `$uri` 而不是 `$request`，避免首次配对的 `?k=` 落盘。
  但 nginx 的 `error_log` 在出错时可能带请求行，排障后不要把日志原样外发。
- **插件没有鉴权**，所以公网唯一入口必须是中继；不要把 3080 映射到公网。
- 服务器只跑中继，不存会话、不存文件内容；中继只按白名单转发固定路径。

---

## 未验证（如实说明）

- **没有真的拿一台新服务器从头跑一遍**：模板、单元、脚本只做了静态检查
  （`bash -n`、`systemd-analyze verify`、独立最小 nginx 配置的 `nginx -t`），
  没有执行 `install-relay.sh`、没有签真证书、没有在手机上完成首次配对。
- **certbot 首次签发的交互细节**：不同版本/发行版对邮箱、条款、`--nginx` vs `--webroot`
  的提示不完全一样；本文用非交互参数绕开，但没在全新机器上实测。
- 云厂商安全组、CDN/WAF 的界面各不相同，本文只写原则（放行 80/443、关 SSE 缓冲）。
