/* dsh-in-hand client bundle —— 手写，无打包器
 *
 * 加载协议：执行时调用 window.__ModuleLoader__.load({ id, factory })，
 * id 必须精确等于 package.json 的 name。factory 是懒 CJS 形态：
 * 只能用 module.exports，React 必须 React.createElement。
 *
 * 数据来自同源的 GET /taskwatch/data —— 不需要任何 host RPC。
 */
window.__ModuleLoader__.load({
  id: 'dsh-in-hand',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var CSS = [
      '.tw-wrap{display:flex;flex-direction:column;gap:12px;padding:16px 16px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.tw-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.tw-h{font-size:15px;font-weight:600;margin:0}',
      '.tw-meta{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.tw-chips{display:flex;gap:7px;flex-wrap:wrap}',
      '.tw-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.tw-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:11px;padding:11px 13px}',
      '.tw-card.warn{border-color:var(--dsw-alias-state-warn-primary)}',
      '.tw-card.err{border-color:var(--dsw-alias-state-error-primary)}',
      '.tw-card>h4{margin:0 0 7px;font-size:12.5px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.tw-n{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}',
      '.tw-row{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.tw-row:first-of-type{border-top:0}',
      '.tw-grow{flex:1;min-width:0}',
      '.tw-name{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-dim{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-block{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}',
      '.tw-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-right{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;text-align:right}',
      '.tw-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-top:5px;background:var(--dsw-alias-label-secondary)}',
      '.tw-dot.run{background:var(--dsw-alias-state-success-primary)}',
      '.tw-dot.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.tw-dot.err{background:var(--dsw-alias-state-error-primary)}',
      '.tw-empty{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.tw-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;margin-top:5px}',
      '.tw-bar>i{display:block;height:100%;background:var(--dsw-alias-state-success-primary)}',
      '.tw-bar>i.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.tw-bar>i.err{background:var(--dsw-alias-state-error-primary)}',

      // ── 手机配对面板（.tp-*）─────────────────────────────────────────────
      // 配色只用宿主给的语义令牌：面板在浅色/深色主题下都由宿主决定，不自己写死颜色。
      // 唯一的例外是二维码的底——它必须是白底黑块（4 个模块的静区也算在内），
      // 否则相机在某些深色主题下会扫不出来。
      '.tp-wrap{display:flex;flex-direction:column;gap:12px;padding:16px 16px 40px;margin:0 auto;max-width:560px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.tp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.tp-h{margin:0;font-size:15px;font-weight:600}',
      '.tp-sub{margin:4px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.tp-state{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.tp-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary)}',
      '.tp-dot.off{background:var(--dsw-alias-state-error-primary)}',
      '.tp-note{margin:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.tp-note.bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary)}',
      '.tp-tabs{display:flex;gap:4px}',
      '.tp-tab{appearance:none;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.tp-tab.on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.tp-card{display:flex;flex-direction:column;gap:12px;padding:12px 16px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1)}',
      '.tp-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.tp-card-head h4{margin:0;font-size:12.5px;font-weight:600}',
      '.tp-card-head .tp-meta{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.tp-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.tp-scan{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}',
      '.tp-qr{flex:0 0 auto;padding:8px;border-radius:8px;background:#fff;line-height:0;box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}',
      '.tp-qr svg{display:block}',
      '.tp-qr.wait{width:208px;height:208px;display:flex;align-items:center;justify-content:center;color:#61666b;font-size:12px;line-height:1.5;text-align:center;box-sizing:border-box}',
      '.tp-scan-body{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:8px}',
      '.tp-lead{margin:0;font-size:13px}',
      '.tp-dim{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.tp-url{display:flex;align-items:center;gap:8px;min-width:0}',
      '.tp-url code{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.tp-btn{appearance:none;flex:0 0 auto;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.tp-btn:hover{border-color:var(--dsw-alias-border-l2)}',
      '.tp-btn:disabled{opacity:.5;cursor:default}',
      '.tp-btn.danger:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.tp-bar{height:4px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-border-l1)}',
      '.tp-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .9s linear}',
      '.tp-bar-line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.tp-code{display:flex;align-items:center;gap:16px;flex-wrap:wrap}',
      '.tp-code b{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:24px;font-weight:600;letter-spacing:.18em;line-height:1}',
      '.tp-dev{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.tp-dev:first-of-type{border-top:0;padding-top:0}',
      '.tp-dev-body{flex:1 1 auto;min-width:0}',
      '.tp-dev-name{margin:0;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tp-dev-meta{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.tp-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}',
      '.tp-steps{margin:0;padding-left:16px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.tp-steps li{margin:4px 0}',
      '.tp-foot{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}',
      '.tp-foot a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
    ].join('\n')

    var POLL_MS = 3000

    function ago(t, now) {
      if (!t) return '\u2014'
      var s = Math.max(0, Math.round((now - t) / 1000))
      if (s < 60) return s + 's \u524d'
      var m = Math.floor(s / 60)
      if (m < 60) return m + 'm \u524d'
      var h = Math.floor(m / 60)
      if (h < 24) return h + 'h \u524d'
      return Math.floor(h / 24) + 'd \u524d'
    }

    function dur(a, b, now) {
      if (!a) return '\u2014'
      var s = Math.max(0, Math.round(((b || now) - a) / 1000))
      if (s < 60) return s + 's'
      var m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + (s % 60) + 's'
      var h = Math.floor(m / 60)
      return h + 'h' + (m % 60) + 'm'
    }

    function dotClass(status) {
      if (status === 'running') return 'tw-dot run'
      if (status === 'stopping') return 'tw-dot warn'
      if (status === 'failed' || status === 'killed') return 'tw-dot err'
      return 'tw-dot'
    }

    function useSnapshot() {
      var pair = React.useState(null)
      var snap = pair[0]
      var setSnap = pair[1]
      var epair = React.useState(null)
      var err = epair[0]
      var setErr = epair[1]
      React.useEffect(function () {
        var alive = true
        var timer = null
        // 响应序号：只接受最新一次请求的结果。并发轮询加上宿主 2 秒 TTL，
        // 较早发出的请求完全可能晚回来，不能让它把新快照覆盖成旧的。
        var seq = 0
        function tick() {
          // 面板挂在后台窗口时不必再打服务器。这个面板的典型用法就是
          // 「GUI 最小化、拿手机看」，此时继续每 3 秒请求纯属白耗。
          if (document.hidden) return
          var mine = ++seq
          // no-cache（不是 no-store）：让浏览器带上 If-None-Match，
          // 内容没变时宿主回 304，桌面这一半也省下整份 JSON。
          fetch('/taskwatch/data', { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          }).then(function (value) {
            if (!alive || mine !== seq) return
            setSnap(value)
            setErr(null)
          }, function (e) {
            if (!alive || mine !== seq) return
            setErr(e && e.message ? e.message : String(e))
          })
        }
        function start() { if (timer === null) timer = setInterval(tick, POLL_MS) }
        function stop() { if (timer !== null) { clearInterval(timer); timer = null } }
        function onVisibility() {
          if (document.hidden) stop()
          else { tick(); start() }
        }
        tick()
        if (!document.hidden) start()
        document.addEventListener('visibilitychange', onVisibility)
        return function () {
          alive = false
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])
      return [snap, err]
    }

    function row(key, dot, body, right) {
      return React.createElement('div', { className: 'tw-row', key: key },
        React.createElement('span', { className: dot }),
        React.createElement('div', { className: 'tw-grow' }, body),
        right ? React.createElement('div', { className: 'tw-right' }, right) : null)
    }

    function lines(list) {
      return list.filter(Boolean).map(function (text, index) {
        return React.createElement('div', { className: index === 0 ? 'tw-name' : 'tw-dim', key: index }, text)
      })
    }

    function Panel() {
      var state = useSnapshot()
      var snap = state[0]
      var err = state[1]

      // 保留上一份可用快照：一次网络抖动不该把整块面板清成空白 ——
      // 监控面板的价值恰恰在于「断开时还能看到最后一帧」。
      var lastGood = React.useRef(null)
      // 宿主采集异常时回的是 200 + {error}。它是错误，不是数据：
      // 当成数据用会渲染出一块「全部为 0」的假绿板，比直接报错更危险。
      var hostError = snap && snap.error ? String(snap.error) : null
      if (snap && !hostError) lastGood.current = snap
      var shown = hostError ? lastGood.current : snap
      var stale = hostError || err

      if (!shown) {
        if (stale) {
          return React.createElement('div', { className: 'tw-wrap' },
            React.createElement('div', { className: 'tw-card err' },
              React.createElement('h4', null, '任务监控'),
              React.createElement('div', { className: 'tw-dim' }, '读取失败：' + stale)))
        }
        return React.createElement('div', { className: 'tw-wrap' },
          React.createElement('div', { className: 'tw-card' },
            React.createElement('div', { className: 'tw-empty' }, '正在读取运行时状态…')))
      }

      snap = shown
      var now = snap.generatedAt || Date.now()
      var totals = snap.totals || {}
      var sections = []

      if (stale) {
        sections.push(React.createElement('div', { className: 'tw-card warn', key: 'stale' },
          React.createElement('div', { className: 'tw-empty' },
            '数据可能已陈旧（快照时间 ' + new Date(now).toLocaleTimeString() + '）：' + stale)))
      }

      if (snap.offline) {
        sections.push(React.createElement('div', { className: 'tw-card err', key: 'offline' },
          React.createElement('div', { className: 'tw-empty' }, '\u79bb\u7ebf\uff1a\u8bfb\u4e0d\u5230 DSH\uff0c\u4e0b\u65b9\u4e3a\u7a7a\u5217\u8868\u800c\u975e\u8fc7\u671f\u6570\u636e\u3002')))
      }

      sections.push(React.createElement('div', { className: 'tw-chips', key: 'chips' },
        ['\u4f1a\u8bdd ' + (totals.sessions || 0),
         '\u8fd0\u884c\u4e2d ' + (totals.running || 0),
         '\u540e\u53f0\u4efb\u52a1 ' + (totals.jobs || 0),
         '\u4efb\u52a1\u8fd0\u884c ' + (totals.jobsRunning || 0),
         '\u5b50\u4ee3\u7406 ' + (totals.subagents || 0),
         '\u5de5\u4f5c\u6d41 ' + (totals.workflows || 0)].map(function (label, index) {
          return React.createElement('span', { className: 'tw-chip', key: index }, label)
        })))

      var pending = snap.pending || []
      sections.push(React.createElement('div', {
        className: 'tw-card' + (pending.length ? ' err' : ''),
        key: 'pending',
      },
        React.createElement('h4', null, '\u9700\u8981\u4f60\u4ecb\u5165', React.createElement('span', { className: 'tw-n' }, String(pending.length))),
        pending.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u5f53\u524d\u6ca1\u6709\u7b49\u5f85\u4e2d\u7684\u5ba1\u6279\u6216\u63d0\u95ee\u3002')
          : pending.map(function (item, index) {
            return row('p' + index, 'tw-dot warn',
              lines([item.title, item.detail, item.kind + ' \u00b7 ' + (item.session || '\u2014')]),
              ago(item.at, now))
          })))

      var sessions = snap.sessions || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'sessions' },
        React.createElement('h4', null, '\u4f1a\u8bdd', React.createElement('span', { className: 'tw-n' }, String(sessions.length))),
        sessions.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u6d3b\u7740\u7684\u4f1a\u8bdd\u3002')
          : sessions.slice(0, 30).map(function (session) {
            var info = (session.running ? '\u8fd0\u884c\u4e2d' : '\u7a7a\u95f2')
              + (session.activeJobs ? ' \u00b7 ' + session.activeJobs + ' \u4e2a\u4efb\u52a1\u5728\u8dd1' : '')
              + (session.live ? '' : ' \u00b7 \u4ec5\u65e5\u5fd7')
              + (session.origin === 'subagent' ? ' \u00b7 \u5b50\u4ee3\u7406' : '')
              + (session.depth ? ' \u00b7 \u6df1\u5ea6' + session.depth : '')
              + (session.preset ? ' \u00b7 ' + session.preset : '')
            var body = lines([session.title || session.id, session.id, info])
            if (session.goal) {
              var goal = session.goal
              body.push(React.createElement('div', { className: 'tw-dim', key: 'goal' },
                '\u76ee\u6807 ' + goal.phase + ' \u00b7 \u8f6e\u6b21 ' + goal.roundsStarted + '/' + goal.maxGoalRounds
                + (goal.activation === 'disarmed' ? ' \u00b7 \u672a\u7eed\u8dd1' : '')))
              if (goal.objective) {
                body.push(React.createElement('div', { className: 'tw-block', key: 'objective' }, goal.objective))
              }
              if (goal.blockedMessage) {
                body.push(React.createElement('div', { className: 'tw-block', key: 'blocked' }, '\u963b\u585e\uff1a' + goal.blockedMessage))
              }
              if (goal.maxGoalRounds > 0) {
                var pct = Math.min(100, Math.round((100 * goal.roundsStarted) / goal.maxGoalRounds))
                var tone = goal.phase === 'blocked' ? 'err' : (goal.phase === 'paused' ? 'warn' : '')
                body.push(React.createElement('div', { className: 'tw-bar', key: 'bar' },
                  React.createElement('i', { className: tone, style: { width: pct + '%' } })))
              }
            }
            return row('s' + session.id,
              session.running ? 'tw-dot run' : (session.activeJobs ? 'tw-dot warn' : 'tw-dot'),
              body, ago(session.lastActivity, now))
          })))

      var jobs = snap.jobs || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'jobs' },
        React.createElement('h4', null, '\u540e\u53f0\u4efb\u52a1', React.createElement('span', { className: 'tw-n' }, String(jobs.length))),
        jobs.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u540e\u53f0\u4efb\u52a1\u3002')
          : jobs.slice(0, 30).map(function (job) {
            return row('j' + job.id, dotClass(job.status),
              lines([job.label || job.id,
                     job.id + ' \u00b7 ' + job.kind + ' \u00b7 ' + job.status,
                     job.detail || (job.owner ? '\u5c5e\u4e3b ' + job.owner : '')]),
              dur(job.startedAt, job.finishedAt, now))
          })))

      var subs = snap.subagents || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'subagents' },
        React.createElement('h4', null, '\u5b50\u4ee3\u7406\u6811', React.createElement('span', { className: 'tw-n' }, String(subs.length))),
        subs.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u5b50\u4ee3\u7406\u3002')
          : subs.slice(0, 30).map(function (sub) {
            return row('b' + sub.id, sub.activity === 'running' ? 'tw-dot run' : 'tw-dot',
              lines([sub.label || sub.id, sub.id,
                     sub.mode + ' \u00b7 ' + sub.activity + ' \u00b7 \u6df1\u5ea6' + sub.depth + ' \u00b7 \u7236 ' + (sub.parent || '\u2014')]),
              null)
          })))

      var flows = snap.workflows || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'workflows' },
        React.createElement('h4', null, '\u5de5\u4f5c\u6d41', React.createElement('span', { className: 'tw-n' }, String(flows.length))),
        flows.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u8fd0\u884c\u4e2d\u7684\u5de5\u4f5c\u6d41\u3002')
          : flows.map(function (flow) {
            return row('w' + flow.id, 'tw-dot run',
              lines([flow.name || flow.id,
                     '\u9636\u6bb5\uff1a' + (flow.phase || '\u2014'),
                     flow.id + ' \u00b7 ' + flow.logs + ' \u6761\u65e5\u5fd7']),
              dur(flow.startedAt, 0, now))
          })))

      var problems = snap.errors || []
      if (problems.length) {
        sections.push(React.createElement('div', { className: 'tw-card warn', key: 'errors' },
          React.createElement('h4', null, '\u91c7\u96c6\u8bca\u65ad'),
          problems.map(function (text, index) {
            return React.createElement('div', { className: 'tw-mono', key: index }, text)
          })))
      }

      return React.createElement('div', { className: 'tw-wrap' },
        React.createElement('div', { className: 'tw-top' },
          React.createElement('h3', { className: 'tw-h' }, '任务监控'),
          // 用本地时钟，不用 snap.generatedAt：命中 304 时浏览器交回的是
          // 缓存里的旧响应体，那个时间戳会冻结，「刚刚检查过」就成了假话。
          React.createElement('span', { className: 'tw-meta' },
            new Date().toLocaleTimeString() + ' · 每 3 秒刷新'),
          React.createElement('a', { className: 'tw-meta', href: '/taskwatch', target: '_blank', rel: 'noopener' },
            '手机页 ↗')),
        sections)
    }

    function Icon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      var color = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, React.createElement('path', { d: 'M2 12h4l2.5-6.5 3.5 13L15 12h7' }))
    }

    /** 侧栏「手机配对」的图标：三个定位角 + 两块数据格。16–18px 下还能认出是二维码，
     *  和「掌上 DSH」那条的脉冲线共用同一套描边（1.8px、圆角），不抢它的辨识度。 */
    function QrIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      var color = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      React.createElement('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
      React.createElement('path', { d: 'M14 14h3v3h-3zM19 19h2v2h-2zM19 14h2M14 19v2' }))
    }

    // ── 手机配对面板（v1.9.0）───────────────────────────────────────────────
    //
    // 这一块回答「怎么把手机接进来」，不回答「现在跑着什么」。三条同源接口
    // （lib/index.js 的 L2 段）做全部判断，面板只做三件事：把二维码摆出来、
    // 把倒计时说清楚、把连不上的原因说人话。
    //   GET  /taskwatch/pair/info   → 有哪几条路、中继活没活、设备列表、配置是否过期
    //   POST /taskwatch/pair/link   → 签一张 60 秒的票，连二维码 SVG 一起回来
    //   POST /taskwatch/pair/code   → 让本机中继当场生成一个 6 位码（兜底那条路）
    var PAIR_INFO_MS = 5000

    function h(tag, props) {
      var children = [].slice.call(arguments, 2)
      return React.createElement.apply(null, [tag, props].concat(children))
    }

    function pairPost(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (response) {
        return response.json().catch(function () { return null }).then(function (value) {
          return { ok: response.ok, status: response.status, body: value || {} }
        })
      })
    }

    function pairClock(ms) {
      var s = Math.max(0, Math.round(ms / 1000))
      if (s < 60) return s + ' 秒'
      return Math.floor(s / 60) + ' 分 ' + ('0' + (s % 60)).slice(-2) + ' 秒'
    }

    /** 复制到剪贴板。桌面客户端里 navigator.clipboard 会因为窗口没聚焦而 reject，
     *  所以留着 execCommand 那条老路；两条都失败时调用方要明说"复制失败"，
     *  不能让按钮点了没反应。 */
    function pairCopy(text, done, fail) {
      function legacy() {
        try {
          var area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          document.body.appendChild(area)
          area.select()
          var ok = document.execCommand('copy')
          document.body.removeChild(area)
          return Boolean(ok)
        } catch (e) { return false }
      }
      var fallback = function () { if (legacy()) done(); else fail() }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback)
        return
      }
      fallback()
    }

    function pickTarget(targets, kind) {
      var list = targets || []
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].kind === kind) return list[i]
      return null
    }

    function PairPanel() {
      var infoState = React.useState(null)
      var info = infoState[0]
      var setInfo = infoState[1]
      var errState = React.useState('')
      var err = errState[0]
      var setErr = errState[1]
      var noteState = React.useState('')
      var note = noteState[0]
      var setNote = noteState[1]
      var qrState = React.useState(null)
      var qr = qrState[0]
      var setQr = qrState[1]
      var kindState = React.useState('lan')
      var kind = kindState[0]
      var setKind = kindState[1]
      var codeState = React.useState(null)
      var code = codeState[0]
      var setCode = codeState[1]
      var codeErrState = React.useState('')
      var codeErr = codeErrState[0]
      var setCodeErr = codeErrState[1]
      var confirmState = React.useState('')
      var confirmId = confirmState[0]
      var setConfirmId = confirmState[1]
      var tickState = React.useState(0)
      var setTick = tickState[1]
      var aliveRef = React.useRef(true)
      var mintSeq = React.useRef(0)
      var busyRef = React.useRef({ link: false, code: false })
      var askedCode = React.useRef(false)
      var reloadRef = React.useRef(null)

      // 轮询：只在面板可见时打服务器。设备列表要能自己长出来（配对完手机上立刻
      // 多一行），所以首屏读一次之后每 5 秒再读一次；看不见时停掉。
      React.useEffect(function () {
        aliveRef.current = true
        function loadInfo() {
          if (document.hidden) return
          fetch('/taskwatch/pair/info', { cache: 'no-store' }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          }).then(function (value) {
            if (!aliveRef.current) return
            if (value && value.ok) { setInfo(value); setErr('') } else setErr((value && value.error) || '读取配对信息失败')
          }, function (e) {
            if (!aliveRef.current) return
            setErr('读取配对信息失败：' + (e && e.message ? e.message : String(e)))
          })
        }
        reloadRef.current = loadInfo
        loadInfo()
        var infoTimer = setInterval(loadInfo, PAIR_INFO_MS)
        // 倒计时靠这一拍重新渲染；不存具体秒数，渲染时用 expiresAt 现算，
        // 这样切后台再回来也不会走慢。
        var tickTimer = setInterval(function () {
          if (!document.hidden) setTick(function (n) { return (n + 1) % 100000 })
        }, 1000)
        function onVisibility() { if (!document.hidden) loadInfo() }
        document.addEventListener('visibilitychange', onVisibility)
        return function () {
          aliveRef.current = false
          clearInterval(infoTimer)
          clearInterval(tickTimer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      // 入口消失时（比如中继关了 .lan）把选中项挪到还在的那条上，否则面板会一直
      // 指着一个 409。
      React.useEffect(function () {
        if (!info) return
        var list = info.targets || []
        if (pickTarget(list, kind)) return
        if (list.length) { setKind(list[0].kind); setQr(null) }
      }, [info, kind])

      // 二维码的生命周期：没有就签一张；到期就换一张。票只有 60 秒，面板开着不动
      // 也必须是"随时能扫"的状态。
      React.useEffect(function () {
        if (!info) return
        var target = pickTarget(info.targets, kind)
        if (!target || !target.ok) return
        if (busyRef.current.link) return
        if (!qr || qr.kind !== kind || qr.expiresAt <= Date.now()) mint(kind)
      }, [info, kind, qr, tickState[0]])

      // 6 位码只在第一次知道"中继能取码"时自动取一次：每次开面板都让中继把上一个
      // 码作废并不友好（可能在另一个窗口正显示着），要新的就点「重新取码」。
      React.useEffect(function () {
        if (!info || code || askedCode.current) return
        var relay = info.relay || {}
        if (!relay.alive || !relay.codeSource) return
        askedCode.current = true
        fetchCode()
      }, [info, code])

      // 撤销是两步：第一下把按钮换成「确认撤销」，5 秒内没再点就自己收回。
      // 面板里不放 modal —— 那会把"嗯我知道"变成一次点击障碍。
      React.useEffect(function () {
        if (!confirmId) return
        var timer = setTimeout(function () { setConfirmId('') }, 5000)
        return function () { clearTimeout(timer) }
      }, [confirmId])

      function mint(which) {
        if (busyRef.current.link) return
        var seq = ++mintSeq.current
        busyRef.current.link = true
        pairPost('/taskwatch/pair/link', { to: which }).then(function (res) {
          if (!aliveRef.current || seq !== mintSeq.current) return
          if (!res.ok || !res.body.ok) {
            setQr(null)
            setErr(res.body.error || ('签发二维码失败（HTTP ' + res.status + '）'))
            return
          }
          setErr('')
          setQr({
            kind: res.body.kind,
            label: res.body.label,
            address: res.body.address,
            url: res.body.url,
            svg: res.body.svg,
            ttlMs: res.body.ttlMs,
            expiresAt: res.body.expiresAt,
          })
        }).catch(function (e) {
          if (!aliveRef.current || seq !== mintSeq.current) return
          setQr(null)
          setErr('签发二维码失败：' + (e && e.message ? e.message : String(e)))
        }).then(function () {
          busyRef.current.link = false
        })
      }

      function fetchCode() {
        if (busyRef.current.code) return
        busyRef.current.code = true
        pairPost('/taskwatch/pair/code', {}).then(function (res) {
          if (!aliveRef.current) return
          if (!res.ok || !res.body.ok) {
            setCode(null)
            setCodeErr(res.body.error || ('取码失败（HTTP ' + res.status + '）'))
            return
          }
          setCodeErr('')
          setCode({ code: res.body.code, expiresAt: res.body.expiresAt })
        }).catch(function (e) {
          if (!aliveRef.current) return
          setCode(null)
          setCodeErr('取码失败：' + (e && e.message ? e.message : String(e)))
        }).then(function () {
          busyRef.current.code = false
        })
      }

      function revoke(device) {
        if (confirmId !== device.id) { setConfirmId(device.id); return }
        setConfirmId('')
        pairPost('/taskwatch/devices/revoke', { deviceId: device.id }).then(function (res) {
          if (!aliveRef.current) return
          if (!res.ok || !res.body.ok) { setNote(res.body.error || ('撤销失败（HTTP ' + res.status + '）')); return }
          setNote(res.body.self ? '这台电脑的入口已撤销，刷新手机页会重新配对' : '那台设备已撤销，它下次请求就要重新配对')
          if (reloadRef.current) reloadRef.current()
        }).catch(function (e) {
          if (!aliveRef.current) return
          setNote('撤销失败：' + (e && e.message ? e.message : String(e)))
        })
      }

      if (!info) {
        return h('div', { className: 'tp-wrap' },
          h('div', { className: 'tp-head' },
            h('div', null,
              h('h3', { className: 'tp-h' }, '手机配对'),
              h('p', { className: 'tp-sub' }, '扫一下就连上这台电脑的 DSH，不用输配对码。'))),
          h('div', { className: 'tp-card' },
            h('p', { className: err ? 'tp-note bad' : 'tp-dim' }, err || '正在读取配对信息…')))
      }

      var relay = info.relay || {}
      var config = info.config || {}
      var targets = info.targets || []
      var target = pickTarget(targets, kind)
      // 面板自己就是"一台设备"（宿主给每个访客发 twd cookie）。把它列出来只会让人
      // 以为"这台电脑被配对了"，而用户想看的是**手机**。所以列表里剔掉自己，
      // 撤销自己的入口仍然在手机页的设备列表里（那里它显示成「本机」）。
      var devices = (info.devices || []).filter(function (d) { return d && !d.current })
      var now = Date.now()
      var qrLeft = qr ? Math.max(0, qr.expiresAt - now) : 0
      var qrPercent = qr && qr.ttlMs ? Math.max(0, Math.min(100, Math.round(100 * qrLeft / qr.ttlMs))) : 0
      var codeLeft = code ? Math.max(0, code.expiresAt - now) : 0
      var pairPage = 'http://127.0.0.1:' + (relay.port || 3099) + '/taskwatch/pair'
      var svgOk = qr && typeof qr.svg === 'string' && /^<svg\b[\s\S]{40,}<\/svg>$/.test(qr.svg)
      var sections = []

      if (err) sections.push(h('p', { className: 'tp-note bad', key: 'err' }, err))
      if (note) sections.push(h('p', { className: 'tp-note', key: 'note' }, note))
      if (config.lanUrlStale) {
        sections.push(h('p', { className: 'tp-note', key: 'stale' },
          '插件配置里的局域网地址 ' + config.lanUrlHost + ' 现在不是这台机器的网卡（现在有 '
          + ((config.currentIps || []).join(' / ') || '没有局域网地址') + '）。'
          + '下面用的是中继自己报的地址；想彻底对齐就改配置项 lanUrl。'))
      }

      // 两条路只有一条时不摆切换器：一个只能点的标签比没有更让人困惑。
      if (targets.length > 1) {
        sections.push(h('div', { className: 'tp-tabs', key: 'tabs' },
          targets.map(function (item) {
            return h('button', {
              key: item.kind,
              type: 'button',
              className: 'tp-tab' + (item.kind === kind ? ' on' : ''),
              onClick: function () { if (item.kind !== kind) { setNote(''); setKind(item.kind); setQr(null) } },
            }, item.label + (item.ok ? '' : ' · 连不上'))
          })))
      }

      if (!target || !target.ok) {
        sections.push(h('section', { className: 'tp-card', key: 'blocked' },
          h('div', { className: 'tp-card-head' }, h('h4', null, '手机现在还连不进来')),
          h('p', { className: 'tp-dim' }, (target && target.why) || '这台电脑没有对外的入口，手机到不了它。'),
          h('ul', { className: 'tp-steps' },
            h('li', null, '在跑中继的电脑上给它开局域网模式：中继目录里放一个空的 .lan 文件，再重启中继。'),
            h('li', null, '要人在外面也能连，就在插件配置里填 publicUrl（公网域名），这里会多出「公网」那张码。'),
            h('li', null, '只想临时连一次：在那台电脑上打开 ' + pairPage + '，用页面上的 6 位码。'))))
      } else {
        sections.push(h('section', { className: 'tp-card', key: 'qr' },
          h('div', { className: 'tp-card-head' },
            h('h4', null, '扫一扫'),
            h('div', { className: 'tp-actions' },
              h('span', { className: 'tp-meta' }, target.label + (target.address ? ' · ' + target.address : '')),
              h('button', { type: 'button', className: 'tp-btn', onClick: function () { setNote(''); mint(kind) } }, '换一张'))),
          h('div', { className: 'tp-scan' },
            svgOk
              ? h('div', { className: 'tp-qr', dangerouslySetInnerHTML: { __html: qr.svg } })
              : h('div', { className: 'tp-qr wait' }, '正在生成二维码…'),
            h('div', { className: 'tp-scan-body' },
              h('p', { className: 'tp-lead' }, '手机相机对准二维码'),
              h('p', { className: 'tp-dim' }, '扫完直接进，不用再输 6 位码。这张码只用一次，也可以复制链接发给自己。'),
              h('div', { className: 'tp-url' },
                h('code', null, qr ? qr.url.replace(/(\?t=)[^&]+/, '$1…') : '—'),
                h('button', {
                  type: 'button',
                  className: 'tp-btn',
                  disabled: !qr,
                  onClick: function () {
                    if (!qr) return
                    pairCopy(qr.url, function () {
                      setNote('链接已复制；它 60 秒内有效，只用一次')
                    }, function () {
                      setNote('复制被浏览器拦住了，请手动选中链接复制')
                    })
                  },
                }, '复制')))),
          h('div', { className: 'tp-bar' }, h('i', { style: { width: qrPercent + '%' } })),
          h('div', { className: 'tp-bar-line' },
            h('span', null, qr ? '还有 ' + pairClock(qrLeft) + '，到期自动换一张' : '正在签发…'))))
        // 远端那张码的前提（v1.9.1）：票由**中继**兑现。中继不在这台电脑上时，它得和宿主
        // 共用同一个票据密钥、且认 v3（中继 v1.1.0 起），否则手机扫完只会落到配对页。
        // 这句就是替用户先把这层说出来 —— 而不是等他扫完一圈再回来查文档。
        if (target.kind === 'remote' && !relay.alive) {
          sections.push(h('p', { className: 'tp-note', key: 'remote-ticket' },
            '这张票要由中继兑现。服务器那份中继必须和这台电脑用同一个票据密钥'
            + '（TASKWATCH_TICKET_SECRET，或复制 ~/.dsh/taskwatch-ticket.key）、且不低于 v1.1.0；'
            + '否则扫完会落到配对页 —— 那样就用下面的 6 位码。'))
        }
      }

      // 6 位码：兜底那条路。取不到就直说去中继页面看，不要在这里空着。
      sections.push(h('section', { className: 'tp-card', key: 'code' },
        h('div', { className: 'tp-card-head' },
          h('h4', null, '或者输 6 位码'),
          h('div', { className: 'tp-actions' },
            relay.alive && relay.codeSource
              ? h('button', {
                  type: 'button',
                  className: 'tp-btn',
                  onClick: function () { setNote(''); setCodeErr(''); fetchCode() },
                }, code ? '重新取码' : '取一个码')
              : h('span', { className: 'tp-meta' }, '不可用'))),
        relay.alive && relay.codeSource
          ? h('div', { className: 'tp-code' },
            h('b', null, code ? code.code : '••••••'),
            h('div', null,
              h('p', { className: 'tp-dim' }, code
                ? (codeLeft > 0 ? '还有 ' + pairClock(codeLeft) + '，一次性' : '已过期，重新取一个')
                : (codeErr || '正在取码…')),
              h('p', { className: 'tp-dim' }, '手机打开 '
                + (target && target.url ? target.url : pairPage) + ' 后输入')))
          : h('p', { className: 'tp-dim' },
            codeErr || (relay.alive
              ? '中继在另一台机器上，这一步只能去它本机的配对页取码：' + relay.origin + '/taskwatch/pair'
              : '中继没在跑：手机现在连不到这台电脑。先按上面的步骤把它开起来，或者直接去中继的配对页取码。'))))

      sections.push(h('section', { className: 'tp-card', key: 'devices' },
        h('div', { className: 'tp-card-head' },
          h('h4', null, '最近用过的设备'),
          h('span', { className: 'tp-meta' }, devices.length + ' 台')),
        devices.length === 0
          ? h('p', { className: 'tp-dim' }, '还没有手机用过这个入口。扫上面那张码，它就会出现在这里。')
          : devices.map(function (device) {
            var meta = (device.via === 'remote' ? '公网' : '局域网')
              + ' · ' + ago(device.lastSeen, now)
              + (device.sessions > 1 ? ' · 配对 ' + device.sessions + ' 次' : '')
            return h('div', { className: 'tp-dev', key: device.id },
              h('div', { className: 'tp-dev-body' },
                h('p', { className: 'tp-dev-name' },
                  device.name || '未知设备',
                  device.current ? h('span', { className: 'tp-tag' }, '本机') : null,
                  device.revoked ? h('span', { className: 'tp-tag' }, '已撤销') : null),
                h('p', { className: 'tp-dev-meta' }, meta)),
              h('button', {
                type: 'button',
                className: 'tp-btn' + (confirmId === device.id ? ' danger' : ''),
                disabled: device.revoked,
                onClick: function () { revoke(device) },
              }, device.revoked ? '已撤销' : (confirmId === device.id ? '确认撤销' : '撤销')))
          })))

      sections.push(h('p', { className: 'tp-foot', key: 'foot' },
        '配对等于把那台手机接进这台电脑的 DSH（默认 danger-full-access）——只在自己信得过的网络里开。'
        + '撤销之后那台手机下次请求就要重新配对。',
        h('br', null),
        h('a', { href: '/taskwatch', target: '_blank', rel: 'noopener' }, '在这台电脑上打开手机页 ↗')))

      return h('div', { className: 'tp-wrap' },
        h('div', { className: 'tp-head' },
          h('div', null,
            h('h3', { className: 'tp-h' }, '手机配对'),
            h('p', { className: 'tp-sub' }, '扫一下就连上这台电脑的 DSH，不用输配对码。')),
          h('span', { className: 'tp-state' },
            h('span', { className: 'tp-dot' + (relay.alive ? '' : ' off') }),
            relay.alive ? '中继在线' : '中继离线')),
        sections)
    }

    // 两条侧栏入口挂在同一份 CSS 上：
    //   · 「掌上 DSH」= 现在跑着什么（任务监控，v1.0.0 起）；
    //   · 「手机配对」= 怎么把手机接进来（v1.9.0）。
    // 分成两条而不是塞进同一个面板：前者是每天看的，后者是一年看两次的，
    // 混在一起会让监控面板每次都被二维码占掉半屏。
    function apply(ctx) {
      ctx.effect(function () {
        var el = document.createElement('style')
        el.setAttribute('data-dsh-in-hand', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () { el.remove() }
      })

      var slots = ctx.slots
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: 'in-hand', order: 60, label: '掌上 DSH' },
          Icon)
      })
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: 'in-hand-pair', order: 61, label: '手机配对' },
          QrIcon)
      })
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: 'in-hand' }, Panel)
      })
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: 'in-hand-pair' }, PairPanel)
      })
    }

    module.exports = { name: 'dsh-in-hand', inject: ['slots'], apply: apply }
    return module.exports
  },
})
