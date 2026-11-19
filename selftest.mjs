// 星迹插件的离线自测：不装进 DSH 也能验证「归档 / 拆卡 / 淡忘 / 注入文本」对不对。
// 用法：node selftest.mjs
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const 临时 = join(os.tmpdir(), 'xingji-selftest-' + Date.now())
mkdirSync(join(临时, '日记'), { recursive: true })
mkdirSync(join(临时, '档案'), { recursive: true })
// 插件把 DSH_HOME 当根，状态文件都写这下面，指到临时目录避免污染真实数据
process.env.DSH_HOME = 临时

const 插件 = await import(new URL('./index.js', import.meta.url).href)

let 过 = 0
let 挂 = 0
function 断言(名, 条件, 细节 = '') {
  if (条件) {
    过++
    console.log('  ✓ ' + 名)
  } else {
    挂++
    console.log('  ✗ ' + 名 + (细节 ? '  → ' + 细节 : ''))
  }
}

// ── 1. 归档：新消息进日记，第二轮不重复 ──
console.log('\n[1] 归档')
const 现在 = Date.now()
const 源 = join(临时, 'social-v2.json')
writeFileSync(源, JSON.stringify({
  conversations: {
    'private:2750223479': {
      recentMessages: [
        { seq: 1, sender: '主人', text: '测试第一条', isSelf: false, time: 现在 - 60000 },
        { seq: 2, sender: '主人', text: '测试第二条', isSelf: false, time: 现在 - 30000 },
        { sender: '我', text: '测试回复', isSelf: true, time: 现在 - 20000 },
      ],
    },
    'group:971157044': {
      recentMessages: [
        { seq: 5, sender: '群友甲', text: '群里的话', isSelf: false, time: 现在 - 10000 },
      ],
    },
  },
}, null, 2), 'utf8')

const 日记夹 = join(临时, '日记')
const 配置 = { ...插件.默认配置, 消息源: 源, 日记: 日记夹, 记忆卡: join(临时, '档案', '记忆卡.md') }

// 第一次见到会话只建立水位、不回溯历史（这正是「从现在开始记」）
const r0 = 插件.归档一轮(配置)
console.log('  首次建立水位:', JSON.stringify(r0))
断言('首次不回溯历史', r0.新增 === 0, '实际 ' + r0.新增)

// 之后来的新消息才该被归档
const 数据 = JSON.parse(readFileSync(源, 'utf8'))
数据.conversations['private:2750223479'].recentMessages.push(
  { seq: 3, sender: '主人', text: '测试第一条', isSelf: false, time: 现在 + 1000 },
  { seq: 4, sender: '主人', text: '测试第二条', isSelf: false, time: 现在 + 2000 },
  { sender: '我', text: '测试回复', isSelf: true, time: 现在 + 3000 },
)
数据.conversations['group:971157044'].recentMessages.push(
  { seq: 6, sender: '群友甲', text: '@taishu鱼鱼 在吗', isSelf: false, time: 现在 + 4000 },
  { seq: 7, sender: '群友乙', text: '这游戏真难', isSelf: false, time: 现在 + 5000 },
  { seq: 8, sender: '我', text: '确实难', isSelf: true, time: 现在 + 6000 },
)
writeFileSync(源, JSON.stringify(数据, null, 2), 'utf8')

const r1 = 插件.归档一轮(配置)
console.log('  第二轮:', JSON.stringify(r1))
const 日 = new Date(现在 + 8 * 3600 * 1000).toISOString().slice(0, 10)
const 日记文 = readFileSync(join(日记夹, 日 + '.md'), 'utf8')
console.log('  日记内容:\n' + 日记文.split('\n').map((l) => '    ' + l).join('\n'))
断言('私聊 3 条 + 群里 2 条相关的 = 5 条进日记', r1.新增 === 5, '实际 ' + r1.新增)
断言('日记里有私聊那条', 日记文.includes('测试第一条'))
断言('@她的群消息记了', 日记文.includes('@taishu鱼鱼 在吗'))
断言('群里跟她无关的闲聊没记', !日记文.includes('这游戏真难'))
断言('自己在群里说的话记了', 日记文.includes('我：确实难'))

const r2 = 插件.归档一轮(配置)
console.log('  第三轮:', JSON.stringify(r2))
断言('同一批不重复归档', r2.新增 === 0, '实际 ' + r2.新增)

// 再来一条，验证增量
数据.conversations['private:2750223479'].recentMessages.push({ seq: 5, sender: '主人', text: '第三条新的', isSelf: false, time: 现在 + 9000 })
writeFileSync(源, JSON.stringify(数据, null, 2), 'utf8')
const r3 = 插件.归档一轮(配置)
console.log('  第四轮:', JSON.stringify(r3))
断言('增量消息能捞到', r3.新增 === 1 && readFileSync(join(日记夹, 日 + '.md'), 'utf8').includes('第三条新的'))

// ── 1.5 重置前消息备份 ──
console.log('\n[1.5] 重置前消息备份')
const 备份路 = join(临时, 'last-reset-messages.json')
writeFileSync(备份路, JSON.stringify({
  'private:2750223479': {
    at: 现在 + 20000,
    messages: [
      { isSelf: false, sender: '主人', text: '重置前说的最后一句话' },
      { isSelf: true, sender: '我', text: '知道了' },
    ],
  },
}, null, 2), 'utf8')
const r重置 = 插件.归档一轮(配置)
const 日记重置 = readFileSync(join(日记夹, 日 + '.md'), 'utf8')
console.log('  重置备份归档:', JSON.stringify(r重置))
断言('重置前的消息也补进日记了', r重置.新增 === 2 && 日记重置.includes('重置前说的最后一句话'), '实际新增 ' + r重置.新增)
const r重置2 = 插件.归档一轮(配置)
断言('重置备份不重复归档', r重置2.新增 === 0, '实际 ' + r重置2.新增)

// ── 2. 拆卡 ──
console.log('\n[2] 拆记忆卡')
const 卡 = `# 记忆卡

## 一、我是谁

### 身份
- 我是鱼鱼，一条小鲸鱼
- 爸爸的 QQ 是 2750223479

## 二、最近

### 2026-11-18 看番
- 昨天和爸爸看了芙莉莲

### 2026-10-01 很久以前
- 那天中午吃了一碗面

## 三、整章一段
这里是没拆 ### 的一整段自述。
第二行。
`
const 条们 = 插件.拆卡(卡)
console.log('  拆出 ' + 条们.length + ' 条:', 条们.map((t) => t.章 + '/' + t.标题).join(' | '))
断言('拆出章节条目', 条们.length >= 4, '实际 ' + 条们.length)
断言('整章一段也能拆成一条', 条们.some((t) => t.章.includes('三、整章一段')))

// ── 3. 淡忘 ──
console.log('\n[3] 淡忘')
writeFileSync(join(临时, '档案', '记忆卡.md'), 卡, 'utf8')
const 卡文 = 插件.造星图(配置)
console.log('  注入文本（' + 卡文.length + ' 字）:\n' + 卡文.split('\n').map((l) => '    ' + l).join('\n'))
断言('身份这条留着', 卡文.includes('鱼鱼'))
断言('15 天内的事留着', 卡文.includes('芙莉莲'))
断言('49 天前的琐事被淡忘（正文不在，只留标题占位）', !卡文.includes('一碗面'))
断言('淡忘的旧事还留了标题索引', 卡文.includes('慢慢淡掉的旧事') && 卡文.includes('很久以前'))

// 钉住之后应该回来
writeFileSync(join(临时, 'xingji', 'weights.json'), JSON.stringify({
  '二、最近／2026-10-01 很久以前': { 钉住: true },
}, null, 2), 'utf8')
const 卡文2 = 插件.造星图(配置)
断言('钉住之后不再淡忘', 卡文2.includes('一碗面'))

// 重要度 5 的永远不淡
writeFileSync(join(临时, 'xingji', 'weights.json'), JSON.stringify({
  '一、我是谁／身份': { 重要度: 5 },
}, null, 2), 'utf8')
const 卡文3 = 插件.造星图(配置)
断言('重要度 5 保留', 卡文3.includes('2750223479'))

// ── 4. 注入上限 ──
console.log('\n[4] 注入上限')
const 长卡 = '# 记忆卡\n\n## 一、我是谁\n\n### 身份\n' + Array.from({ length: 300 }, (_, i) => '- 第 ' + i + ' 条比较长的记忆内容，用来把文本撑长').join('\n')
writeFileSync(join(临时, '档案', '记忆卡.md'), 长卡, 'utf8')
const 卡长 = 插件.造星图({ ...配置, 注入上限字: 500 })
console.log('  截断后长度: ' + 卡长.length)
断言('超过上限会截断', 卡长.length < 900, '实际 ' + 卡长.length)

rmSync(临时, { recursive: true, force: true })
console.log(`\n结果：${过} 过 / ${挂} 挂`)
process.exit(挂 ? 1 : 0)
