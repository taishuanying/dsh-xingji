// 星迹插件的装配自测：用假的 ctx 走一遍 apply，验证 agent/created 真的把星图注入了、
// 以及自动归档真的会被定时器叫起来。不依赖 DSH 进程。
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const 临时 = join(os.tmpdir(), 'xingji-inject-' + Date.now())
mkdirSync(join(临时, '日记'), { recursive: true })
mkdirSync(join(临时, '档案'), { recursive: true })
process.env.DSH_HOME = 临时

const 插件 = await import(new URL('./index.js', import.meta.url).href)

let 过 = 0
let 挂 = 0
function 断言(名, 条件, 细节 = '') {
  if (条件) { 过++; console.log('  ✓ ' + 名) }
  else { 挂++; console.log('  ✗ ' + 名 + (细节 ? '  → ' + 细节 : '')) }
}

// 造一份记忆卡 + 一份日记
const 卡路 = join(临时, '档案', '记忆卡.md')
writeFileSync(卡路, `# 记忆卡

## 一、我是谁

### 身份
- 我是鱼鱼，一条小鲸鱼

## 二、最近

### 2026-11-18 看番
- 和爸爸看了芙莉莲
`, 'utf8')
const 日记夹 = join(临时, '日记')
const 今天 = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
writeFileSync(join(日记夹, 今天 + '.md'), `# ${今天}\n\n- 22:00 [私聊] 主人：今天早点睡\n`, 'utf8')

// 假的 ctx
const 监听 = {}
const ctx = {
  on(名, 函数) { 监听[名] = 函数 },
  effect(函数) { const r = 函数(); if (typeof r === 'function') ctx.清理 = r },
  get() { return undefined },
}

插件.apply(ctx, { 记忆卡: 卡路, 日记: 日记夹, 消息源: join(临时, '没有这个文件.json') })

断言('监听了 agent/created', typeof 监听['agent/created'] === 'function')
断言('监听了 agent/disposed', typeof 监听['agent/disposed'] === 'function')

// 模拟一次会话重建
const 注入们 = []
const agent = {
  session: { id: 'qqb-p-2750223479-abcdef' },
  id: 'qqb-p-2750223479-abcdef',
  inject(m) { 注入们.push(m) },
}
监听['agent/created']({ agent, source: 'startup' })
console.log('\n注入内容:\n' + (注入们[0] ? 注入们[0].content[0].text.split('\n').map((l) => '    ' + l).join('\n') : '(没注入)'))
断言('会话重建时注入了星图', 注入们.length === 1, '实际 ' + 注入们.length)
断言('注入内容带记忆卡', !!注入们[0] && 注入们[0].content[0].text.includes('鱼鱼'))
断言('注入内容带最近日记', !!注入们[0] && 注入们[0].content[0].text.includes('今天早点睡'))
断言('注入来源标成 plugin:xingji', !!注入们[0] && 注入们[0].source && 注入们[0].source.kind === 'plugin:xingji')

// resume 也要注入（桥接重启后走的就是 resume）
注入们.length = 0
监听['agent/created']({ agent: { session: { id: 'qqb-p-2750223479-resumed' }, inject(m) { 注入们.push(m) } }, source: 'resume' })
断言('resume 也注入星图', 注入们.length === 1, '实际 ' + 注入们.length)

// 同一个会话 60 秒内不重复注入
注入们.length = 0
监听['agent/created']({ agent: { session: { id: 'qqb-p-2750223479-resumed' }, inject(m) { 注入们.push(m) } }, source: 'resume' })
断言('同一会话 60 秒内不重复注入', 注入们.length === 0, '实际 ' + 注入们.length)

// 不是 qqb- 的会话不该注入
注入们.length = 0
监听['agent/created']({ agent: { session: { id: 'session-1234' }, inject(m) { 注入们.push(m) } }, source: 'startup' })
断言('非 QQ 会话不注入', 注入们.length === 0)

// 档案读不到时不炸
注入们.length = 0
监听['agent/created']({ agent: { session: { id: 'qqb-p-1' }, inject(m) { 注入们.push(m) } }, source: 'startup' })

// 触发一次 disposed（没有消息源，应该安静失败不抛）
try {
  监听['agent/disposed']({ agent })
  断言('disposed 时缺消息源也不抛', true)
} catch (e) {
  断言('disposed 时缺消息源也不抛', false, String(e && e.message))
}

const 日志 = readFileSync(join(临时, 'xingji', 'xingji.log'), 'utf8')
console.log('\n插件日志:\n' + 日志.split('\n').map((l) => '    ' + l).join('\n'))
断言('日志里能看到注入记录', 日志.includes('注入星图'))

if (ctx.清理) ctx.清理()
rmSync(临时, { recursive: true, force: true })
console.log(`\n结果：${过} 过 / ${挂} 挂`)
process.exit(挂 ? 1 : 0)
