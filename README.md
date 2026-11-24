# Agent Skill Shelf

[简体中文](./README.zh-CN.md) | English

**Tiered skill governance (`Core` + `On-Demand Shelf`) and fast local routing for Codex, Claude Code, and Antigravity.**

If you have installed dozens or hundreds of agent skills across `~/.codex/skills`, `~/.agents/skills`, and `~/.claude/skills`, keeping every `SKILL.md` metadata entry loaded into every turn bloats your system prompt, dilutes tool selection accuracy, and causes duplicate-name conflicts.

`agent-skill-shelf` splits your installed skills into two tiers **without deleting or modifying any original skill files**:
- **Core (`~15–40` skills)**: Loaded natively in your agent's prompt catalog.
- **On-Demand Shelf (the rest)**: Hidden from the native upfront prompt, searchable in milliseconds via a zero-dependency local CLI, and readable or re-enabled anytime.

> Measured on a real multi-agent workstation: native catalog reduced from **520 entries → 43 entries** (**~78% smaller prompt catalog**), while retaining instant local recall across 500+ skills.

---

## 1-Prompt Agent Deployment

Share this repository with **Codex**, **Claude Code**, or **Antigravity** and paste:

```text
Read https://github.com/unknown-sama-ff/agent-skill-shelf and follow AGENT_SETUP.md to audit my local agent skills, propose a Core vs On-Demand Shelf split for my approval, and deploy it safely after I confirm.
```

Your agent will run a read-only `audit` first, present the numbers and suggested Core list for your confirmation, back up any existing config files before applying, and run `doctor` to verify everything works.

---

## How It Works

```text
  ~/.codex/skills   ~/.claude/skills   ~/.agents/skills
          \                 |                  /
           +----------------+-----------------+
                            |
                  [ skill-shelf audit ]
                            |
          +-----------------+-----------------+
          |                                   |
     Core Tier                       On-Demand Shelf
  (Always loaded)             (Indexed in catalog.jsonl,
   - Codex: enabled             hidden from upfront prompt)
   - Antigravity: plugin                  |
   - Claude: native            [ skill-shelf find "<kw>" ]
                                (BM25 + word-boundary + CJK tags)
                                          |
                          +---------------+---------------+
                          |                               |
                   One-off read                   Permanent toggle
              Read SKILL.md directly         skill-shelf enable/disable
```

---

## Supported Hosts

| Host | How `apply` Works | How `restore` Works |
| --- | --- | --- |
| **Codex** | Writes a managed `# AGENT_SKILL_SHELF_START` block to `~/.codex/config.toml` (`max_context_tokens = 8000` within Codex's 10,000 cap + `enabled = false` for Shelf & shadowed duplicates, self-healing stray UI-written rules) + routing rule in `~/.codex/AGENTS.md` | Strips only the managed blocks; leaves all custom settings & skills intact |
| **Antigravity** | Creates an isolated plugin at `~/.gemini/config/plugins/skill-shelf/` with Core skill copies (auto-fixing missing frontmatter without touching originals) + `always_on` routing rule | Deletes only the `skill-shelf` plugin directory |
| **Claude Code** | Appends a managed `<!-- AGENT_SKILL_SHELF_START -->` routing rule to `~/.claude/CLAUDE.md`; tracks only skills explicitly copied via `enable` | Removes the managed block from `CLAUDE.md` and only copies created by `skill-shelf` |

---

## Security & Reversibility Guarantees

- **Zero external dependencies**: Pure Node.js (`>=18`) ESM modules—nothing from npm, easy to read in a few minutes.
- **100% offline & local**: Zero telemetry, zero runtime LLM calls, zero outbound HTTP requests.
- **Dry-run & automatic backups**: Preview changes with `--dry-run`; every mutated host config is backed up under `~/.agent-skill-shelf/backups/` beforehand.
- **Non-destructive**: Source skill directories are read-only sources of truth. `restore` reverts host files cleanly.

---

## CLI Reference

```bash
# 1. Read-only audit across ~/.codex, ~/.claude, ~/.agents, ~/.gemini/config
node bin/skill-shelf.mjs audit

# 2. Preview deployment without writing anything
node bin/skill-shelf.mjs apply --dry-run

# 3. Deploy with auto-selected Core (default max 30) or explicit list & Codex budget (default 8000, cap 10000)
node bin/skill-shelf.mjs apply --max-core 30 --codex-budget 8000
node bin/skill-shelf.mjs apply --hosts codex,antigravity --core "api-design,python-testing"

# 4. Incrementally sync newly installed skills into Shelf + Codex config (idempotent, safe for cron / Task Scheduler)
node bin/skill-shelf.mjs sync
node bin/skill-shelf.mjs sync --check

# 5. Auto-sync & search the shelf (English, Chinese, multi-source aware, marks newly discovered skills)
node bin/skill-shelf.mjs find "postgres migration"

# 6. Promote / demote skills between Core and Shelf
node bin/skill-shelf.mjs enable postgres-patterns
node bin/skill-shelf.mjs disable postgres-patterns
node bin/skill-shelf.mjs list

# 7. Export/import custom bilingual search tags
node bin/skill-shelf.mjs tags --export --out skills.json
node bin/skill-shelf.mjs tags --set postgres-patterns "postgres,postgresql,数据库,迁移"
node bin/skill-shelf.mjs tags --import tags.json

# 8. Health check (including sync drift & Codex budget checks) & clean rollback
node bin/skill-shelf.mjs doctor
node bin/skill-shelf.mjs restore --purge-home
```

---

## Honest Limitations

- **Agent-initiated recall**: The shelf relies on routing rules (`AGENTS.md` / `CLAUDE.md` / Antigravity rules) instructing the model to run `skill-shelf find` when specialized workflows are needed; models may occasionally skip lookup if a task looks generic.
- **English-only skill descriptions**: Out of the box, lexical search only matches words present in each `SKILL.md`'s `name` and `description`. Use Step 4 in [AGENT_SETUP.md](./AGENT_SETUP.md) (`tags --import`) so your agent adds bilingual/synonym tags once during setup.
- **Claude Code native hiding**: Claude Code does not expose a per-skill `enabled = false` flag in `settings.json` like Codex, so `apply` installs the routing rule in `CLAUDE.md` and manages cross-host `enable`/`disable` copies safely without touching pre-existing `~/.claude/skills/`.

---

## Development & Tests

```bash
npm test
```

All end-to-end tests run inside isolated temporary directories via `--user-home` and `--shelf-home`, never touching your real home directory.

## License

[MIT](./LICENSE)
