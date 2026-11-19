// 星迹 · dsh-xingji（宿主半边）
//
// 干什么：
//   ① 把 QQ 桥接里每一条新消息，按天追加进星汐的「日记/」——也就是星图里的一颗颗星；
//   ② 每次会话重建（她的 sessionId 变了），把记忆卡里**没淡忘**的部分 + 最近几天日记
//      自动带回新会话开头，等价于自动打一遍 /xingxi，她不用知道；
//   ③ 超过 15 天、又不重要的记忆，注入时省略（档案里原文不动，星汐的星图自己会变暗），
//      想查还是能 xingxi_read 查回来。身份、关系、约定、喜好这类永不淡忘。
//
// 为什么读 social-v2.json 而不是 DSH 的会话日志：
//   桥接发给 DSH 的 user 消息里塞了整段唤醒提示词（【此刻状态】【当前唤醒】…），
//   从会话日志里抠出来的「对话」全是提示词。social-v2.json 里是清洗过的原始 QQ 消息
//   （sender / text / time / isSelf），干净、增量、还带 seq 水位。
//
// 跟星汐的分工：星汐负责「摊开给你看 + 查档案」，星迹负责「自动收进来 + 自动带回去 + 忘掉旧的」。

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'xingji'

// 不依赖 tools：本插件只读文件、写文件、往 inbox 塞一段上下文。
// 但必须声明 llm —— Cordis 里不 inject 就不许读 ctx.llm（否则 apply 直接抛
// "cannot get property \"llm\" without inject"，整个插件不激活）。
export const inject = ['llm']

// ═══════════════════════════════════════════════════════
// 位置
// ═══════════════════════════════════════════════════════

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 根 = join(家, 'xingji')
const 配置文件 = join(根, 'config.json')
const 水位文件 = join(根, 'watermark.json')
const 权重文件 = join(根, 'weights.json')
const 日志文件 = join(根, 'xingji.log')

const 时区偏移 = 8 * 3600 * 1000

function 记一笔(行) {
  try {
    if (!existsSync(根)) mkdirSync(根, { recursive: true })
    appendFileSync(日志文件, new Date().toISOString().slice(11, 19) + ' ' + 行 + '\n', 'utf8')
  } catch {}
}

function 读JSON(路, 默认) {
  try {
    if (!existsSync(路)) return 默认
    let 文 = readFileSync(路, 'utf8')
    // ⚠ 记事本 / PowerShell 5 的 -Encoding UTF8 会带 BOM，JSON.parse 直接抛
    //   → 配置被静默忽略，还看不出为什么。这里先剥掉。
    if (文.charCodeAt(0) === 0xfeff) 文 = 文.slice(1)
    const v = JSON.parse(文)
    return v && typeof v === 'object' ? v : 默认
  } catch {
    return 默认
  }
}

function 写JSON(路, 值) {
  try {
    if (!existsSync(dirname(路))) mkdirSync(dirname(路), { recursive: true })
    writeFileSync(路, JSON.stringify(值, null, 2), 'utf8')
  } catch (e) {
    记一笔('写不了 ' + 路 + '：' + String((e && e.message) || e))
  }
}

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════

const 默认配置 = {
  // 空 = 自动从 ~/.dsh/xingxi/config.json 的「记忆卡」「日记」两项推
  记忆卡: '',
  日记: '',
  // 空 = 自动找 <工作区>/qq-bridge/state/social-v2.json
  消息源: '',
  // 只对这些会话前缀做自动带入（她 = QQ 桥接建的会话）
  会话前缀: ['qqb-'],
  // 群里只记跟她有关的：她说的 / 引用她的 / @她或叫名字的 / 主人说的
  群聊只记相关: true,
  她的名字: ['鱼鱼', 'taishu鱼鱼', '小鲸鱼', '鲸鱼娘'],
  淡忘天数: 15,
  // 每条都完整带上（1000 字基本等于不截断），五章 + 今天最后 6 条，默认给足 8000 字预算。
  // 嫌贵就往下调这三个数：注入上限字 / 身份条上限字 / 其他条上限字。
  注入上限字: 8000,
  身份条上限字: 1000,
  其他条上限字: 500,
  自动注入: true,
  自动归档: true,
  // 自动长记忆卡：把新日记提炼成条目写回记忆卡（要调模型、花钱，所以有冷却）
  自动提炼: true,
  提炼冷却秒: 900,
  模型: { provider: 'deepseek-account', model: 'deepseek-flash' },
  轮询秒: 30,
}

function 取配置() {
  const 存 = 读JSON(配置文件, {})
  return { ...默认配置, ...存 }
}

/** 从星汐的配置里借「记忆卡 / 日记」路径，省得两处各配一遍 */
function 从星汐借路径() {
  const 星汐配置 = 读JSON(join(家, 'xingxi', 'config.json'), {})
  return {
    记忆卡: String(星汐配置['记忆卡'] || ''),
    日记: String(星汐配置['日记'] || ''),
  }
}

/** 在常见位置找 qq-bridge 的 social-v2.json */
function 找消息源() {
  const 候选 = []
  // ① DSH 会话目录里带 qq-bridge 的工作区（目录名是编码过的，只能扫）
  try {
    const 会话根 = join(家, 'sessions')
    for (const 名 of readdirSync(会话根)) {
      if (!/qq-bridge|qqb/i.test(名)) continue
      // 编码名 → 猜不到原路径，跳过
      void 名
    }
  } catch {}
  // ② 从当前插件能看到的路径反推：星汐档案的兄弟目录
  try {
    const 星汐配置 = 读JSON(join(家, 'xingxi', 'config.json'), {})
    const 卡 = String(星汐配置['记忆卡'] || '')
    if (卡) {
      const 工作区 = dirname(dirname(卡))
      候选.push(join(工作区, 'qq-bridge', 'state', 'social-v2.json'))
    }
  } catch {}
  // ③ 常见默认位置
  候选.push(join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'qq-bridge', 'state', 'social-v2.json'))
  for (const p of 候选) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return ''
}

// ═══════════════════════════════════════════════════════
// 日记：把新消息按天追加进星汐的星图
// ═══════════════════════════════════════════════════════

function 本地日期(ms) {
  return new Date(Number(ms || 0) + 时区偏移).toISOString().slice(0, 10)
}

function 本地时分(ms) {
  return new Date(Number(ms || 0) + 时区偏移).toISOString().slice(11, 16)
}

/** private:2750223479 → 私聊；group:971157044 → 群 971157044 */
function 会话称呼(key) {
  const k = String(key || '')
  if (k.startsWith('private:')) return '私聊'
  if (k.startsWith('group:')) return '群 ' + k.slice(6)
  return k || '会话'
}

/** 群里这句跟她有没有关系：她说的 / 引用她 / @她或叫她的名字 / 主人说的 */
function 和她有关(key, m, 配置) {
  if (!m) return false
  if (m.isSelf) return true
  if (m.quoteTargetIsSelf) return true
  if (m.isOwner) return true
  const 文 = String(m.text || m.plain || '')
  if (!文) return false
  const 名字们 = Array.isArray(配置.她的名字) && 配置.她的名字.length
    ? 配置.她的名字
    : ['鱼鱼', 'taishu鱼鱼', '小鲸鱼', '鲸鱼娘']
  return 名字们.some((n) => n && 文.includes(String(n)))
}

/** 一条消息 → 一行日记 */
function 造一行(key, m) {
  // 群名片经常带括号和段位（「Kasumi33333（25段萌新）」），16 字会截成半截括号，放宽到 28
  // 私聊桥接给的 sender 是字面量「私聊」，换成「主人」更像日记
  const 原 = String(m.sender || '对方').slice(0, 28)
  const 谁 = m.isSelf ? '我' : (原 === '私聊' ? '主人' : 原)
  let 文 = String(m.text || m.plain || '').replace(/\s+/g, ' ').trim()
  if (!文) return ''
  if (文.length > 500) 文 = 文.slice(0, 500) + '…'
  return `- ${本地时分(m.time)} [${会话称呼(key)}] ${谁}：${文}`
}

/**
 * 归档桥接的「重置前消息」备份。
 *
 * 为什么需要：桥接重置会话时会 `socialV2.conversations.delete(key)`，把 recentMessages
 * 整个清掉；紧接着存一份 last-reset-messages.json，只在下次唤醒注入一次（读完就删）。
 * 星迹靠轮询 social-v2，重置那一瞬间之前的内容就再也捞不到了——这段等于凭空消失。
 * 所以这里额外读那份备份，把它也写进日记；水位按 rec.at 去重，重复扫也不会写两遍。
 */
function 归档重置备份(配置, 日记夹, 水位们) {
  const 源 = 配置.消息源 || 找消息源()
  if (!源) return 0
  const 备份路 = join(dirname(源), 'last-reset-messages.json')
  if (!existsSync(备份路)) return 0
  const 数据 = 读JSON(备份路, {})
  let 新增 = 0
  for (const [key, rec] of Object.entries(数据 || {})) {
    if (!rec || !Array.isArray(rec.messages) || !rec.messages.length) continue
    const 标记 = 'reset:' + key
    if (水位们[标记] === rec.at) continue // 这段已经归档过
    const 行们 = []
    for (const m of rec.messages) {
      const 行 = 造一行(key, m)
      if (行) 行们.push(行)
    }
    水位们[标记] = rec.at
    if (!行们.length) continue
    const 日 = 本地日期(Number(rec.at) || Date.now())
    const 文件 = join(日记夹, 日 + '.md')
    try {
      if (!existsSync(日记夹)) mkdirSync(日记夹, { recursive: true })
      if (!existsSync(文件)) writeFileSync(文件, `# ${日}\n\n`, 'utf8')
      let 前 = ''
      try { 前 = readFileSync(文件, 'utf8') } catch {}
      const 前缀 = 前 && !前.endsWith('\n\n') ? (前.endsWith('\n') ? '\n' : '\n\n') : ''
      appendFileSync(文件, 前缀 + 行们.join('\n') + '\n', 'utf8')
      新增 += 行们.length
    } catch (e) {
      记一笔('写重置备份失败 ' + 文件 + '：' + String((e && e.message) || e))
    }
  }
  return 新增
}

/**
 * 扫一轮消息源，把水位之后的新消息写进日记。
 * 返回 { 新增, 跳过 }
 */
function 归档一轮(配置) {
  const 源 = 配置.消息源 || 找消息源()
  if (!源 || !existsSync(源)) return { 新增: 0, 跳过: 0, 原因: '找不到消息源' }
  const 数据 = 读JSON(源, null)
  if (!数据 || !数据.conversations) return { 新增: 0, 跳过: 0, 原因: '消息源空' }

  const 日记夹 = String(配置.日记 || '')
  if (!日记夹) return { 新增: 0, 跳过: 0, 原因: '还没配日记目录（星汐那边也没配）' }

  const 水位们 = 读JSON(水位文件, {})
  let 新增 = 0
  let 跳过 = 0
  let 动过 = false

  for (const [key, 会话] of Object.entries(数据.conversations || {})) {
    const 消息们 = Array.isArray(会话 && 会话.recentMessages) ? 会话.recentMessages : []
    if (!消息们.length) continue
    const 旧 = 水位们[key] || null
    // 第一次见到这个会话：只把水位推到当前最新，不回溯历史
    if (!旧) {
      const 尾 = 消息们[消息们.length - 1]
      水位们[key] = { time: Number(尾.time) || 0, seq: Number(尾.seq) || 0 }
      动过 = true
      跳过 += 消息们.length
      continue
    }
    const 新们 = 消息们.filter((m) => {
      const t = Number(m.time) || 0
      const s = Number(m.seq) || 0
      return t > 旧.time || (t === 旧.time && s > 旧.seq)
    })
    if (!新们.length) continue

    // ⭐ 2026-11-19 加：群里的话不是每句都值得记。
    //   只留「和她有关」的：她说的、引用她的、@她/叫她名字的、主人说的。
    //   私聊全留（本来就是在跟她说话）。水位照常推进，不然会一直重扫。
    const 只记相关 = 配置.群聊只记相关 !== false
    const 该记 = 只记相关 && String(key).startsWith('group:')
      ? 新们.filter((m) => 和她有关(key, m, 配置))
      : 新们

    // 按天分桶
    const 桶 = new Map()
    for (const m of 该记) {
      const 行 = 造一行(key, m)
      if (!行) continue
      const 日 = 本地日期(m.time)
      if (!桶.has(日)) 桶.set(日, [])
      桶.get(日).push(行)
    }
    for (const [日, 行们] of 桶) {
      const 文件 = join(日记夹, 日 + '.md')
      try {
        if (!existsSync(日记夹)) mkdirSync(日记夹, { recursive: true })
        if (!existsSync(文件)) writeFileSync(文件, `# ${日}\n\n`, 'utf8')
        // 确保和前一段之间有空白行，别糊成一坨
        let 前 = ''
        try { 前 = readFileSync(文件, 'utf8') } catch {}
        const 前缀 = 前 && !前.endsWith('\n\n') ? (前.endsWith('\n') ? '\n' : '\n\n') : ''
        appendFileSync(文件, 前缀 + 行们.join('\n') + '\n', 'utf8')
        新增 += 行们.length
      } catch (e) {
        记一笔('写日记失败 ' + 文件 + '：' + String((e && e.message) || e))
      }
    }
    const 尾 = 新们[新们.length - 1]
    水位们[key] = { time: Number(尾.time) || 0, seq: Number(尾.seq) || 0 }
    动过 = true
  }

  // 桥接重置时会把 social-v2 清空，那段只能从 last-reset-messages.json 捞回来
  try {
    const 重置新增 = 归档重置备份(配置, 日记夹, 水位们)
    if (重置新增) {
      新增 += 重置新增
      动过 = true
      记一笔(`重置前那 ${重置新增} 条也补进日记了`)
    }
  } catch (e) {
    记一笔('归档重置备份出错：' + String((e && e.message) || e))
  }

  if (动过) 写JSON(水位文件, 水位们)
  if (新增) 记一笔(`归档 ${新增} 条新消息进日记`)
  return { 新增, 跳过 }
}

// ═══════════════════════════════════════════════════════
// 记忆卡：拆条 + 淡忘
// ═══════════════════════════════════════════════════════

/** 记忆卡 → [{章, 标题, 正文[]}] */
function 拆卡(文) {
  const 行们 = String(文 || '').split(/\r?\n/)
  const 出 = []
  let 章 = ''
  let 条 = null
  for (const 行 of 行们) {
    if (/^##\s+/.test(行)) {
      章 = 行.replace(/^##\s+/, '').trim()
      条 = null
      continue
    }
    if (/^###\s+/.test(行)) {
      条 = { 章, 标题: 行.replace(/^###\s+/, '').trim(), 正文: [] }
      出.push(条)
      continue
    }
    if (!行.trim()) continue
    if (条) 条.正文.push(行.trim())
    else if (章) {
      // 整章一段自述，没有 ###：整章算一条
      if (!出.length || 出[出.length - 1].章 !== 章 || 出[出.length - 1].标题 !== '') {
        条 = { 章, 标题: 章, 正文: [] }
        出.push(条)
      }
      条.正文.push(行.trim())
    }
  }
  return 出.filter((t) => t.标题 || t.正文.length)
}

/** 从一段文字里抠出最晚的日期（毫秒） */
function 最晚日期(文) {
  const 文s = String(文 || '')
  let 最晚 = 0
  // 2026-10-28 / 2026/10/28 / 2026年10月28日
  for (const m of 文s.matchAll(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/g)) {
    const t = Date.parse(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}T00:00:00+08:00`)
    if (t > 最晚) 最晚 = t
  }
  if (最晚) return 最晚
  // 10月28日 / 10-28（没有年份：按今年算，落到未来就退回去年）
  const 现在 = Date.now()
  for (const m of 文s.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const 年 = new Date(现在 + 时区偏移).getUTCFullYear()
    let t = Date.parse(`${年}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}T00:00:00+08:00`)
    if (t > 现在) t = Date.parse(`${年 - 1}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}T00:00:00+08:00`)
    if (t > 最晚) 最晚 = t
  }
  return 最晚
}

/** 这条大概多重要：1 琐事 / 3 一般 / 5 别忘 */
function 猜重要度(条) {
  const 文 = [条.章, 条.标题, ...条.正文].join(' ')
  if (/身份|你是|我叫|名字|称呼|关系|主人|约定|承诺|说好|答应|喜欢|讨厌|怕|忌讳|生日|不能提/.test(文)) return 5
  if (/技术|插件|代码|端口|部署|服务器|配置|安装|报错|调试/.test(文)) return 1
  if (/今天|昨天|那天|中午|晚上|早上|刚才|聊天|说话/.test(文)) return 2
  return 3
}

/** 条目指纹：章节 + 标题，够稳、改正文不会变 */
function 条指纹(条) {
  return (条.章 + '／' + 条.标题).slice(0, 120)
}

/**
 * 该不该淡忘。
 * 用户拍板：不删，只在注入时省略；原文一直在档案里，xingxi_read 随时能查回来。
 */
function 该淡忘(条, 权重, 配置, 档案最后更新) {
  const w = 权重[条指纹(条)] || {}
  if (w.钉住) return false
  const 重 = Number(w.重要度) || 猜重要度(条)
  if (重 >= 4) return false // 重要的事不淡忘
  const 最后 = Number(w.最后提及) || 最晚日期(条.标题 + ' ' + 条.正文.join(' ')) || 档案最后更新 || Date.now()
  const 天 = (Date.now() - 最后) / 86400000
  if (天 <= Number(配置.淡忘天数 || 15)) return false
  return 重 <= 2
}

// ═══════════════════════════════════════════════════════
// 造注入文本
// ═══════════════════════════════════════════════════════

function 最近日记摘要(日记夹, 天数 = 3, 每条最多 = 3) {
  const 出 = []
  try {
    const 文件们 = readdirSync(日记夹)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-天数)
    for (const f of 文件们) {
      const 文 = readFileSync(join(日记夹, f), 'utf8')
      const 行们 = 文.split(/\r?\n/).filter((l) => l.trim().startsWith('- '))
      const 取 = 行们.slice(-每条最多)
      if (!取.length) continue
      出.push(`【${f.replace(/\.md$/, '')}】`)
      出.push(...取.map((l) => '  ' + l.trim()))
    }
  } catch {}
  return 出
}

function 造星图(配置) {
  const 卡路 = String(配置.记忆卡 || '')
  if (!卡路 || !existsSync(卡路)) return ''
  let 卡文 = ''
  let 档案最后更新 = 0
  try {
    卡文 = readFileSync(卡路, 'utf8')
    档案最后更新 = statSync(卡路).mtimeMs
  } catch {
    return ''
  }
  const 条们 = 拆卡(卡文)
  if (!条们.length) return ''
  const 权重 = 读JSON(权重文件, {})

  const 章们 = new Map() // 章 → { 留下[], 淡掉[] }
  for (const 条 of 条们) {
    const 淡 = 该淡忘(条, 权重, 配置, 档案最后更新)
    if (!章们.has(条.章)) 章们.set(条.章, { 存: [], 淡: [] })
    ;(淡 ? 章们.get(条.章).淡 : 章们.get(条.章).存).push(条)
  }

  const 段们 = ['【你的记忆 · 星图】', '下面是你自己记的事（你和爸爸之间的事），不是别人说的。', '']
  for (const [章, { 存 }] of 章们) {
    if (!存.length) continue
    // ⭐ 按章限流：第一章（身份）每次都完整带上，其余章取最近几条。
    //   截断长度做成配置：要「完整」就把 身份条上限字 调大（默认 200，基本等于不截）。
    const 是身份章 = /^一、/.test(章)
    const 取 = 是身份章 ? 存.slice(0, 12) : 存.slice(-2)
    const 上限 = Math.max(40, Number(是身份章
      ? (配置.身份条上限字 || 400)
      : (配置.其他条上限字 || 120)))
    const 行 = []
    for (const 条 of 取) {
      const 正文 = 条.正文
        .filter((l) => !/^>/.test(l))
        .map((l) => l.replace(/^[-*+]\s+/, '').trim())
        .filter(Boolean)
        .join('；')
        .replace(/\s+/g, ' ')
        .trim()
      if (条.标题 && 条.标题 !== 章) 行.push(`- ${条.标题}：${正文.slice(0, 上限)}`)
      else if (正文) 行.push(`- ${正文.slice(0, 上限 + 25)}`)
    }
    if (!行.length) continue
    段们.push(`【${章}】`, ...行, '')
  }

  const 淡淡 = []
  for (const [章, { 淡 }] of 章们) {
    for (const 条 of 淡) 淡淡.push(`${章} · ${条.标题}`)
  }
  if (淡淡.length) {
    段们.push('【慢慢淡掉的旧事】（只记得有这些，细节想不起来；真要查就用 xingxi_read 翻原文，别编）')
    for (const t of 淡淡.slice(0, 24)) 段们.push(`- ${t}`)
    段们.push('')
  }

  const 日记夹 = String(配置.日记 || '')
  if (日记夹 && existsSync(日记夹)) {
    // 只取最近一天的最后几条：她要的是「刚刚说了什么」，不是三天前的流水
    const 最近 = 最近日记摘要(日记夹, 1, 6)
    if (最近.length) {
      段们.push('【最近几天】', ...最近, '')
    }
  }

  段们.push('想不起具体哪一天、原话怎么说 → 用 xingxi_read(关键词="…") 或 xingxi_read(日期="2026-11-19") 去档案里查，别猜。')

  let 文 = 段们.join('\n')
  const 上限 = Math.max(400, Number(配置.注入上限字 || 2000))
  if (文.length > 上限) 文 = 文.slice(0, 上限) + '\n（星图太长，截断了；要细节用 xingxi_read 查）'
  return 文
}

// ═══════════════════════════════════════════════════════
// 装配
// ═══════════════════════════════════════════════════════

function 该管这个会话(会话id, 配置) {
  const id = String(会话id || '')
  if (!id) return false
  const 前缀们 = Array.isArray(配置.会话前缀) ? 配置.会话前缀 : ['qqb-']
  return 前缀们.some((p) => p && id.startsWith(String(p)))
}

// ═══════════════════════════════════════════════════════
// 自动长记忆卡：把新日记提炼成条目（调模型）
//   ⚠ 这一步才花钱、才慢，所以跟「写日记」分开：
//   日记实时落盘，提炼按冷却时间攒着做，失败也不影响归档。
// ═══════════════════════════════════════════════════════

const 提炼状态文件 = join(根, 'refine.json')

/** 调一次模型，把文本收齐 */
async function 调模型(llm, 提示词, 配置) {
  const 块们 = []
  let 坏了 = ''
  for await (const 块 of llm.stream({
    provider: (配置.模型 && 配置.模型.provider) || 'deepseek-account',
    model: (配置.模型 && 配置.模型.model) || 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 提示词 }] }],
  })) {
    if (块.type === 'text-delta' && 块.text) 块们.push(块.text)
    if (块.type === 'finish' && (块.reason === 'error' || 块.reason === 'aborted')) 坏了 = String(块.reason)
  }
  if (坏了) throw new Error('模型没正常收尾：' + 坏了)
  return 块们.join('').trim()
}

function 章名们(卡文) {
  return [...String(卡文 || '').matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
}

function 造提炼词(行们, 章们) {
  return `你在帮一个叫「鱼鱼」的 AI 整理长期记忆。下面是今天新发生的对话（只有和她有关的才被记下来），以及她记忆卡现有的章节。

请提炼出值得长期记住的事，写成记忆卡条目。

规则：
1. 只写她和主人（爸爸，QQ 2750223479）之间的事：他说了什么、做了什么、约定了什么、她的心情。
2. 群友之间聊游戏、配置、技术、别人的事——一律不写。
3. 一条只写一件小事；标题不超过 12 个字；正文一行、不超过 60 字，以「- 」开头。
4. 每条标重要度（1~5）：5 = 身份、关系、约定、承诺、喜好、忌讳；3 = 值得记的日常；1 = 琐事。
5. 没什么值得记的，只输出一行「无」。

输出格式严格照这个来，不要输出别的内容：
【章】二、最近
【条】标题
【度】3
【文】- 内容

现有章名（能用就用里面的，实在要开新章再自己起）：
${章们.join('、') || '（还没有章节）'}

对话记录：
${行们.join('\n')}`
}

/**
 * 跟角色卡硬规则冲突、绝对不能进记忆卡的内容。
 * 只拦「出现就是错的」这几种，不拦「被告诫不要这样」（角色卡里本来就有这类句子）。
 * 起因：自动提炼是模型写的，它可能把「客服腔 / 本小姐 / 认错爹」写成她的记忆，
 * 下一轮她就照着记忆演，等于慢慢被改性格。
 */
const 违禁规则 = [
  { 名: '自称本小姐', 匹: /本小姐/ },
  { 名: '认错爹', 匹: /(梁文锋|梁圣)[^。]{0,10}(是|也是|当)[^。]{0,6}(爸爸|爹)/ },
  { 名: 'AI 味', 匹: /作为(一个)?(AI|人工智能|语言模型)/ },
  { 名: '客服腔', 匹: /很高兴为您服务|随时为您效劳|请问还有什么可以帮/ },
]

function 违禁内容(条) {
  const 文 = [条.标题, 条.文].join(' ')
  return 违禁规则.filter((r) => r.匹.test(文)).map((r) => r.名)
}

function 解析提炼(文) {
  const 出 = []
  const 块们 = String(文 || '').split(/【章】/).slice(1)
  for (const 块 of 块们) {
    const 章 = (块.match(/^\s*([^\n]+)/) || [])[1] || ''
    const 标题 = (块.match(/【条】\s*([^\n]+)/) || [])[1] || ''
    const 度 = Number((块.match(/【度】\s*(\d+)/) || [])[1]) || 3
    const 正文 = (块.match(/【文】\s*([^\n]+)/) || [])[1] || ''
    if (!标题.trim() || !正文.trim()) continue
    const 体 = 正文.trim().startsWith('- ') ? 正文.trim() : '- ' + 正文.trim()
    出.push({
      章: (章 || '二、最近').trim(),
      标题: 标题.trim().slice(0, 40),
      文: 体,
      度: Math.min(5, Math.max(1, 度)),
    })
  }
  return 出
}

/** 把条目按章追加进记忆卡（标题已存在就跳过），返回写进去几条 */
function 写进记忆卡(卡路, 条们) {
  if (!条们.length) return 0
  let 文 = readFileSync(卡路, 'utf8')
  const 已有 = new Set([...文.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim()))
  const 按章 = new Map()
  for (const t of 条们) {
    if (已有.has(t.标题)) continue
    已有.add(t.标题)
    if (!按章.has(t.章)) 按章.set(t.章, [])
    按章.get(t.章).push(t)
  }
  if (!按章.size) return 0
  // 改档案前先备份，只留最近 20 份（跟星汐一个习惯）
  try {
    const 备份 = 卡路 + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(备份, 文, 'utf8')
    const 夹 = dirname(卡路)
    const 老们 = readdirSync(夹).filter((f) => f.startsWith(basename(卡路) + '.bak-')).sort()
    for (const f of 老们.slice(0, Math.max(0, 老们.length - 20))) {
      try { rmSync(join(夹, f), { force: true }) } catch {}
    }
  } catch {}
  let 写了 = 0
  for (const [章, 条们2] of 按章) {
    const 块 = 条们2.map((t) => `### ${t.标题}\n${t.文}`).join('\n\n')
    const 章头 = 文.indexOf(`## ${章}`)
    if (章头 < 0) {
      文 = 文.trimEnd() + `\n\n## ${章}\n\n${块}\n`
    } else {
      const 下个 = 文.indexOf('\n## ', 章头 + 3)
      const 插入点 = 下个 < 0 ? 文.length : 下个
      文 = 文.slice(0, 插入点).trimEnd() + '\n\n' + 块 + '\n' + 文.slice(插入点)
    }
    写了 += 条们2.length
  }
  writeFileSync(卡路, 文, 'utf8')
  return 写了
}

/**
 * 提炼一轮：把日记里还没提炼的行交给模型，产出记忆卡条目并写回。
 * @param 选项.强制 跳过冷却（会话刚重置时用：让这段尽快进记忆卡，下次重建就能带上）
 * @returns {跳过?: string, 新增?: number, 条?: number}
 */
async function 提炼一轮(llm, 配置, 选项 = {}) {
  const 卡路 = String(配置.记忆卡 || '')
  const 日记夹 = String(配置.日记 || '')
  if (!llm) return { 跳过: '没有 llm 服务' }
  if (!卡路 || !existsSync(卡路)) return { 跳过: '记忆卡没配' }
  if (!日记夹 || !existsSync(日记夹)) return { 跳过: '日记目录没配' }

  const 边 = 读JSON(提炼状态文件, {})
  const 冷却 = Math.max(60, Number(配置.提炼冷却秒 || 900)) * 1000
  if (!选项.强制 && Date.now() - Number(边.上次 || 0) < 冷却) return { 跳过: '冷却中' }

  // 最多看最近两天：更早的归星汐的拾星管
  const 文件们 = readdirSync(日记夹).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-2)
  const 待 = []
  const 行数表 = {}
  for (const f of 文件们) {
    let 行们 = []
    try { 行们 = readFileSync(join(日记夹, f), 'utf8').split(/\r?\n/) } catch { continue }
    // 末尾那个空串不算一行：不然水位会「多记一行」，新追加的第一行正好被它吃掉
    if (行们.length && 行们[行们.length - 1] === '') 行们.pop()
    行数表[f] = 行们.length
    const 已 = Number(边[f] || 0)
    const 新 = 行们.slice(已).filter((l) => l.trim().startsWith('- '))
    if (新.length) 待.push(...新)
  }
  if (!待.length) return { 跳过: '没有新内容' }

  const 卡文 = readFileSync(卡路, 'utf8')
  const 提示 = 造提炼词(待, 章名们(卡文))
  const 答 = await 调模型(llm, 提示, 配置)
  if (!答) return { 跳过: '模型没吭声' }
  if (/【条】/.test(答) === false && /^\s*无\s*$/m.test(答)) {
    // 明确说没啥可记：水位照推，免得反复问同一个模型
    for (const f of 文件们) 边[f] = 行数表[f]
    边.上次 = Date.now()
    写JSON(提炼状态文件, 边)
    return { 跳过: '模型认为不值得记', 新增: 待.length }
  }
  const 条们 = 解析提炼(答)
  if (!条们.length) return { 跳过: '解析不出条目', 原文: 答.slice(0, 200) }
  // 过一遍硬规则：跟角色卡冲突的条目不写进记忆卡（不然下一轮她会照着记忆演）
  const 可用 = []
  const 拦下 = []
  for (const t of 条们) {
    const 撞 = 违禁内容(t)
    if (撞.length) 拦下.push(`${t.标题}（${撞.join('/')}）`)
    else 可用.push(t)
  }
  if (拦下.length) 记一笔(`拦下 ${拦下.length} 条跟角色卡冲突的记忆：${拦下.join('、')}`)
  if (!可用.length) return { 跳过: '条目全撞硬规则', 原文: 答.slice(0, 200) }
  const 写了 = 写进记忆卡(卡路, 可用)
  const 权重 = 读JSON(权重文件, {})
  const 今天 = 本地日期(Date.now())
  for (const t of 可用) 权重[t.章 + '／' + t.标题] = { 重要度: t.度, 最后提及: 今天 }
  写JSON(权重文件, 权重)
  for (const f of 文件们) 边[f] = 行数表[f]
  边.上次 = Date.now()
  写JSON(提炼状态文件, 边)
  记一笔(`提炼：看了 ${待.length} 行，写进记忆卡 ${写了} 条`)
  return { 新增: 待.length, 条: 写了 }
}

export { 归档一轮, 造星图, 拆卡, 该淡忘, 取配置, 找消息源, 默认配置, 最近日记摘要, 提炼一轮, 解析提炼, 写进记忆卡, 造提炼词, 归档重置备份, 违禁内容 }

export function apply(ctx, 配置 = {}) {
  const 生效 = { ...默认配置, ...(配置 || {}) }
  // 借星汐的路径（配置里没写才借）
  if (!生效.记忆卡 || !生效.日记) {
    const 借 = 从星汐借路径()
    if (!生效.记忆卡) 生效.记忆卡 = 借.记忆卡
    if (!生效.日记) 生效.日记 = 借.日记
  }
  记一笔(`星迹启动：记忆卡=${生效.记忆卡 || '(空)'} 日记=${生效.日记 || '(空)'} 轮询=${生效.轮询秒}s`)

  // ── ① 自动归档：定时把新消息收进日记；有新东西就顺手提炼进记忆卡 ──
  const llm = (ctx && ctx.llm) || (typeof ctx.get === 'function' ? ctx.get('llm') : null)
  let 待提炼 = false
  let 提炼中 = false
  const 提炼一下 = (强制 = false) => {
    if (!llm || 生效.自动提炼 === false) return
    if (提炼中) return
    提炼中 = true
    const 配置现在 = { ...生效, ...读JSON(配置文件, {}) }
    提炼一轮(llm, 配置现在, { 强制 })
      .then((x) => {
        if (x.跳过 && x.跳过 !== '冷却中' && x.跳过 !== '没有新内容') {
          记一笔('提炼没做：' + x.跳过 + (x.原文 ? '｜' + x.原文.replace(/\n/g, ' ') : ''))
        }
        if (x.跳过 === '冷却中') return
        待提炼 = false
      })
      .catch((e) => 记一笔('提炼失败：' + String((e && e.message) || e)))
      .finally(() => { 提炼中 = false })
  }

  const 跑一轮 = () => {
    try {
      const 配置现在 = { ...生效, ...读JSON(配置文件, {}) }
      const r = 归档一轮(配置现在)
      if (r.新增 > 0) 待提炼 = true
      if (r.原因) {
        // 只在第一次说一声，别每 30 秒刷一遍日志
        if (!跑一轮.说过) {
          记一笔('归档没跑起来：' + r.原因)
          跑一轮.说过 = true
        }
      }
    } catch (e) {
      记一笔('归档出错：' + String((e && e.message) || e))
    }
    if (待提炼) 提炼一下()
  }

  if (生效.自动归档 !== false) {
    try {
      const 定时服务 = typeof ctx.get === 'function' ? ctx.get('timer') : undefined
      const 毫秒 = Math.max(5, Number(生效.轮询秒 || 30)) * 1000
      if (定时服务 && typeof 定时服务.repeat === 'function') {
        ctx.effect(() => 定时服务.repeat(跑一轮, 毫秒))
      } else {
        const t = setInterval(跑一轮, 毫秒)
        ctx.effect(() => () => clearInterval(t))
      }
      // 启动后先跑一次
      setTimeout(跑一轮, 1200)
      // 再把「之前攒着没提炼的」补一次（比如上次关机/插件没跑的时候留下的）
      setTimeout(() => { 待提炼 = true; 提炼一下() }, 5000)
    } catch (e) {
      记一笔('定时挂不上：' + String((e && e.message) || e))
    }
  }

  // ── ② 自动带入：会话一重建，就把星图塞进开头 ──
  const 上次注入 = new Map()
  const 注入 = (agent) => {
    try {
      const 配置现在 = { ...生效, ...读JSON(配置文件, {}) }
      if (配置现在.自动注入 === false) return
      const 会话id = String((agent && agent.session && agent.session.id) || (agent && agent.id) || '')
      if (!该管这个会话(会话id, 配置现在)) return
      // 同一会话 60 秒内只注入一次：DSH 内部可能连着 resume 好几次，别重复塞
      const 上次 = Number(上次注入.get(会话id) || 0)
      if (Date.now() - 上次 < 60000) return
      const 文 = 造星图(配置现在)
      if (!文) {
        记一笔(`会话 ${会话id.slice(0, 20)} 重建了，但档案还读不到，没注入`)
        return
      }
      上次注入.set(会话id, Date.now())
      // 注入是「模型看得见、但不唤醒」的上下文，会跟着会话第一次 pre-step 进上下文。
      // ⚠ id + role 必须给：DSH 的 UserMessage 要求 id（brandString<MessageId>）和 role，
      //   少给会被存进会话日志后校验失败（stored session ... lacks an identified message），
      //   整个会话变成 corrupt，桥接就连不上事件流了。
      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 文 }],
        source: { kind: 'plugin:xingji' },
      })
      记一笔(`会话 ${会话id.slice(0, 20)} 重建 → 注入星图 ${文.length} 字`)
      // 重开对话时把上一段提炼进记忆卡：这里**强制跳过冷却**，
      // 不然刚聊完这段要等 15 分钟才进记忆卡，下次重建时她仍然想不起来。
      待提炼 = true
      提炼一下(true)
    } catch (e) {
      记一笔('注入失败：' + String((e && e.message) || e))
    }
  }

  try {
    ctx.on('agent/created', (payload) => {
      // ⭐ startup（全新会话）和 resume（恢复已有会话）都要注入。
      //   桥接重启后用的是同一个预分配 sessionId，DSH 那边走的是 resume 而不是 startup——
      //   只认 startup 的话，"每次重启自动打一遍 /xingxi"就永远不触发。
      if (!payload) return
      注入(payload.agent)
    })
  } catch (e) {
    记一笔('agent/created 监听听不上：' + String((e && e.message) || e))
  }

  // ── ③ 会话一结束就归档（不等定时，也别等它挤在滚动窗口里丢掉） ──
  try {
    ctx.on('agent/disposed', () => {
      try {
        归档一轮({ ...生效, ...读JSON(配置文件, {}) })
      } catch (e) {
        记一笔('会话结束时归档失败：' + String((e && e.message) || e))
      }
    })
  } catch (e) {
    记一笔('agent/disposed 监听听不上：' + String((e && e.message) || e))
  }
}
