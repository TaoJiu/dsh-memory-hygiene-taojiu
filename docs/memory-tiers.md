# 记忆分层与冷热调整

> 适用：DSH（DeepSeek Harness）+ `dsh-core-memory` 插件。路径按 `~/.dsh` 写；Obsidian vault 和知识库目录请换成你自己的。

## 一、为什么要分层

核心记忆 `MEMORY.md` 每个会话都会注入，是上下文里最贵的固定成本；归档记忆只在 `memory_search` 时按需读取；Obsidian 笔记完全不占上下文。

`dsh-core-memory` 的 `lib/index.js` 在 `core.length > 3000` 时直接截断，并追加「核心记忆过长已截断」提示。也就是说 **3000 是硬上限，不是建议值**。

## 二、三层与预算

| 层 | 载体 | 预算 / 限制 | 放什么 | 读取方式 |
|---|---|---|---|---|
| 热 | `~/.dsh/memory/MEMORY.md` | ≤2500 字符（预算），3000 字符（截断上限），留 500 缓冲 | 每轮都该遵守的规则、触发词路由、环境路径、设备边界 | 每会话自动注入 |
| 温 | `~/.dsh/memory/notes/` + `index.json` | 不设硬上限 | 带日期的事实、一次性结论、历史决策、待查细节 | `memory_search` / `memory_read` |
| 冷 | Obsidian 笔记（`知识库/` 优先） | 不设硬上限 | 命令/参数/步骤类手册、可复查的长流程 | 打开笔记 / 搜索 |

## 三、字符口径（容易踩的坑）

【事实】插件按 `core.length` 截断——这是 JS 字符数（UTF-16 码元），不是 UTF-8 字节数；但 `memory_core` 的返回文案写的是「当前核心记忆 N 字节」（`lib/index.js:370` 传的却是 `next.length`），文案单位写错了。

举例：某个 `MEMORY.md` 的 `.length = 1200`，UTF-8 字节可能是 2100。判断 2500 预算 / 3000 截断时，用 **1200 字符**，不是 2100。

`memory-stats.mjs` 会同时打印字符和字节，判定一律用字符。

## 四、判定表

### 上升（温/冷 → 热）三条

1. **被用户纠正过的错**：已经沉淀成稳定规则、且每轮都该遵守的，规则化后进热层。
2. **每轮必备**：触发词路由、环境路径、设备边界、硬性流程。
3. **超过三行的一律只进温层**：长解释、长步骤不进 `MEMORY.md`。

### 下降（热 → 温/冷）三条

1. **核心 >2500 字符**：把「最不常触发」的降为归档，并在热层留一行指针。
2. **带日期且 30 天未引用的细节**：归档。插件没有「引用次数」统计，「未引用」只能人工判断，不能假装有数据。
3. **命令/参数/步骤类细则**：下沉知识库笔记，热层只留路径。

> 降级不是删除。先把内容 `memory_write` 成归档，确认成功，再精简热层；删除只在用户明确要求时做。

## 五、触发时机

1. 每次 `memory_core` 操作返回「当前 N 字节」时看数字，N > 2500 当场提示并走降级流程（记住 N 是字符数）。
2. 每周固定时间跑一次自查。
3. 用户说「记忆精简 / 整理记忆 / 记忆体检 / 记忆自查」时立即执行。

## 六、执行流程

1. 跑只读脚本：`node ~/.dsh/tools/memory-stats.mjs`（加 `--json` 可机器读）。
2. 核数：脚本数字与实际文件对一遍；索引异常先报告，不擅自修。
3. 出建议清单：逐条写「动作 / 对象 / 判定表依据 / 建议落点 / 风险」，**只出清单，不改文件**。
4. 等用户确认：没有明确指令就不动 `MEMORY.md`、不动归档、不动笔记。
5. 执行：降到温层用 `memory_write` + `memory_core`；降到冷层用 `obsidian_write` 并在热层留路径；上升用 `memory_read` 取全文后压成 ≤3 行规则。
6. 复核：再跑脚本，给出「改动前 → 改动后」字符数对照。
7. 留痕：重大调整写一条归档记忆，标签含「记忆分层」。

## 七、归档索引的坑

`index.json` 是派生索引，`memory_search` / `memory_list` 读的是它。如果 `notes/` 里有活跃 md、但 `index.json` 没收录，那些记忆就**检索不到**——文件还在，只是索引缺了。

处理方式：

1. 先把旧 `index.json` 移到记忆同步目录之外（例如 `~/.dsh/backups/`），不要放在 `~/.dsh/memory/backup/` 这类会被同步的目录。
2. 让插件下一次 `loadIndex` 读不到索引，走 `rebuildIndex()` 从 `notes/` 重建；也可以写一条新归档记忆触发一次写索引。
3. 重建后核对：索引条目数 = `notes/` 活跃 md 数（墓碑文件 `deleted: true` 不算）。
4. 不要手工拼接索引条目；要修就整份重建。

如果你用 `dsh-memory-sync`，它默认不同步 `index.json`，各机从 `notes/` 自行重建。注意：如果本机的 `index.json` 已经存在但过期，插件不会自动重建，需要按上面的方式处理。

## 八、和 Anthropic 官方 memory-management skill 的关系

Anthropic 官方的 **memory-management** skill 采用两层结构：

- `CLAUDE.md`：热缓存，放最常用的人名、术语、活跃项目、偏好，目标覆盖 90% 的日常解码需求；
- `memory/`：完整知识库，放 glossary、people、projects、context，按需检索。

对应到本项目：

| 官方 skill | 本项目 |
|---|---|
| `CLAUDE.md` 热缓存 | `MEMORY.md` 热层 |
| `memory/` 深度库 | 归档记忆（温层）+ Obsidian 笔记（冷层） |
| 高频信息进热缓存 | 上升：规则、触发词、环境路径 |
| 低频细节下沉 | 下降：日期细节、命令/参数、长流程 |

本项目在官方两层思路上扩展出第三层（Obsidian），并加入 DSH 特有的 2500/3000 字符预算和「先确认再改」的执行闸门。

官方链接：

- <https://github.com/anthropics/knowledge-work-plugins>
- <https://github.com/anthropics/knowledge-work-plugins/blob/main/productivity/skills/memory-management/SKILL.md>

本项目不是 Anthropic 官方项目。

## 九、已知限制

- 插件没有「记忆被引用次数」统计，所以「30 天未引用」只能人工判断。
- `memory_search` 是子串匹配，不是语义检索；关键词要换 2–3 个近义词。
- 字符预算和截断逻辑绑定 `dsh-core-memory` 的具体实现；换插件或换版本要重新核对。
