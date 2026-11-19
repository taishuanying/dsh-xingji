# patches

这里放对别的插件的本地补丁。升级插件后补丁会丢，记得重新打。

## xingxi-graph-fallback.patch

**给 [dsh-xingxi](https://github.com/Yuuyuko-uu/dsh-xingxi) 的补丁**（对 0.4.1 打的）。

### 解决什么

星汐的星图是**按会话**绑档案的。新开一个 Web 对话（没绑过文件夹），打开星汐面板是一张空图，
看起来像「星图没了」。实际档案在，只是这个会话没绑定。

补丁把 `出图()` 的回退改掉：**找不到绑定的会话时，回退到「本机档案」**（配置里 `记忆卡` + `日记` 两项），
看到的是同一张公共星图。注意不是退回第一个会话——那才是拿别人的图冒充。

### 怎么打

```bash
# 在 dsh-xingxi 仓库根目录
git apply patches/xingxi-graph-fallback.patch
```

装的是 npm 包、没有仓库的话，直接改 `node_modules/dsh-xingxi/index.js`：
搜 `const 当本机 = 会话id === '__本机__' && !这项`，整行换成 `const 当本机 = !这项`。

### 验证

```js
// 用任意一个没绑过档案的会话 id 调，应该返回星而不是空
const m = await import('./index.js')
m.出图('session-never-bound', []).星.length  // > 0
```

### 注意

- 这是改第三方插件的安装副本，`dsh plugin add dsh-xingxi` 升级会覆盖
- 长期方案：把这个改动提到上游（issue / PR），或者 fork 一份用 link 装
