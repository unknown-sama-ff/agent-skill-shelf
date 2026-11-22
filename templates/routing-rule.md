## On-Demand Skill Shelf
- Only frequently needed core skills are permanently loaded in the native catalog. All remaining installed skills live on the local On-Demand Shelf without deleting any source files.
- Do NOT query the shelf for ordinary small tasks, and never dump the full catalog into context.
- When the user explicitly names a non-core skill or the task requires a specialized workflow not in the active catalog, run:
  `{{CLI_CMD}} find "<keywords>"`
- For one-off use, read the returned `SKILL.md` path (and any local `references/` or `scripts/`) directly without changing host configs.
- Only when the user asks to permanently pin or unpin a skill in the active catalog, run:
  `{{CLI_CMD}} enable <skill-name>`
  `{{CLI_CMD}} disable <skill-name>`
