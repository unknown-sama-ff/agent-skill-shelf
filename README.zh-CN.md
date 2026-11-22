# Agent Skill Shelf

简体中文 | [English](./README.md)

**面向 Codex、Claude Code 与 Antigravity 的跨宿主技能分层治理（常驻 Core + 按需 Shelf）与本地毫秒级路由工具。**

如果你在 `~/.codex/skills`、`~/.agents/skills`、`~/.claude/skills` 里装了几十甚至上百个技能，把所有 `SKILL.md` 元数据每轮都塞进系统提示词，不仅会显著拉高上下文噪音、降低模型选错/漏选概率，还会导致跨工具重名冲突。

`agent-skill-shelf` 在**不删除、不改动任何原始技能文件**的前提下，把技能分成两层：
- **Core 常驻层（约 15～40 个高频技能）**：保留在宿主原生目录中随时触发；
- **On-Demand Shelf 按需货架（其余技能）**：从原生首屏目录隐藏，需要时由 Agent 毫秒级本地检索后按需读取，或随时一键升/降级。

> 真实多技能工作站实测：原生目录从 **520 条降至 43 条**（目录字符数减少约 **78%**），同时保留 500+ 技能的即时召回与按需启用能力。

---

## 一句话让你的 Agent 自动部署

把本仓库发给 **Codex**、**Claude Code** 或 **Antigravity**，直接粘贴：

```text
请阅读 https://github.com/unknown-sama-ff/agent-skill-shelf 里的 AGENT_SETUP.md，先只读扫描我本机的 skills 和宿主配置并给出常驻 Core 与按需 Shelf 的分层建议，等我确认后再备份部署并跑通验收。
```

你的 Agent 会严格按照 [AGENT_SETUP.md](./AGENT_SETUP.md) 执行：**先只读体检 (`audit`) → 展示方案等你确认 → 自动备份原配置并写入 (`apply`) → 可选补全中英文同义词标签 (`tags`) → 跑通自检 (`doctor`)**。

---

## 工作原理

```text
  ~/.codex/skills   ~/.claude/skills   ~/.agents/skills
          \                 |                  /
           +----------------+-----------------+
                            |
                  [ skill-shelf audit ]
                            |
          +-----------------+-----------------+
          |                                   |
     Core 常驻层                     On-Demand Shelf 按需货架
  (随会话原生加载)                (写入 catalog.jsonl 索引，
   - Codex: 保持启用               从原生首屏目录隐藏)
   - Antigravity: 独立插件                    |
   - Claude: 原生目录            [ skill-shelf find "<关键词>" ]
                                (BM25 + 词边界 + 中英标签匹配)
                                              |
                              +---------------+---------------+
                              |                               |
                         临时用一次                       永久启停切换
                     直接读 SKILL.md                  enable / disable
```

---

## 支持的宿主与原理

| 宿主 | `apply` 行为 | `restore` 还原方式 |
| --- | --- | --- |
| **Codex** | 在 `~/.codex/config.toml` 写入带标记的 `# AGENT_SKILL_SHELF_START` 托管块（为非核心及重复副本写入 `enabled = false`），并在 `~/.codex/AGENTS.md` 注入路由规则 | 仅剥离托管标记块，完整保留原有配置与全部技能文件 |
| **Antigravity** | 生成可独立开关的插件 `~/.gemini/config/plugins/skill-shelf/`，仅同步 Core 技能副本（自动补齐缺失的 frontmatter，不改源文件）并注入 `always_on` 路由规则 | 直接删除 `skill-shelf` 插件目录即可 |
| **Claude Code** | 在 `~/.claude/CLAUDE.md` 注入按需路由块，并仅追踪由 `skill-shelf enable` 跨目录复制进来的技能副本 | 移除 `CLAUDE.md` 托管块，仅清理工具创建的副本，绝不碰用户原有技能 |

---

## 安全与可逆保障

- **零外部依赖**：纯 Node.js（`>=18`）标准库编写，无 `npm install` 供应链风险，全库代码几百行可快速审计。
- **纯本地离线**：无遥测、运行时零外部网络请求、不额外调用付费模型 API。
- **先预览、必备份**：支持 `--dry-run` 预览；写入前自动备份至 `~/.agent-skill-shelf/backups/`。
- **随时一键还原**：`restore` 无损清除所有注入块与插件，恢复部署前状态。

---

## 常用 CLI 命令

```bash
# 1. 只读体检：扫描本机宿主、重复技能、frontmatter 问题与预计节省比例
node bin/skill-shelf.mjs audit

# 2. 预览部署效果（不写任何文件）
node bin/skill-shelf.mjs apply --dry-run

# 3. 执行部署（自动精选 Core 或显式指定 Core 列表）
node bin/skill-shelf.mjs apply --max-core 30
node bin/skill-shelf.mjs apply --hosts codex,antigravity --core "api-design,python-testing"

# 4. 本地检索（支持英文词边界、BM25 权重、中文标签及磁盘新增技能实时发现）
node bin/skill-shelf.mjs find "数据库迁移"

# 5. 动态切换某个技能的常驻 / 按需状态
node bin/skill-shelf.mjs enable postgres-patterns
node bin/skill-shelf.mjs disable postgres-patterns
node bin/skill-shelf.mjs list

# 6. 导出/导入中英文检索标签
node bin/skill-shelf.mjs tags --export --out skills.json
node bin/skill-shelf.mjs tags --set postgres-patterns "postgres,postgresql,数据库,迁移"
node bin/skill-shelf.mjs tags --import tags.json

# 7. 环境自检与无损回滚
node bin/skill-shelf.mjs doctor
node bin/skill-shelf.mjs restore --purge-home
```

---

## 坦诚说明的局限性

- **触发仍依赖提示词规则**：模型偶尔会在看起来很简单的任务上跳过查库；明确点名或遇到复杂专项流程时效果最稳。
- **开箱默认为英文词法检索**：如果某技能原文只有英文 `description`，直接用中文搜可能漏召回；建议按 [AGENT_SETUP.md](./AGENT_SETUP.md) 第 4 步让你的 Agent 在部署时顺手生成一次中英文 `tags` 即可大幅改善。
- **Claude Code 原生目录限制**：Claude Code 暂不支持类似 Codex 的单技能 `enabled = false` 开关，因此本工具对其仅管理 `CLAUDE.md` 路由块与跨目录 `enable` 副本。

---

## 本地测试

```bash
npm test
```

全部端到端测试均通过 `--user-home` 与 `--shelf-home` 在临时目录中隔离运行，不会触碰真实用户目录。

## 开源协议

[MIT](./LICENSE)
