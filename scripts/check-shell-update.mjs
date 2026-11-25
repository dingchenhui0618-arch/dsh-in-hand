#!/usr/bin/env node
/**
 * 外壳更新链路的结构检查（v1.10.1）。
 *
 * 2026-11-25 的旧壳事故有两条根因：中继副本没跟插件同步（服务端问题，中继那边
 * 用 sync-shell --check 管），以及"长驻页面未必知道该换"（客户端问题）。这个脚本
 * 守住后者：有人在 page.html 里把注册选项改回去、删掉定时 update、或者把
 * controllerchange 自刷去掉，这里就红。
 *
 * 只做静态断言（不需要浏览器），与 check-bundle 的 demo 断言互补。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
const sw = readFileSync(join(ROOT, 'lib', 'sw.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}

console.log('外壳更新链路（v1.10.1）')

// 1. 注册时绕开浏览器对 sw.js 的 HTTP 缓存。
check('注册 SW 带 updateViaCache:none',
  /register\s*\(\s*'\/taskwatch\/sw\.js'[\s\S]{0,200}?updateViaCache\s*:\s*'none'/.test(page))

// 2. 长驻 PWA 也要主动问新版。
check('存在 registration.update() 调用', /\.update\s*\(\s*\)/.test(page))
check('加载后立即检查一次', /check\s*\(\s*\)/.test(page))
check('定时检查（30 分钟）', /setInterval\s*\(\s*check\s*,\s*30\s*\*\s*60\s*\*\s*1000\s*\)/.test(page))
check('切回前台时检查', /visibilitychange[\s\S]{0,160}?check\s*\(\s*\)/.test(page))

// 3. 新 SW 接管后页面自刷一次，但首次安装不白刷、且不会循环。
check('监听 controllerchange', /addEventListener\s*\(\s*'controllerchange'/.test(page))
check('接管后重载页面', /controllerchange[\s\S]{0,400}?location\.reload\s*\(\s*\)/.test(page))
check('首次安装（原来没有 controller）不重载', /hadController/.test(page))
check('重载有防循环的时间戳', /tw-sw-reloaded-at/.test(page))

// 4. 导航请求显式 no-store，不靠浏览器的 HTTP 缓存。
check("导航请求 fetch 带 cache:'no-store'", /fetch\s*\(\s*e\.request\s*,\s*\{\s*cache\s*:\s*'no-store'\s*\}\s*\)/.test(sw))

// 5. 演示页剥离依赖显式标记（嵌套回调下旧正则只能切到半截）。
check('注册块有 DEMO-STRIP-BEGIN 标记', page.includes('DEMO-STRIP-BEGIN'))
check('注册块有 DEMO-STRIP-END 标记', page.includes('DEMO-STRIP-END'))
check('缓存名已升到 v43', /const CACHE = 'taskwatch-v43'/.test(sw))

if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
