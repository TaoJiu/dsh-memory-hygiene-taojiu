#!/usr/bin/env node
/**
 * memory-stats — DSH 记忆分层（热/温/冷）体检脚本
 * License: MIT
 *
 * 数据来源（全部只读）：
 *   热层  ~/.dsh/memory/MEMORY.md          （插件每轮注入，超过 3000 字符会被截断）
 *   温层  ~/.dsh/memory/index.json + notes/（归档记忆，memory_write / memory_search）
 *   附加  ~/.dsh/memory/PERSONA.md          （回复风格，单独注入，不占 MEMORY.md 额度）
 *
 * 用法：
 *   node ~/.dsh/tools/memory-stats.mjs            # 人读报告
 *   node ~/.dsh/tools/memory-stats.mjs --json     # 机器可读
 *   node ~/.dsh/tools/memory-stats.mjs --help
 *   --core/--index/--notes/--persona <path>       # 覆盖默认路径（PC 调试用）
 *
 * 判定口径（与 dsh-core-memory v1.0.1 源码一致）：
 *   - 插件 line 244 用 core.length > 3000 截断，core.length 是 JS 字符数（UTF-16 码元），
 *     不是 UTF-8 字节数；line 370 的返回文案却写成「字节」，属于文案错误。
 *   - 因此本脚本的 2500 预算 / 3000 上限都按「字符」判定；字节数仅作参考。
 *
 * 只出报告，不改任何文件。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DEFAULT_CORE = join(DSH_HOME, 'memory', 'MEMORY.md');
const DEFAULT_INDEX = join(DSH_HOME, 'memory', 'index.json');
const DEFAULT_NOTES = join(DSH_HOME, 'memory', 'notes');
const DEFAULT_PERSONA = join(DSH_HOME, 'memory', 'PERSONA.md');

const BUDGET = 2500;   // 热层预算（字符）
const LIMIT = 3000;    // 插件截断上限（字符）
const AGED_DAYS = 30;  // 细节归档的年龄阈值（天）

function usage() {
  return `memory-stats — 记忆分层体检（只读）

用法：
  node ~/.dsh/tools/memory-stats.mjs [选项]

选项：
  --json              输出 JSON（方便后续接自动化）
  --core <path>       覆盖 MEMORY.md 路径
  --index <path>      覆盖 index.json 路径
  --notes <path>      覆盖归档 notes/ 目录
  --persona <path>    覆盖 PERSONA.md 路径
  -h, --help          显示本帮助

默认路径：${DEFAULT_CORE}
          ${DEFAULT_INDEX}
          ${DEFAULT_NOTES}
          ${DEFAULT_PERSONA}

判定：热层预算 ${BUDGET} 字符，插件注入上限 ${LIMIT} 字符（超 ${LIMIT} 截断）。
`;
}

function parseArgs(argv) {
  const opts = {
    core: DEFAULT_CORE,
    index: DEFAULT_INDEX,
    notes: DEFAULT_NOTES,
    persona: DEFAULT_PERSONA,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--core') opts.core = argv[++i];
    else if (a === '--index') opts.index = argv[++i];
    else if (a === '--notes') opts.notes = argv[++i];
    else if (a === '--persona') opts.persona = argv[++i];
    else {
      console.error(`未知参数：${a}\n${usage()}`);
      process.exit(2);
    }
  }
  return opts;
}

function nowShanghai() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date());
  return parts.replace('T', ' ');
}

function fmt(n) {
  return Number(n).toLocaleString('zh-CN');
}

/** 按 `## 标题` 切分核心记忆；字符口径与插件 core.length 一致。 */
function parseCore(text) {
  const marks = [];
  const re = /^##[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ title: m[1], start: m.index });
  }
  const sections = marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const chunk = text.slice(mk.start, end);
    const body = chunk.replace(/^##[ \t]+.*$/m, '');
    return {
      title: mk.title,
      chars: chunk.length,
      bytes: Buffer.byteLength(chunk),
      lines: body.split('\n').filter((l) => l.trim()).length,
      body,
    };
  });
  const headerChars = marks.length ? marks[0].start : text.length;
  return {
    header: {
      chars: headerChars,
      bytes: Buffer.byteLength(text.slice(0, headerChars)),
      lines: text.slice(0, headerChars).split('\n').filter((l) => l.trim()).length,
    },
    sections,
  };
}

/** 读归档索引 + notes/ 目录，核对两者是否一致。 */
function readArchive(opts) {
  const out = {
    indexError: null,
    notes: [],
    files: [],
    tombstones: 0,
    orphanLive: [],   // 有活跃 md、但不在 index.json → memory_search 看不到
    missingFiles: [], // index.json 有、但 md 不存在
  };
  try {
    const parsed = JSON.parse(readFileSync(opts.index, 'utf8'));
    if (parsed && Array.isArray(parsed.notes)) {
      out.notes = parsed.notes.filter((n) => n && typeof n.id === 'string');
    } else {
      out.indexError = 'index.json 里没有 notes 数组';
    }
  } catch (e) {
    out.indexError = e && e.message ? e.message : String(e);
  }

  try {
    out.files = readdirSync(opts.notes).filter((f) => f.endsWith('.md'));
  } catch (e) {
    out.indexError = (out.indexError ? out.indexError + '；' : '') + 'notes/ 读取失败：' + (e && e.message ? e.message : String(e));
  }

  const ids = new Set(out.notes.map((n) => n.id));
  const fileSet = new Set(out.files);
  for (const f of out.files) {
    const id = f.slice(0, -3);
    let text = '';
    try { text = readFileSync(join(opts.notes, f), 'utf8'); } catch { continue; }
    // 与插件一致：只看文件头部的 deleted: true 墓碑标记
    if (/^deleted:\s*true\s*$/m.test(text.slice(0, 300))) {
      out.tombstones++;
      continue;
    }
    if (!ids.has(id)) out.orphanLive.push(id);
  }
  out.missingFiles = out.notes.filter((n) => !fileSet.has(n.id + '.md')).map((n) => n.id);
  return out;
}

function topTags(notes, limit = 5) {
  const map = new Map();
  for (const n of notes) {
    for (const t of (n.tags || [])) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function agedNotes(notes) {
  const cutoff = Date.now() - AGED_DAYS * 86400000;
  return notes
    .map((n) => ({ ...n, ts: Date.parse(n.created) }))
    .filter((n) => Number.isFinite(n.ts) && n.ts < cutoff)
    .sort((a, b) => a.ts - b.ts);
}

/** 核心记忆里「疑似命令/参数/步骤类细则」的行（只提示，不替用户判断）。 */
function commandLikeLines(text) {
  const hits = [];
  const re = /(\bnode\s+[~\/]|\.mjs\b|--help\b|--[a-z][a-z-]{1,})/;
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (re.test(trimmed)) hits.push({ line: i + 1, text: trimmed });
  });
  return hits;
}

function promoteCandidates(notes, limit = 8) {
  const re = /纠正|规则|约定|用户决定|偏好|边界|触发词/;
  return notes
    .filter((n) => re.test(n.title || '') || (n.tags || []).some((t) => re.test(t)))
    .slice(0, limit);
}

function render(opts, core, archive, persona) {
  const chars = core.text.length;
  const bytes = Buffer.byteLength(core.text);
  const budgetLeft = BUDGET - chars;
  const limitLeft = LIMIT - chars;
  const pct = chars / LIMIT;
  const status = chars > LIMIT ? '🔴 超过注入上限，插件会截断' : chars > BUDGET ? '🟡 超过预算，建议降级' : '✅ 预算内';

  const now = Date.now();
  const aged = agedNotes(archive.notes);
  const cmdLines = commandLikeLines(core.text);
  const promotions = promoteCandidates(archive.notes);
  const tags = topTags(archive.notes);
  const sortedSections = [...core.sections].sort((a, b) => b.chars - a.chars);
  const oldest = [...archive.notes].sort((a, b) => String(a.created).localeCompare(String(b.created)))[0];
  const newest = [...archive.notes].sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];

  const essentials = [
    { name: '触发词路由', re: /触发词|skill\(/ },
    { name: '环境路径', re: /(?:~|\/root)\/\.dsh|OBSIDIAN|vault/i },
    { name: '边界规则', re: /边界|设备|副机/ },
    { name: '记忆检索规则', re: /memory_search/ },
  ].map((x) => ({ name: x.name, ok: x.re.test(core.text) }));

  if (opts.json) {
    return {
      generatedAt: nowShanghai(),
      core: {
        path: opts.core,
        chars,
        bytes,
        budget: BUDGET,
        limit: LIMIT,
        budgetLeft,
        limitLeft,
        status: chars > LIMIT ? 'over-limit' : chars > BUDGET ? 'over-budget' : 'ok',
        header: core.header,
        sections: core.sections,
      },
      persona,
      archive: {
        indexError: archive.indexError,
        indexed: archive.notes.length,
        files: archive.files.length,
        live: archive.files.length - archive.tombstones,
        tombstones: archive.tombstones,
        orphanLive: archive.orphanLive,
        missingFiles: archive.missingFiles,
        aged30d: aged.length,
        oldest: oldest ? { id: oldest.id, created: oldest.created } : null,
        newest: newest ? { id: newest.id, created: newest.created } : null,
        topTags: tags,
      },
      essentials,
      suggestions: {
        commandLikeLines: cmdLines,
        promoteCandidates: promotions.map((n) => ({ id: n.id, title: n.title, tags: n.tags })),
      },
    };
  }

  const L = [];
  L.push('# 记忆分层体检');
  L.push('');
  L.push(`生成时间：${nowShanghai()}（Asia/Shanghai）`);
  L.push(`脚本：${opts.core === DEFAULT_CORE ? '~/.dsh/tools/memory-stats.mjs' : 'memory-stats.mjs（自定义路径）'}`);
  L.push('');

  L.push('## 一、核心记忆（热层）');
  L.push('');
  L.push(`文件：${opts.core}`);
  L.push(`字符（插件口径 .length）：${fmt(chars)}`);
  L.push(`字节（UTF-8，参考值）：${fmt(bytes)}`);
  L.push(`预算：${fmt(BUDGET)} 字符；注入上限：${fmt(LIMIT)} 字符；状态：${status}`);
  L.push(`余量：距预算 ${fmt(budgetLeft)} 字符；距截断 ${fmt(limitLeft)} 字符（占用上限 ${(pct * 100).toFixed(1)}%）`);
  L.push('注：memory_core 返回文案写「字节」，实际传的是 next.length（字符）；以字符判定才与插件截断一致。');
  if (persona) {
    L.push(`另：PERSONA.md 每轮单独注入 ${fmt(persona.chars)} 字符 / ${fmt(persona.bytes)} 字节，不占 MEMORY.md 的 ${fmt(LIMIT)} 字符额度。`);
  }
  L.push('');
  L.push('### 分节字符数（降序）');
  L.push('');
  L.push('| 节 | 字符 | 字节 | 占核心 | 非空行 |');
  L.push('|---|---:|---:|---:|---:|');
  L.push(`| 首部导语（无 ##） | ${fmt(core.header.chars)} | ${fmt(core.header.bytes)} | ${(core.header.chars / chars * 100).toFixed(1)}% | ${core.header.lines} |`);
  for (const s of sortedSections) {
    L.push(`| ${s.title} | ${fmt(s.chars)} | ${fmt(s.bytes)} | ${(s.chars / chars * 100).toFixed(1)}% | ${s.lines} |`);
  }
  L.push(`| **合计** | **${fmt(chars)}** | **${fmt(bytes)}** | **100%** | |`);
  L.push('');

  L.push('## 二、归档记忆（温层）');
  L.push('');
  if (archive.indexError) L.push(`⚠ index.json 异常：${archive.indexError}`);
  L.push(`索引条目：${fmt(archive.notes.length)}（memory_list / memory_search 能看到的）`);
  L.push(`notes/ 文件：${fmt(archive.files.length)} 个，其中活跃 ${fmt(archive.files.length - archive.tombstones)}、墓碑 ${fmt(archive.tombstones)}`);
  if (archive.orphanLive.length) {
    L.push(`⚠ 索引缺失：${fmt(archive.orphanLive.length)} 条活跃 md 不在 index.json，memory_search 检索不到（清单见文末）`);
  }
  if (archive.missingFiles.length) {
    L.push(`⚠ 索引指向但文件不存在：${fmt(archive.missingFiles.length)} 条（${archive.missingFiles.slice(0, 5).join('、')}${archive.missingFiles.length > 5 ? '…' : ''}）`);
  }
  if (oldest && newest) {
    L.push(`时间范围：${String(oldest.created).slice(0, 10)} ~ ${String(newest.created).slice(0, 10)}`);
  }
  if (tags.length) {
    L.push(`标签 Top ${tags.length}：${tags.map(([t, n]) => `${t}(${n})`).join('、')}`);
  }
  L.push(`30 天前创建：${fmt(aged.length)} 条${aged.length ? '（候选清单见下）' : ''}`);
  L.push('');

  L.push('## 三、升降建议（按判定表）');
  L.push('');
  L.push('### 降级（热 → 温 / 冷）');
  L.push('');
  if (chars > BUDGET) {
    L.push(`- 核心 ${fmt(chars)} 字符 > 预算 ${fmt(BUDGET)}：按判定表②，优先把「最不常触发」的降为归档，并在热层留一行指针。`);
    L.push(`  分节排名（从大到小）：${sortedSections.map((s) => `${s.title} ${fmt(s.chars)}`).join(' → ')}。`);
    L.push('  脚本不知道各条目的实际触发频率，「最不常触发」需要人工判断。');
  } else {
    L.push(`- 核心在预算内（余 ${fmt(budgetLeft)} 字符），无需强制降级。保持每轮必备用，不为凑数而搬。`);
  }
  if (aged.length) {
    L.push(`- 30 天前创建的归档 ${fmt(aged.length)} 条（判定表②的候选）：`);
    for (const n of aged.slice(0, 10)) {
      L.push(`  - ${String(n.created).slice(0, 10)} · ${n.title || n.id}`);
    }
    if (aged.length > 10) L.push(`  - …另 ${aged.length - 10} 条`);
    L.push('  ⚠ 插件没有「引用次数」统计，无法严格判断「30 天未引用」；这里只按创建时间列候选，是否冷迁移需人工看。');
  } else {
    L.push(`- 没有 30 天前创建的归档条目，判定表②本次无候选。`);
  }
  if (cmdLines.length) {
    L.push(`- 热层里疑似「命令/参数/步骤类细则」${fmt(cmdLines.length)} 行（判定表③：下沉知识库，热层留路径）：`);
    for (const h of cmdLines.slice(0, 10)) {
      L.push(`  - L${h.line}：${h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text}`);
    }
    if (cmdLines.length > 10) L.push(`  - …另 ${cmdLines.length - 10} 行`);
  } else {
    L.push('- 热层没有明显命令/参数/步骤类细则。');
  }
  L.push('');

  L.push('### 上升（温 / 冷 → 热）');
  L.push('');
  L.push(`- 每轮必备项自检：${essentials.map((x) => `${x.name}${x.ok ? ' ✓' : ' ✗'}`).join('；')}。`);
  if (promotions.length) {
    L.push(`- 归档里命中「纠正/规则/约定/边界/触发词」的条目 ${fmt(promotions.length)} 条（判定表①候选，先确认是否已规则化进热层）：`);
    for (const n of promotions) {
      L.push(`  - ${n.title || n.id}${(n.tags || []).length ? `（#${n.tags.join(' #')}）` : ''}`);
    }
    L.push('  注意：不是所有纠正都要上升；只有「已经沉淀成稳定规则、且每轮都该遵守」的才进热层。');
  } else {
    L.push('- 归档里没有命中「纠正/规则/约定/边界/触发词」的条目。');
  }
  L.push('- 判定表③：超过三行的内容一律只进温层/冷层，别塞进 MEMORY.md。');
  L.push('');

  if (archive.orphanLive.length) {
    L.push('## 四、索引一致性告警');
    L.push('');
    L.push(`以下 ${fmt(archive.orphanLive.length)} 条活跃归档不在 index.json，memory_search / memory_list 都看不到：`);
    for (const id of archive.orphanLive) L.push(`- ${id}`);
    L.push('处理建议（需用户确认）：把 index.json 改名留档，让插件下次读取时从 notes/ 重建索引；不要手工拼接索引。');
    L.push('');
  }

  if (!archive.indexError && archive.notes.length === 0 && !archive.files.length) {
    L.push('（归档为空或路径不对，检查 --index / --notes。）');
  }

  return L.join('\n') + '\n';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (!existsSync(opts.core)) {
    console.error(`找不到核心记忆文件：${opts.core}`);
    process.exit(1);
  }
  const coreText = readFileSync(opts.core, 'utf8');
  const core = { text: coreText, ...parseCore(coreText) };
  const archive = readArchive(opts);

  let persona = null;
  if (opts.persona && existsSync(opts.persona)) {
    const p = readFileSync(opts.persona, 'utf8');
    persona = { chars: p.length, bytes: Buffer.byteLength(p) };
  }

  const result = render(opts, core, archive, persona);
  if (typeof result === 'string') process.stdout.write(result);
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
