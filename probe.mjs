import { readFileSync } from "node:fs"
const p = "C:/Users/叶安/Documents/deepseek-harness/default-workspace/qq-bridge/state/social-v2.json"
const d = JSON.parse(readFileSync(p, "utf8"))
console.log("顶层键:", Object.keys(d))
for (const [k, v] of Object.entries(d.conversations || {})) {
  const ms = v.recentMessages || []
  console.log(k, "→ recentMessages:", ms.length, "第一条:", ms[0]?.time, "最后:", ms.at(-1)?.time, "最后sender:", ms.at(-1)?.sender, "isSelf:", ms.at(-1)?.isSelf)
}
