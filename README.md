# dsh-memory-hygiene

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的跨会话记忆做**冷热分层体检**：热层 `MEMORY.md`、温层归档记忆、冷层 Obsidian 笔记。

核心记忆每个会话都会注入。DSH 的 `dsh-core-memory` 插件在核心记忆超过 **3000 字符**时会截断；把什么内容都塞进热层，等于每轮都在为低频细节付上下文成本。这个项目提供一个只读体检脚本和一个 skill，帮你判断：哪些内容该留在热层、哪些该下沉、现在离预算还有多远。

> 分层思路参考了 **Anthropic 官方的 memory-management skill**：用 `CLAUDE.md` 做热缓存、`memory/` 目录做深度库的两层结构。本项目在这个思路上扩展为三层，并加入字符预算、升降判定表与「先确认再改」的执行流程。详见 [参考与致谢](#参考与致谢)。

## 包含什么

| 文件 | 作用 |
|---|---|
| `tools/memory-stats.mjs` | 只读体检：`MEMORY.md` 分节字符数、归档条目数、`index.json` 与 `notes/` 一致性、升降候选；支持 `--json` |
| `skills/memory-hygiene/SKILL.md` | DSH skill：触发词、每周自查、`memory_core` 超预算提示；流程是「跑脚本 → 出建议 → 等确认 → 再改」 |
| `docs/memory-tiers.md` | 三层模型、判定表、字符口径、归档索引重建的坑 |

## 三层

| 层 | 载体 | 预算 / 限制 | 放什么 |
|---|---|---|---|
| 热 | `~/.dsh/memory/MEMORY.md` | ≤2500 字符（预算），3000 字符（插件截断上限），留 500 缓冲 | 每轮都该遵守的规则、触发词路由、环境路径、设备边界 |
| 温 | `~/.dsh/memory/notes/` + `index.json` | 不设硬上限 | 带日期的事实、一次性结论、历史决策、待查细节 |
| 冷 | Obsidian 笔记（`知识库/` 优先） | 不设硬上限 | 命令/参数/步骤类手册、可复查的长流程 |

## 快速开始

```bash
# 1. 把脚本和 skill 放到 DSH 的用户目录
mkdir -p ~/.dsh/tools ~/.dsh/skills
cp tools/memory-stats.mjs ~/.dsh/tools/
cp -r skills/memory-hygiene ~/.dsh/skills/

# 2. 跑一次只读体检
node ~/.dsh/tools/memory-stats.mjs

# 3. 机器可读
node ~/.dsh/tools/memory-stats.mjs --json
```

DSH 会从 `~/.dsh/skills/` 发现 `memory-hygiene`。如果你的 DSH 版本不会热加载 skill，重启一次 DSH 即可。

## 判定表（摘要）

**上升（温/冷 → 热）**

1. 被用户纠正过、已经沉淀成稳定规则的错。
2. 每轮必备：触发词路由、环境路径、设备边界、硬性流程。
3. 超过三行的内容一律只进温层，别塞 `MEMORY.md`。

**下降（热 → 温/冷）**

1. 核心 >2500 字符：把「最不常触发」的降为归档，热层留一行指针。
2. 带日期且 30 天未引用的细节：归档（插件没有引用次数统计，「未引用」只能人工判断）。
3. 命令/参数/步骤类细则：下沉知识库，热层留路径。

> 降级不是删除。先写归档，确认成功，再精简热层。

## 字符口径（重要）

`dsh-core-memory` 的 `lib/index.js` 用 `core.length` 判断是否超过 3000——这是 **JS 字符数**（UTF-16 码元），不是 UTF-8 字节数；但 `memory_core` 的返回文案写的是「当前核心记忆 N 字节」，单位写错了。

所以判断 2500 预算 / 3000 截断时，看 **字符数**，不要看字节数。`memory-stats.mjs` 会同时打印两者，判定用字符。

## 参考与致谢

分层思路参考了 Anthropic 官方的 **memory-management** skill：

- 仓库：<https://github.com/anthropics/knowledge-work-plugins>
- skill 文件：<https://github.com/anthropics/knowledge-work-plugins/blob/main/productivity/skills/memory-management/SKILL.md>

它用 `CLAUDE.md` 做热缓存（约 30 个常用联系人 / 30 个高频术语 / 5–15 个活跃项目），用 `memory/` 目录做完整知识库。本项目把「热缓存 + 深度库」扩展为三层（热 / 温 / 冷），并补上 DSH 的字符预算、判定表和 `memory_core` / `memory_write` 执行流程。

本项目不是 Anthropic 官方项目，只是参考了其公开 skill 的分层思路。

## License

MIT
