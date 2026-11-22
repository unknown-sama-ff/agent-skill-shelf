# Agent Setup Protocol (`AGENT_SETUP.md`)

You are an AI coding agent asked by the user to deploy **`agent-skill-shelf`** on their local machine.
Follow this deterministic 5-step protocol strictly. **Never skip confirmation or improvise ad-hoc edits to host files.**

---

## Hard Safety Guardrails

1. **Zero network/telemetry at runtime**: `agent-skill-shelf` uses pure Node.js (`>=18`) standard libraries. Do not install npm packages.
2. **Read-only audit first**: Always run `audit` before proposing any configuration changes.
3. **Explicit user confirmation required**: Never run `apply` until the user approves the proposed Core skill list and target hosts.
4. **Never delete or edit original `SKILL.md` files**: Skills moved to the On-Demand Shelf remain untouched in their original folders (`~/.codex/skills`, `~/.agents/skills`, `~/.claude/skills`).
5. **Reversible by design**: Only marked blocks (`AGENT_SKILL_SHELF_START` / `AGENT_SKILL_SHELF_END`) or a standalone Antigravity plugin folder (`skill-shelf`) are written, with automatic pre-write backups under `~/.agent-skill-shelf/backups/`.

---

## Step 0: Check Prerequisites & Local Repo Path

Verify Node.js `>=18` is available:

```bash
node -v
```

If this repository is not yet cloned locally, clone it into a temporary or user-approved directory (or run directly from the cloned repo path `<REPO_DIR>`). Remember that `apply` installs a self-contained runtime copy into `~/.agent-skill-shelf/runtime/`, so host rules keep working even if `<REPO_DIR>` is later removed.

---

## Step 1: Read-Only Audit

Run a read-only scan of the user's machine:

```bash
node "<REPO_DIR>/bin/skill-shelf.mjs" audit --json
```

Inspect the output and summarize to the user:
- **Detected hosts**: Codex (`~/.codex`), Antigravity (`~/.gemini/config`), Claude Code (`~/.claude`), shared `~/.agents/skills`.
- **Skill inventory**: total entries, unique skills, shadowed duplicates, and any frontmatter issues.
- **Estimated prompt reduction**: raw catalog chars/tokens vs. suggested Core set (`suggestedCoreSkills`).

---

## Step 2: Confirm Deployment Plan with the User

Present the audit summary and ask the user **once**:
1. Which target hosts to configure (`codex`, `antigravity`, `claude`, or all detected).
2. Whether to accept `suggestedCoreSkills` (default up to 30) or customize the Core list (e.g., adding/removing specific skills the user uses every day).
3. Whether to proceed with **Step 4 (Optional Bilingual Tag Enrichment)** after `apply`.

**Wait for user confirmation before proceeding.**

---

## Step 3: Dry-Run & Apply

First preview what will be touched:

```bash
node "<REPO_DIR>/bin/skill-shelf.mjs" apply --hosts <comma-list> --core "<comma-list>" --dry-run
```

If `--core` is long, write a temporary JSON array or newline-delimited file and pass `--core-file <path>`.

Then apply for real:

```bash
node "<REPO_DIR>/bin/skill-shelf.mjs" apply --hosts <comma-list> --core "<comma-list>"
```

If the user has a dedicated preference for max auto-core size without a custom list, pass `--max-core <N>` instead of `--core`.

---

## Step 4 (Optional): Bilingual / Synonym Tag Enrichment

If the user works in multiple languages (e.g., Chinese prompts querying English skills) or wants better recall without runtime LLM calls, use your own model turn once during setup to enrich local `tags`:

1. Export the catalog metadata:
   ```bash
   node "<REPO_DIR>/bin/skill-shelf.mjs" tags --export --out "<SHELF_TMP>/skills-export.json"
   ```
2. Read the exported `{ name, description }` items in batches and generate a JSON mapping `{ "<skill-name>": ["keyword1", "中文触发词", "synonym"] }` (3–6 concise, high-signal terms per skill; write to `<SHELF_TMP>/tags.json`).
3. Import the tags into `~/.agent-skill-shelf/catalog.jsonl`:
   ```bash
   node "<REPO_DIR>/bin/skill-shelf.mjs" tags --import "<SHELF_TMP>/tags.json"
   ```
4. Delete any temporary export/import JSON files after import.

---

## Step 5: Verify (`doctor`) & Hand Back

Run the built-in health check and a quick search smoke test:

```bash
node "<REPO_DIR>/bin/skill-shelf.mjs" doctor
node "<REPO_DIR>/bin/skill-shelf.mjs" find "testing"
```

Only report success when `doctor` exits with code `0` and all checks show `[OK]`.
Remind the user:
- **Codex / Antigravity / Claude Code** pick up updated configs on the next session or reload.
- To promote or demote a skill later:
  - `node ~/.agent-skill-shelf/runtime/bin/skill-shelf.mjs enable <skill-name>`
  - `node ~/.agent-skill-shelf/runtime/bin/skill-shelf.mjs disable <skill-name>`
- To completely revert everything at any time:
  - `node ~/.agent-skill-shelf/runtime/bin/skill-shelf.mjs restore` (add `--purge-home` to also remove `~/.agent-skill-shelf`).
