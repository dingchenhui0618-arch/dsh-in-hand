#!/usr/bin/env node
/**
 * README 首屏 hero（1400×640，中英两张，白色底）。
 *
 * 构图：左边**电脑端的 DSH 窗口**，右边**手机端的掌上 DSH**，两台物件下方各一行小字
 * 说明「这是什么」，别让人猜。
 *
 * 右边手机屏里是**仓库里已有的真机截图**（docs/screenshots/current/session-new.png，
 * 由 scripts/make-shots.mjs 用真 Chrome + docs/demo.html 拍出来，390×844 @DPR2）：新会话
 * 首屏 —— 鲸鱼标 +「在这里跟我说话就行」+ 三个建议问题 + 底部输入框。外面只加一层
 * 设备框（7px 外框 + 33px 内圆角 + 1px 边 + 极浅投影）。
 *
 * 左边窗口是**照 DSH 桌面端真实布局渲染的**：左侧栏（鲸鱼 + deepseek + HARNESS 徽章、
 * 「+ 新会话」、插件 / 自动化任务、工作区树、底部账号），右侧主区（会话标题、用户气泡、
 * 「已思考」、正文、代码块、待批准卡、composer 里的 + / 工作区内修改 / 模型 / 发送）。
 * 内容用演示数据，主区标题右侧明写「演示数据 · 非真实状态」——它不是 DSH 的真截图。
 *
 * 底色是白的（用户 2026-11-10 要求：深色底太暗淡看不清），窗口靠 1px 描边 + 极浅投影
 * 立在白底上；不再出暗色版本。颜色全部取 lib/tokens.css 那套令牌的亮色侧。
 * 没有渐变、没有辉光、没有 3D；间距只走 4/8 栅格。
 *
 * 做法：真 Chrome headless + CDP，DPR2 渲染后按 clip.scale=0.5 缩到 1400×640，
 * 等于「2 倍渲染再降采样」——小字不糊，边缘有真正的抗锯齿。
 *
 * 用法：node scripts/make-hero.mjs
 * 输出：<仓库上级>\_ui-review\round33\hero-<lang>.png（PNG 只在审阅目录，
 *       webp 放 docs/assets/，转换命令见脚本末尾）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs', 'screenshots', 'current')
const OUT_REVIEW = join(ROOT, '..', '_ui-review', 'round33')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const W = 1400
const H = 640

// 电脑端窗口：880×528，左上角 (100,64)
const WIN = { x: 100, y: 64, w: 880, h: 528 }
const WIN_RAIL = 236
// 手机：外框 264×552，右上边与窗口齐平（x 靠右、底对齐到 592）
const BEZEL = 7
const DEV_W = 264
const DEV_H = 552
const DEV = { x: 1036, y: 40, w: DEV_W, h: DEV_H }
const CAPTION_Y = 604

const ICON = {
  collapse: '<path d="M3 4h10M3 8h6M3 12h10"/>',
  plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
  plug: '<path d="M6 2.6v3M10 2.6v3M4.2 5.6h7.6V9a3.8 3.8 0 0 1-7.6 0z"/><path d="M8 12.8v1.6"/>',
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.9V8l2.1 1.4"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2L14 14"/>',
  sliders: '<path d="M2.6 5.2h10.8M2.6 10.8h10.8"/><circle cx="6" cy="5.2" r="1.5"/><circle cx="10.4" cy="10.8" r="1.5"/>',
  newsq: '<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.4"/><path d="M8 5.4v5.2M5.4 8h5.2"/>',
  db: '<ellipse cx="8" cy="3.9" rx="4.6" ry="1.9"/><path d="M3.4 3.9v8.2c0 1 2 1.9 4.6 1.9s4.6-.9 4.6-1.9V3.9"/><path d="M3.4 8c0 1 2 1.9 4.6 1.9S12.6 9 12.6 8"/>',
  folder: '<path d="M2 5.1h4.2l1.3 1.6h6.5v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  person: '<circle cx="8" cy="6" r="2.4"/><path d="M3.2 13.6c0-2.4 2.1-3.8 4.8-3.8s4.8 1.4 4.8 3.8"/>',
  chevronR: '<path d="M6.2 3.4L10.6 8l-4.4 4.6"/>',
  chevronD: '<path d="M3.4 6.2L8 10.6l4.6-4.4"/>',
  panel: '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2"/><path d="M6.2 3.2v9.6"/>',
  branch: '<circle cx="4.6" cy="3.6" r="1.5"/><circle cx="4.6" cy="12.4" r="1.5"/><circle cx="11.4" cy="8" r="1.5"/><path d="M4.6 5.1v5.8"/><path d="M6.1 3.9h1.9a1.9 1.9 0 0 1 1.9 1.9v1.1"/>',
  send: '<path d="M8 13.2V3M3.7 7.3L8 3l4.3 4.3"/>',
  check: '<path d="M3 8.4l3.2 3.2L13 4.4"/>',
}
const icon = (name, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`

const COPY = {
  zh: {
    demo: '演示数据 · 非真实状态',
    brand: 'deepseek',
    newChat: '新会话',
    nav: [
      { icon: 'plug', t: '插件' },
      { icon: 'clock', t: '自动化任务' },
    ],
    wsTitle: '工作区',
    ws: [
      { icon: 'db', t: '默认工作区', head: true },
      { t: '重构支付模块的重试逻辑', on: true },
      { t: '给发布流程补一份可回滚检查' },
      { icon: 'folder', t: '数据分析项目' },
      { icon: 'folder', t: 'DSH 插件开发' },
    ],
    account: 'DeepSeek',
    title: '重构支付模块的重试逻辑',
    ask: '把支付模块的重试改成指数退避，最多撑 60 秒。',
    thought: '已思考',
    say: '改完了：基础 2 秒、上限 60 秒，保留最后一次失败的原始异常。',
    steps: '读取 3 个文件 · 运行 1 条命令 · 用时 12 秒',
    code: 'const delay = Math.min(60000, 2000 * 2 ** attempt)',
    cardBadge: '待批准',
    cardTool: 'pssh',
    cardText: '删除 build/cache 下的 3 个过期产物目录，需要你先确认。',
    cardMeta: '需要批准 · 重构支付模块的重试逻辑',
    wait: '剩余 01:52 · 120 秒无响应会退回桌面',
    allow: '批准一次',
    deny: '拒绝',
    input: '描述你想要构建的内容，/调用指令，@文件或对话',
    mode: '工作区内修改',
    model: 'DeepSeek-V41-Flash High',
    capWin: '电脑端 · DSH 桌面',
    capPhone: '手机端 · 掌上 DSH',
    altHome: '手机上的掌上 DSH 新会话：鲸鱼标、「在这里跟我说话就行」、三个建议问题与底部输入框',
  },
  en: {
    demo: 'Sample data · not a real session',
    brand: 'deepseek',
    newChat: 'New chat',
    nav: [
      { icon: 'plug', t: 'Plugins' },
      { icon: 'clock', t: 'Automations' },
    ],
    wsTitle: 'Workspaces',
    ws: [
      { icon: 'db', t: 'Default workspace', head: true },
      { t: 'Payment retry logic', on: true },
      { t: 'Rollback check' },
      { icon: 'folder', t: 'Data analysis' },
      { icon: 'folder', t: 'DSH plugin dev' },
    ],
    account: 'DeepSeek',
    title: 'Retry logic for the payment module',
    ask: 'Switch the payment retries to exponential backoff, 60s cap.',
    thought: 'Thought',
    say: 'Done: base 2s, cap 60s, and the last failure keeps its original exception.',
    steps: 'Read 3 files · ran 1 command · 12s',
    code: 'const delay = Math.min(60000, 2000 * 2 ** attempt)',
    cardBadge: 'Pending',
    cardTool: 'pssh',
    cardText: 'Delete 3 stale output folders under build/cache. This needs your confirmation.',
    cardMeta: 'Needs approval · retry logic for the payment module',
    wait: '01:52 left · falls back to the desktop after 120s',
    allow: 'Approve once',
    deny: 'Reject',
    input: 'Describe what to build, / for commands, @ for files or chats',
    mode: 'Edit in workspace',
    model: 'DeepSeek-V41-Flash High',
    capWin: 'Desktop · DSH',
    capPhone: 'Phone · DSH in Hand',
    altHome: 'A new conversation in DSH in Hand: the whale mark, "just talk to me here", three suggested questions and the composer',
  },
}

const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome：设置 CHROME_PATH 后重试')
  process.exit(2)
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), 8000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = (e) => { clearTimeout(t); reject(e) }
    })
    return new Cdp(ws)
  }
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }
  close() { try { this.ws.close() } catch { /* 已断开 */ } }
}

function dataUri(file) {
  return 'data:image/png;base64,' + readFileSync(join(SHOTS, file)).toString('base64')
}

function page({ lang }) {
  const c = COPY[lang]
  const shot = dataUri('session-new.png')
  const langAttr = lang === 'en' ? 'en' : 'zh-CN'
  const nav = c.nav.map((n) =>
    `<div class="nav">${icon(n.icon)}<span>${n.t}</span></div>`).join('')
  const ws = c.ws.map((s) => {
    const lead = s.icon ? icon(s.icon, 14) : '<span class="bullet"></span>'
    return `<div class="row${s.on ? ' on' : ''}${s.head ? ' head' : ''}">${lead}` +
      `<span class="t">${s.t}</span></div>`
  }).join('')
  return `<!doctype html><html lang="${langAttr}"><head><meta charset="utf-8">
<title>hero</title>
<style>
  /* 亮色令牌照抄 lib/tokens.css：白底 / #0f1115 字 / #61666b 次要 / #4176e6 只当发送键 */
  :root{
    --page:#ffffff; --win:#ffffff; --rail:#f7f7f8; --sel:#ececee;
    --h1:#0f1115; --body:#353638; --dim:#61666b; --faint:#81858c;
    --line:#0f11151f; --line-soft:#0f111514; --accent:#4176e6;
    --badge:#b9550a; --badge-bg:#fdf2e5;
    --shadow:0 1px 2px rgba(15,17,21,.06), 0 28px 56px -34px rgba(15,17,21,.34);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    position:relative;width:${W}px;height:${H}px;overflow:hidden;background:var(--page);color:var(--h1);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
      "Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;
  }
  .ic{flex:0 0 auto;display:block}
  /* ── 电脑端窗口 ───────────────────────────────────────────────── */
  .win{
    position:absolute;left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;
    border-radius:12px;overflow:hidden;display:flex;
    background:var(--win);border:1px solid var(--line);box-shadow:var(--shadow);
  }
  .rail{flex:0 0 ${WIN_RAIL}px;min-width:0;background:var(--rail);
    border-right:1px solid var(--line);display:flex;flex-direction:column;padding-bottom:8px}
  .rail-top{flex:0 0 auto;height:44px;display:flex;align-items:center;gap:8px;padding:0 16px}
  .dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto}
  .dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
  .rail-top .collapse{margin-left:auto;color:var(--faint)}
  .brand{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 16px;height:28px}
  .brand .logo{width:20px;height:20px;display:block;border-radius:6px;background:#fff;
    box-shadow:0 0 0 1px var(--line-soft)}
  .brand .wm{font-size:15px;font-weight:700;letter-spacing:-.02em;color:var(--h1);line-height:1}
  .brand .hb{font-size:9px;font-weight:600;letter-spacing:.13em;color:var(--dim);
    border:1px solid var(--line);border-radius:4px;padding:2px 5px;line-height:1.3}
  .newchat{flex:0 0 auto;margin:12px 16px 8px;height:32px;border-radius:8px;background:#fff;
    border:1px solid var(--line-soft);box-shadow:0 1px 2px rgba(15,17,21,.05);
    display:flex;align-items:center;justify-content:center;gap:6px;
    font-size:13px;font-weight:500;color:var(--h1)}
  .newchat .ic{color:var(--dim)}
  .navs{flex:0 0 auto;display:flex;flex-direction:column;gap:2px;padding:0 8px}
  .nav{height:28px;border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 8px;
    font-size:13px;color:var(--body)}
  .nav .ic{color:var(--dim)}
  .wshead{flex:0 0 auto;display:flex;align-items:center;gap:4px;margin:16px 16px 4px;
    height:16px;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--faint)}
  .wshead .tools{margin-left:auto;display:flex;gap:8px;color:var(--faint)}
  .tree{flex:0 0 auto;display:flex;flex-direction:column;gap:1px;padding:0 8px;min-height:0}
  .row{height:28px;border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 8px;
    font-size:13px;color:var(--body);min-width:0}
  .row.on{background:var(--sel);color:var(--h1)}
  .row.head{color:var(--h1);font-weight:500}
  .row .ic{color:var(--dim)}
  .row .bullet{width:14px;flex:0 0 14px}
  .row .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .rail-foot{margin-top:auto;flex:0 0 auto;display:flex;align-items:center;gap:8px;
    height:28px;padding:0 16px;font-size:13px;color:var(--body)}
  .avatar{width:22px;height:22px;border-radius:50%;background:#e4e5e7;color:var(--dim);
    display:grid;place-items:center;flex:0 0 auto}
  /* 主区 */
  .main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;background:var(--win)}
  .main-h{flex:0 0 auto;height:44px;display:flex;align-items:center;gap:8px;padding:0 16px}
  .main-h .ttl{font-size:13.5px;font-weight:600;color:var(--h1);overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .main-h .demo{font-size:11px;color:var(--faint);white-space:nowrap;
    margin-left:8px;padding-left:8px;border-left:1px solid var(--line)}
  .main-h .panel{margin-left:auto;color:var(--faint)}
  .main-b{flex:1 1 auto;min-height:0;overflow:hidden;padding:8px 20px 0;
    display:flex;flex-direction:column;gap:12px}
  .bubble{align-self:flex-end;max-width:76%;background:#f2f3f5;color:var(--h1);
    border-radius:12px;padding:8px 12px;font-size:13px;line-height:1.6}
  .think{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--faint)}
  .steps{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--faint)}
  .say{font-size:13px;line-height:1.7;color:var(--body)}
  .code{border:1px solid var(--line-soft);border-radius:8px;background:#fafafb;
    padding:7px 12px;font-family:"SF Mono","JetBrains Mono",Consolas,Menlo,monospace;
    font-size:11.5px;line-height:1.55;color:var(--body);white-space:nowrap;overflow:hidden}
  .card{border:1px solid var(--line);border-radius:10px;background:#fff;padding:12px 14px;
    display:flex;flex-direction:column;gap:8px}
  .card .r1{display:flex;align-items:center;gap:8px}
  .badge{flex:0 0 auto;padding:2px 8px;border-radius:999px;background:var(--badge-bg);
    color:var(--badge);font-size:11px;font-weight:600;line-height:1.5}
  .card .tool{font-size:13px;font-weight:600;color:var(--h1)}
  .card .txt{font-size:12.5px;line-height:1.6;color:var(--body)}
  .card .meta{font-size:11px;color:var(--dim)}
  .card .btns{display:flex;gap:8px}
  .btn{min-height:32px;min-width:92px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:600;
    display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line)}
  .btn.allow{background:var(--h1);color:#fff;border-color:transparent}
  .btn.deny{color:#c62828;border-color:#c6282855;background:transparent}
  .wait{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--faint)}
  /* composer：真实桌面端是一个圆角大框，里面一行占位 + 一行工具 */
  .composer{flex:0 0 auto;margin:8px 16px 12px;border:1px solid var(--line);border-radius:14px;
    background:#fcfcfd;padding:12px;display:flex;flex-direction:column;gap:8px}
  .composer .ph{font-size:13px;color:var(--faint);line-height:1.5;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .composer .tools{display:flex;align-items:center;gap:8px;height:26px}
  .cbtn{width:24px;height:24px;color:var(--dim);display:grid;place-items:center;flex:0 0 auto}
  .chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--dim);
    line-height:1.5;white-space:nowrap}
  .chip .ic{color:var(--faint)}
  .composer .model{margin-left:auto;font-size:11.5px;color:var(--faint);white-space:nowrap;
    display:inline-flex;align-items:center;gap:4px}
  .send{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--accent);
    color:#fff;display:grid;place-items:center;margin-left:4px}
  /* ── 手机端 ───────────────────────────────────────────────────── */
  .dev{
    position:absolute;left:${DEV.x}px;top:${DEV.y}px;width:${DEV.w}px;height:${DEV.h}px;
    padding:${BEZEL}px;border-radius:40px;background:#0f1115;
    box-shadow:0 0 0 1px var(--line), var(--shadow);
  }
  .dev img{display:block;width:100%;height:100%;border-radius:33px;
    object-fit:cover;object-position:top}
  /* ── 两行说明 ─────────────────────────────────────────────────── */
  .cap{position:absolute;top:${CAPTION_Y}px;font-size:12.5px;line-height:1.4;
    color:var(--dim);letter-spacing:.01em;white-space:nowrap}
  .cap.left{left:${WIN.x}px;width:${WIN.w}px;text-align:center}
  .cap.right{left:${DEV.x}px;width:${DEV.w}px;text-align:center}
</style></head>
<body>
  <div class="win">
    <div class="rail">
      <div class="rail-top">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="collapse">${icon('collapse')}</span>
      </div>
      <div class="brand"><img class="logo" src="/lib/icons/icon-192.png" alt="">
        <span class="wm">${c.brand}</span><span class="hb">HARNESS</span></div>
      <div class="newchat">${icon('plus', 14)}<span>${c.newChat}</span></div>
      <div class="navs">${nav}</div>
      <div class="wshead"><span>${c.wsTitle}</span><span class="tools">${icon('search', 13)}${icon('sliders', 13)}${icon('newsq', 13)}</span></div>
      <div class="tree">${ws}</div>
      <div class="rail-foot"><span class="avatar">${icon('person', 13)}</span><span>${c.account}</span></div>
    </div>
    <div class="main">
      <div class="main-h"><span class="ttl">${c.title}</span><span class="demo">${c.demo}</span>
        <span class="panel">${icon('panel')}</span></div>
      <div class="main-b">
        <div class="bubble">${c.ask}</div>
        <div class="think">${c.thought}${icon('chevronR', 11)}</div>
        <p class="steps">${icon('check', 11)}${c.steps}</p>
        <p class="say">${c.say}</p>
        <div class="code">${c.code}</div>
        <div class="card">
          <div class="r1"><span class="badge">${c.cardBadge}</span><span class="tool">${c.cardTool}</span></div>
          <p class="txt">${c.cardText}</p>
          <p class="meta">${c.cardMeta}</p>
          <div class="btns">
            <span class="btn allow">${c.allow}</span>
            <span class="btn deny">${c.deny}</span>
          </div>
        </div>
        <p class="wait">${icon('clock', 12)}${c.wait}</p>
      </div>
      <div class="composer">
        <div class="ph">${c.input}</div>
        <div class="tools"><span class="cbtn">${icon('plus', 13)}</span>
          <span class="chip">${icon('branch', 13)}${c.mode}${icon('chevronD', 11)}</span>
          <span class="model">${c.model}${icon('chevronD', 11)}</span>
          <span class="send">${icon('send', 14)}</span></div>
      </div>
    </div>
  </div>
  <div class="dev"><img src="${shot}" alt="${c.altHome}"></div>
  <div class="cap left">${c.capWin}</div>
  <div class="cap right">${c.capPhone}</div>
</body></html>`
}

let server = null
let child = null
let profile = ''
const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''))
  if (!ok) failures.push(name)
}

try {
  mkdirSync(OUT_REVIEW, { recursive: true })

  const html = {}
  for (const lang of ['zh', 'en']) html[lang] = page({ lang })
  const iconPng = readFileSync(join(ROOT, 'lib', 'icons', 'icon-192.png'))

  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    // 两个路径都认：页面里写的是 /lib/icons/…，历史脚本用的是 /taskwatch/icon-192.png
    if (path === '/lib/icons/icon-192.png' || path === '/taskwatch/icon-192.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(iconPng)
      return
    }
    const name = path.replace(/^\/taskwatch\/?/, '').replace(/\/$/, '') || 'zh'
    if (!html[name]) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html[name])
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-hero-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2', '--force-color-profile=srgb',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let port = 0
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !port) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    const f = join(profile, 'DevToolsActivePort')
    if (existsSync(f)) {
      try {
        const raw = readFileSync(f, 'utf8').split(/\r?\n/)[0]
        if (raw) port = Number(raw)
      } catch { /* EBUSY：稍后再读 */ }
    }
    if (!port) await sleep(100)
  }
  if (!port) throw new Error('等不到 DevToolsActivePort')

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: false })

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }

  for (const lang of ['zh', 'en']) {
    await cdp.send('Page.navigate', { url: base + '/taskwatch/' + lang + '?t=' + Date.now() })
    await sleep(900)

    const a = JSON.parse(await evalJs(`JSON.stringify((function(){
      var img = document.querySelector('.dev img');
      var box = function(sel){
        var b = document.querySelector(sel).getBoundingClientRect();
        return { x: Math.round(b.left), y: Math.round(b.top),
                 w: Math.round(b.width), h: Math.round(b.height),
                 right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
      var win = document.querySelector('.win');
      var card = document.querySelector('.card').getBoundingClientRect();
      var mainB = document.querySelector('.main-b').getBoundingClientRect();
      var comp = document.querySelector('.composer').getBoundingClientRect();
      var capW = document.querySelector('.cap.left');
      var capP = document.querySelector('.cap.right');
      var over = [].filter.call(document.querySelectorAll('.win *'), function(n){
        var r = n.getBoundingClientRect();
        if (!r.width || getComputedStyle(n).visibility === 'hidden') return false;
        var pr = n.parentElement.getBoundingClientRect();
        return r.right > pr.right + 0.6 || r.bottom > pr.bottom + 0.6;
      }).slice(0, 6).map(function(n){
        return n.tagName.toLowerCase() + '.' + String(n.className).split(' ')[0] +
          '@' + Math.round(n.getBoundingClientRect().right) + 'x' + Math.round(n.getBoundingClientRect().bottom);
      });
      var cut = [].filter.call(document.querySelectorAll('.ttl,.row .t,.ph,.chip,.model,.demo'), function(n){
        return n.scrollWidth > n.clientWidth + 1;
      }).map(function(n){ return String(n.className) + ':' + n.textContent.slice(0, 12); });
      return {
        iw: innerWidth, ih: innerHeight,
        docW: document.documentElement.scrollWidth,
        docH: document.documentElement.scrollHeight,
        imgOk: !!(img && img.complete && img.naturalWidth > 0),
        logoOk: (function(l){ return !!(l && l.complete && l.naturalWidth > 0); })(document.querySelector('.brand .logo')),
        win: box('.win'), dev: box('.dev'),
        railW: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
        cardBottom: Math.round(card.bottom),
        compTop: Math.round(comp.top),
        mainBottom: Math.round(mainB.bottom),
        rows: document.querySelectorAll('.tree .row').length,
        sel: document.querySelectorAll('.tree .row.on').length,
        nav: document.querySelectorAll('.navs .nav').length,
        brand: (document.querySelector('.wm')||{}).textContent,
        badge: (document.querySelector('.hb')||{}).textContent,
        newChat: (document.querySelector('.newchat')||{}).textContent.trim(),
        model: (document.querySelector('.composer .model')||{}).textContent.trim(),
        sendW: Math.round(document.querySelector('.send').getBoundingClientRect().width),
        dots: document.querySelectorAll('.dot').length,
        demo: (document.querySelector('.main-h .demo')||{}).textContent.trim(),
        wait: (document.querySelector('.wait')||{}).textContent.trim(),
        steps: (document.querySelector('.steps')||{}).textContent.trim(),
        capWin: box('.cap.left'), capPhone: box('.cap.right'),
        capWinText: capW.textContent.trim(), capPhoneText: capP.textContent.trim(),
        over: over, cut: cut,
        bg: getComputedStyle(document.body).backgroundColor
      };
    })())`))

    check(`${lang} 画布 ${W}×${H} 无滚动`,
      a.iw === W && a.ih === H && a.docW <= W && a.docH <= H,
      `doc=${a.docW}×${a.docH}`)
    check(`${lang} 底色是白的`, a.bg === 'rgb(255, 255, 255)', a.bg)
    check(`${lang} 手机截图与鲸鱼图标都已加载`, a.imgOk && a.logoOk,
      `phone=${a.imgOk} logo=${a.logoOk}`)
    check(`${lang} 窗口 880×528 @ (100,64)`,
      a.win.x === WIN.x && a.win.y === WIN.y && a.win.w === WIN.w && a.win.h === WIN.h,
      `${a.win.x},${a.win.y} ${a.win.w}×${a.win.h}`)
    check(`${lang} 手机 264×552 @ (1036,40)`,
      a.dev.x === DEV.x && a.dev.y === DEV.y && a.dev.w === DEV.w && a.dev.h === DEV.h,
      `${a.dev.x},${a.dev.y} ${a.dev.w}×${a.dev.h}`)
    check(`${lang} 两个物件不重叠、都在画布内`,
      a.win.right + 24 <= a.dev.x && a.dev.right <= W - 64 && a.dev.bottom <= CAPTION_Y - 8,
      `win.right=${a.win.right} dev.x=${a.dev.x} dev.right=${a.dev.right} dev.bottom=${a.dev.bottom}`)
    check(`${lang} 侧栏 236：3 个窗控 + 品牌 + 新会话 + 2 导航 + 5 行工作区`,
      a.railW === WIN_RAIL && a.dots === 3 && a.brand === COPY[lang].brand &&
      a.badge === 'HARNESS' && a.rows === COPY[lang].ws.length && a.sel === 1 && a.nav === 2,
      `rail=${a.railW} dots=${a.dots} rows=${a.rows} sel=${a.sel} nav=${a.nav} newchat=${a.newChat}`)
    check(`${lang} composer 里有模型名与发送键`,
      a.model.indexOf(COPY[lang].model) === 0 && a.sendW >= 24,
      `${a.model} send=${a.sendW}`)
    check(`${lang} 待批准卡没被裁、且在输入框之上`,
      a.cardBottom <= a.compTop && a.cardBottom <= a.mainBottom,
      `cardBottom=${a.cardBottom} compTop=${a.compTop} mainBottom=${a.mainBottom}`)
    check(`${lang} 窗口里没有元素越出父级`, a.over.length === 0, a.over.join(' '))
    check(`${lang} 标题/会话名/占位/模型名没有被截断`, a.cut.length === 0, a.cut.join(' '))
    check(`${lang} 演示标记还在`, a.demo === COPY[lang].demo, a.demo)
    check(`${lang} 卡片下方一行写明倒计时与回退`, a.wait === COPY[lang].wait, a.wait)
    check(`${lang} 工具步骤行在位`, a.steps === COPY[lang].steps, a.steps)
    check(`${lang} 两行说明都在、位置正确`,
      a.capWin.w === WIN.w && a.capWin.y === CAPTION_Y &&
      a.capPhone.w === DEV.w && a.capPhone.y === CAPTION_Y &&
      a.capWinText === COPY[lang].capWin && a.capPhoneText === COPY[lang].capPhone,
      `${a.capWinText} / ${a.capPhoneText}`)

    const png = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 },
      captureBeyondViewport: false,
    })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT_REVIEW, `hero-${lang}.png`), buf)
    console.log(`  ${lang}: ${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}  ` +
      `${(buf.length / 1024).toFixed(0)}KB  背景 ${a.bg}`)
  }

  cdp.close()
  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  browser.close()
  if (failures.length) {
    console.error('\nhero 自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n两张 hero PNG 已生成到 ' + OUT_REVIEW)
    console.log('转 webp（quality 88）后放进 docs/assets/：')
    console.log('  python -c "from PIL import Image; import sys; ' +
      'Image.open(sys.argv[1]).convert(\'RGB\').save(sys.argv[2], quality=88, method=6)" in.png out.webp')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
