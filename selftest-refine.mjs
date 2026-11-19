// 星迹「自动长记忆卡」自测：给假模型，验证提炼 → 写回记忆卡 → 记重要度 → 水位推进。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const 临时 = join(os.tmpdir(), 'xingji-refine-' + Date.now())
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

const 卡路 = join(临时, '档案', '记忆卡.md')
const 日记夹 = join(临时, '日记')
const 今天 = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

writeFileSync(卡路, `# 记忆卡

## 一、我是谁

### 身份
- 我是鱼鱼

## 二、最近

### 旧的条目
- 以前的事
`, 'utf8')

writeFileSync(join(日记夹, 今天 + '.md'), `# ${今天}

- 22:00 [私聊] 主人：今天看番吗
- 22:01 [私聊] 我：看！
`, 'utf8')

const 配置 = { 记忆卡: 卡路, 日记: 日记夹, 提炼冷却秒: 1 }

// 假模型：第一次返回两条，第二次返回「无」
let 第几次 = 0
const 假llm = {
  async *stream() {
    第几次++
    const 文 = 第几次 === 1
      ? '【章】二、最近\n【条】和爸爸看番\n【度】5\n【文】- 22:00 一起看了芙莉莲\n\n【章】三、心情\n【条】看番很開心\n【度】3\n【文】- 看番的时候很开心\n'
      : '无'
    for (const 字 of 文) yield { type: 'text-delta', text: 字 }
    yield { type: 'finish', reason: 'stop' }
  },
}

console.log('\n[1] 第一轮提炼')
const r1 = await 插件.提炼一轮(假llm, 配置)
console.log('  返回:', JSON.stringify(r1))
断言('写进 2 条', r1.条 === 2, '实际 ' + r1.条)
const 卡1 = readFileSync(卡路, 'utf8')
console.log('  记忆卡:\n' + 卡1.split('\n').map((l) => '    ' + l).join('\n'))
断言('新条目进了「二、最近」', 卡1.includes('### 和爸爸看番'))
断言('新章自动创建', 卡1.includes('## 三、心情') && 卡1.includes('### 看番很開心'))
断言('新条目插在正确章里（在「## 三」之前）', 卡1.indexOf('### 和爸爸看番') < 卡1.indexOf('## 三、心情'))
断言('旧条目没丢', 卡1.includes('### 旧的条目'))

const 权重 = JSON.parse(readFileSync(join(临时, 'xingji', 'weights.json'), 'utf8'))
console.log('  权重:', JSON.stringify(权重))
断言('重要度记下来了', 权重['二、最近／和爸爸看番']?.重要度 === 5)
断言('最后提及记成今天', 权重['二、最近／和爸爸看番']?.最后提及 === 今天)

console.log('\n[2] 冷却')
const r2 = await 插件.提炼一轮(假llm, 配置)
console.log('  返回:', JSON.stringify(r2))
断言('冷却期内不再调模型', r2.跳过 === '冷却中', '实际 ' + r2.跳过)

// 冷却得手动拨回去（生产里是最少 60 秒，测试不等真时间）
const 边路 = join(临时, 'xingji', 'refine.json')
const 拨回冷却 = () => {
  const 边0 = JSON.parse(readFileSync(边路, 'utf8'))
  边0.上次 = 0
  writeFileSync(边路, JSON.stringify(边0), 'utf8')
}

console.log('\n[3] 冷却过了但没新内容')
拨回冷却()
const r3 = await 插件.提炼一轮(假llm, 配置)
console.log('  返回:', JSON.stringify(r3))
断言('没有新行就不调模型', r3.跳过 === '没有新内容', '实际 ' + r3.跳过)

console.log('\n[4] 新日记 + 模型说「无」')
writeFileSync(join(日记夹, 今天 + '.md'), readFileSync(join(日记夹, 今天 + '.md'), 'utf8') + '- 22:05 [私聊] 主人：晚安\n', 'utf8')
拨回冷却()
const r4 = await 插件.提炼一轮(假llm, 配置)
console.log('  返回:', JSON.stringify(r4))
断言('模型说无可记 → 跳过但推进水位', r4.跳过 === '模型认为不值得记', '实际 ' + r4.跳过)
const 边 = JSON.parse(readFileSync(边路, 'utf8'))
断言('水位推进到最新', 边[今天 + '.md'] >= 4, '实际 ' + 边[今天 + '.md'])

console.log('\n[5] 标题重复不重写')
writeFileSync(卡路, 卡1.replace('### 旧的条目\n- 以前的事\n', '### 旧的条目\n- 以前的事\n\n### 和爸爸看番\n- 重复的\n'), 'utf8')
const 写进去 = 插件.写进记忆卡(卡路, [{ 章: '二、最近', 标题: '和爸爸看番', 文: '- 又一条', 度: 3 }])
断言('同标题不重复写', 写进去 === 0, '实际 ' + 写进去)

console.log('\n[6] 解析格式')
const 条 = 插件.解析提炼('【章】二、最近\n【条】标题A\n【度】4\n【文】正文A\n\n【章】四、别的\n【条】标题B\n【度】2\n【文】- 正文B')
console.log('  解析出:', JSON.stringify(条))
断言('解析出 2 条', 条.length === 2)
断言('章名正确', 条[0].章 === '二、最近' && 条[1].章 === '四、别的')
断言('正文补上 - 前缀', 条[0].文 === '- 正文A' && 条[1].文 === '- 正文B')
断言('重要度正确', 条[0].度 === 4 && 条[1].度 === 2)

rmSync(临时, { recursive: true, force: true })
console.log(`\n结果：${过} 过 / ${挂} 挂`)
process.exit(挂 ? 1 : 0)
