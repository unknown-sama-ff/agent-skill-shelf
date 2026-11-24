import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSkillFile, parseSkillMarkdown } from './frontmatter.mjs';
import { normPath, toPosix } from './paths.mjs';
import { scanSkillSources } from './scanner.mjs';
import { buildCatalogRows, loadCatalog, saveCatalog } from './search.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const TOML_START = '# AGENT_SKILL_SHELF_START';
export const TOML_END = '# AGENT_SKILL_SHELF_END';
export const MD_START = '<!-- AGENT_SKILL_SHELF_START -->';
export const MD_END = '<!-- AGENT_SKILL_SHELF_END -->';

export const DEFAULT_CODEX_BUDGET = 8000;
export const MAX_CODEX_BUDGET = 10000;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Atomically write UTF-8 text to disk (temp file + rename with Windows fallback).
 * Skips writing if file already has identical content.
 * @param {string} filePath
 * @param {string} content
 * @returns {boolean} Whether file content changed
 */
export function atomicWriteFile(filePath, content) {
  if (fs.existsSync(filePath)) {
    const prev = fs.readFileSync(filePath, 'utf8');
    if (prev === content) return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
  }
  return true;
}

/**
 * Validate Codex skills.max_context_tokens budget (official explicit cap is 10,000).
 * @param {number | string | undefined | null} value
 * @param {number} [fallback=DEFAULT_CODEX_BUDGET]
 * @returns {number}
 */
export function resolveCodexBudget(value, fallback = DEFAULT_CODEX_BUDGET) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CODEX_BUDGET) {
    throw new Error(
      `Invalid Codex max_context_tokens "${value}". Must be between 1 and ${MAX_CODEX_BUDGET} (official cap).`
    );
  }
  return Math.floor(n);
}

/**
 * Remove a managed marker block (and its surrounding separator newline) from text.
 * @param {string} content
 * @param {string} startMarker
 * @param {string} endMarker
 * @returns {string}
 */
export function removeManagedBlock(content, startMarker, endMarker) {
  if (!content) return '';
  const escStart = escapeRegex(startMarker);
  const escEnd = escapeRegex(endMarker);
  const re = new RegExp(`(?:\\r?\\n)?${escStart}[\\s\\S]*?${escEnd}(?:\\r?\\n)?`, 'g');
  return content.replace(re, '');
}

/**
 * Idempotently insert or replace a managed marker block inside a config or rule file.
 * @param {string} content
 * @param {string} startMarker
 * @param {string} endMarker
 * @param {string} blockBody
 * @returns {string}
 */
export function upsertManagedBlock(content, startMarker, endMarker, blockBody) {
  const base = removeManagedBlock(content || '', startMarker, endMarker);
  const block = `${startMarker}\n${blockBody.trimEnd()}\n${endMarker}`;
  if (!base.trim()) {
    return `${block}\n`;
  }
  if (base.endsWith('\n')) {
    return `${base}\n${block}\n`;
  }
  return `${base}\n\n${block}\n`;
}

/**
 * Copy a host file into a timestamped backup directory before mutating it.
 * @param {string} filePath
 * @param {string} backupDir
 * @param {string} userHome
 * @returns {string | null}
 */
export function backupFile(filePath, backupDir, userHome) {
  if (!fs.existsSync(filePath)) return null;
  const rel = path.relative(userHome, filePath).replace(/^(\.\.[\\/])+/, '').replace(/:/g, '');
  const destPath = path.join(backupDir, rel || path.basename(filePath));
  if (fs.existsSync(destPath)) return destPath;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(filePath, destPath);
  return destPath;
}

/**
 * Load routing-rule template and substitute the resolved runtime CLI command.
 * @param {object} env
 * @returns {string}
 */
export function renderRoutingRule(env) {
  const templatePath = path.join(REPO_ROOT, 'templates', 'routing-rule.md');
  const template = fs.readFileSync(templatePath, 'utf8');
  const cliCmd = `node "${toPosix(env.runtimeCliPath)}"`;
  return template.replace(/\{\{CLI_CMD\}\}/g, cliCmd).trimEnd();
}

/**
 * Copy the CLI runtime into <shelfHome>/runtime so host rules stay self-contained.
 * @param {string} shelfHome
 */
export function installRuntime(shelfHome) {
  const runtimeDir = path.join(shelfHome, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const sub of ['bin', 'src', 'templates']) {
    const src = path.join(REPO_ROOT, sub);
    const dst = path.join(runtimeDir, sub);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(runtimeDir, 'package.json'));
}

/**
 * Read <shelfHome>/config.json if it exists.
 * @param {object} env
 * @returns {object | null}
 */
export function loadShelfConfig(env) {
  if (!fs.existsSync(env.configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save <shelfHome>/config.json atomically.
 * @param {object} env
 * @param {object} config
 */
export function saveShelfConfig(env, config) {
  fs.mkdirSync(env.shelfHome, { recursive: true });
  atomicWriteFile(env.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function copySkillDirectory(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    dereference: true,
    filter: p => {
      const base = path.basename(p);
      return base !== '.git' && base !== 'node_modules';
    },
  });
}

function isUnderManagedCodexRoots(filePath, env) {
  const target = normPath(filePath);
  const managedRoots = [env.codexSkills, env.agentsSkills]
    .filter(Boolean)
    .map(d => normPath(d).replace(/\/+$/, '') + '/');
  return managedRoots.some(prefix => target.startsWith(prefix));
}

function stripStrayManagedSkillsConfig(tomlContent, env) {
  const lines = tomlContent.replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let strippedCount = 0;
  let i = 0;

  while (i < lines.length) {
    if (/^\s*\[\[skills\.config\]\]\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j])) {
        j++;
      }
      const block = lines.slice(i, j).join('\n');
      const pm = block.match(/^\s*path\s*=\s*(?:"([^"]+)"|'([^']+)')/m);
      const rawPath = pm ? (pm[1] ?? pm[2]) : null;
      if (rawPath && isUnderManagedCodexRoots(rawPath, env)) {
        strippedCount += 1;
        i = j;
        continue;
      }
      kept.push(...lines.slice(i, j));
      i = j;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }

  return {
    content: kept.join('\n').replace(/\n{3,}/g, '\n\n'),
    strippedCount,
  };
}

function updateSkillsBudgetInPlace(tomlContent, targetBudget) {
  const skillsSectionRe = /(^|\n)\[skills\][ \t]*\n([\s\S]*?)(?=\n\[|$)/;
  if (!skillsSectionRe.test(tomlContent)) {
    return { found: false, content: tomlContent };
  }
  const updated = tomlContent.replace(skillsSectionRe, (full, prefix, body) => {
    if (/^\s*max_context_tokens\s*=\s*\d+/m.test(body)) {
      return `${prefix}[skills]\n${body.replace(
        /^(\s*max_context_tokens\s*=\s*)\d+/m,
        `$1${targetBudget}`
      )}`;
    }
    return `${prefix}[skills]\nmax_context_tokens = ${targetBudget}\n${body.replace(/^\n+/, '')}`;
  });
  return { found: true, content: updated };
}

/**
 * Apply Core + Shelf settings to Codex (config.toml + AGENTS.md).
 * Resilient against Codex UI rewriting config.toml (comment stripping or single-quoted stray rules),
 * manages [skills].max_context_tokens cleanly without duplicate [skills] headers.
 * @param {object} env
 * @param {object} scanResult
 * @param {Set<string>} coreSet
 * @param {object} [options]
 * @returns {object}
 */
export function applyCodex(env, scanResult, coreSet, options = {}) {
  const hiddenEntries = scanResult.entries.filter(entry => {
    if (entry.source !== 'codex' && entry.source !== 'agents') return false;
    if (!coreSet.has(entry.name)) return true;
    const owner = scanResult.unique.get(entry.name);
    return Boolean(owner && owner.normPath !== entry.normPath);
  });

  hiddenEntries.sort((a, b) => a.normPath.localeCompare(b.normPath));
  const targetBudget = resolveCodexBudget(options.codexBudget, DEFAULT_CODEX_BUDGET);

  const existingToml = fs.existsSync(env.codexConfigPath)
    ? fs.readFileSync(env.codexConfigPath, 'utf8')
    : '';

  // Remove existing managed block AND any stray unmanaged [[skills.config]] for managed roots
  const withoutManaged = removeManagedBlock(existingToml, TOML_START, TOML_END);
  const { content: cleanedBase, strippedCount } = stripStrayManagedSkillsConfig(withoutManaged, env);

  // If user already had a [skills] section outside our managed block, update its budget in place;
  // otherwise emit [skills] inside our managed block so `restore` returns config.toml verbatim.
  const inPlace = updateSkillsBudgetInPlace(cleanedBase, targetBudget);
  const normalizedBase = inPlace.content.trim()
    ? `${inPlace.content.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`
    : '';
  const tomlLines = [
    '# Managed by agent-skill-shelf. Run `skill-shelf restore` to remove safely.',
  ];
  if (!inPlace.found) {
    tomlLines.push('[skills]');
    tomlLines.push(`max_context_tokens = ${targetBudget}`);
    tomlLines.push('');
  }
  for (const entry of hiddenEntries) {
    tomlLines.push('[[skills.config]]');
    tomlLines.push(`path = "${toPosix(entry.path)}"`);
    tomlLines.push('enabled = false');
    tomlLines.push('');
  }
  const tomlBlockBody = tomlLines.join('\n').trimEnd();
  const nextToml = upsertManagedBlock(normalizedBase, TOML_START, TOML_END, tomlBlockBody);

  const skipAgentsMd = Boolean(options.skipAgentsMd);
  const existingAgentsMd = fs.existsSync(env.codexAgentsMdPath)
    ? fs.readFileSync(env.codexAgentsMdPath, 'utf8')
    : '';
  const nextAgentsMd = skipAgentsMd
    ? existingAgentsMd
    : upsertManagedBlock(existingAgentsMd, MD_START, MD_END, renderRoutingRule(env));

  let configChanged = nextToml !== existingToml;
  let agentsMdChanged = !skipAgentsMd && nextAgentsMd !== existingAgentsMd;

  if (!options.dryRun) {
    fs.mkdirSync(env.codexHome, { recursive: true });
    if (options.backupDir) {
      if (configChanged) backupFile(env.codexConfigPath, options.backupDir, env.userHome);
      if (agentsMdChanged) backupFile(env.codexAgentsMdPath, options.backupDir, env.userHome);
    }
    if (configChanged) {
      atomicWriteFile(env.codexConfigPath, nextToml);
    }
    if (agentsMdChanged) {
      atomicWriteFile(env.codexAgentsMdPath, nextAgentsMd);
    }
  }

  return {
    host: 'codex',
    hiddenEntriesCount: hiddenEntries.length,
    codexBudget: targetBudget,
    strippedStrayRules: strippedCount,
    configChanged,
    agentsMdChanged,
    configPath: env.codexConfigPath,
    agentsMdPath: env.codexAgentsMdPath,
  };
}

/**
 * Restore Codex config.toml and AGENTS.md by stripping managed blocks only.
 * @param {object} env
 * @param {object} [options]
 * @returns {object}
 */
export function restoreCodex(env, options = {}) {
  const changed = [];
  for (const [filePath, start, end] of [
    [env.codexConfigPath, TOML_START, TOML_END],
    [env.codexAgentsMdPath, MD_START, MD_END],
  ]) {
    if (!fs.existsSync(filePath)) continue;
    const prev = fs.readFileSync(filePath, 'utf8');
    const next = removeManagedBlock(prev, start, end);
    if (next !== prev) {
      changed.push(filePath);
      if (!options.dryRun) {
        atomicWriteFile(filePath, next);
      }
    }
  }
  return { host: 'codex', modifiedFiles: changed };
}

function acquireSyncLock(lockPath) {
  const now = Date.now();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    if (fs.existsSync(lockPath)) {
      if (now - fs.statSync(lockPath).mtimeMs > 30000) {
        try { fs.rmSync(lockPath, { force: true }); } catch {}
      }
    }
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseSyncLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch {}
}

function appendSyncLog(logPath, lines) {
  if (!lines.length) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 512 * 1024) {
      const prev = `${logPath}.prev`;
      try { fs.rmSync(prev, { force: true }); } catch {}
      fs.renameSync(logPath, prev);
    }
    fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // Non-fatal logging failure
  }
}

/**
 * Incrementally sync newly installed local skills into catalog.jsonl (defaulting to shelf)
 * and Codex config.toml without overwriting existing Core selections or custom tags.
 * @param {object} env
 * @param {object} [options]
 * @returns {object}
 */
export function syncShelfIncremental(env, options = {}) {
  const cfg = loadShelfConfig(env);
  if (!cfg) {
    return {
      ok: false,
      initialized: false,
      skipped: true,
      reason: 'not_initialized',
      newlyAdded: [],
      newlyAddedPaths: new Set(),
      catalogChanged: false,
      configChanged: false,
    };
  }

  const dryRun = Boolean(options.dryRun);
  if (!dryRun && !acquireSyncLock(env.syncLockPath)) {
    return {
      ok: true,
      initialized: true,
      skipped: true,
      reason: 'locked',
      newlyAdded: [],
      newlyAddedPaths: new Set(),
      catalogChanged: false,
      configChanged: false,
    };
  }

  try {
    const nowIso = new Date().toISOString();
    const scan = scanSkillSources(env);
    const existingCatalog = loadCatalog(env.shelfHome);
    const existingByPath = new Map(
      existingCatalog.filter(r => r?.path).map(r => [normPath(r.path), r])
    );

    const coreSet = new Set(cfg.coreSkills || []);
    const diskByPath = new Map(scan.entries.map(e => [e.normPath, e]));

    const stalePaths = [];
    for (const [key, prev] of existingByPath.entries()) {
      if (!diskByPath.has(key)) {
        stalePaths.push(prev.path);
      }
    }

    const nextRows = buildCatalogRows(scan, coreSet, existingCatalog, {
      nowIso,
      origin: 'auto-sync',
    });

    const newlyAdded = nextRows.filter(r => !existingByPath.has(normPath(r.path)));
    const newlyAddedPaths = new Set(newlyAdded.map(r => normPath(r.path)));

    const prevCatalogText = fs.existsSync(env.catalogPath)
      ? fs.readFileSync(env.catalogPath, 'utf8').replace(/\r\n/g, '\n')
      : '';
    const nextCatalogText =
      nextRows.map(r => JSON.stringify(r)).join('\n') + (nextRows.length ? '\n' : '');
    const catalogChanged = nextCatalogText !== prevCatalogText;

    if (!dryRun && catalogChanged) {
      saveCatalog(env.shelfHome, nextRows);
    }

    const targetBudget = resolveCodexBudget(
      options.codexBudget !== undefined ? options.codexBudget : cfg.codexBudget,
      DEFAULT_CODEX_BUDGET
    );

    let codexResult = null;
    if ((cfg.hosts || []).includes('codex')) {
      codexResult = applyCodex(env, scan, coreSet, {
        dryRun,
        codexBudget: targetBudget,
        skipAgentsMd: true,
      });
    }

    const budgetChanged = options.codexBudget !== undefined && targetBudget !== cfg.codexBudget;
    if (!dryRun && budgetChanged) {
      saveShelfConfig(env, {
        ...cfg,
        codexBudget: targetBudget,
        updatedAt: nowIso,
      });
    }

    const configChanged = Boolean(codexResult?.configChanged);
    const issues = [...scan.scanErrors, ...scan.issueSkills.map(i => ({ type: 'frontmatter_issue', path: i.path, detail: i.issues.join(',') }))];

    if (!dryRun && (newlyAdded.length || stalePaths.length || issues.length || catalogChanged || configChanged)) {
      const logLines = [
        `[${nowIso}] sync: total=${nextRows.length} core=${nextRows.filter(r => r.tier === 'core').length} shelf=${nextRows.filter(r => r.tier !== 'core').length} added=${newlyAdded.length} stale=${stalePaths.length} issues=${issues.length} catalogChanged=${catalogChanged} configChanged=${configChanged}`,
      ];
      for (const a of newlyAdded) {
        logLines.push(`  + [${a.tier}] ${a.name} -> ${a.path}`);
      }
      for (const s of stalePaths) {
        logLines.push(`  ! [stale] ${s}`);
      }
      for (const iss of issues) {
        logLines.push(`  ! [${iss.type}] ${iss.path} (${iss.detail})`);
      }
      appendSyncLog(env.syncLogPath, logLines);
    }

    return {
      ok: true,
      initialized: true,
      dryRun,
      skipped: false,
      totalCatalog: nextRows.length,
      coreCount: nextRows.filter(r => r.tier === 'core').length,
      shelfCount: nextRows.filter(r => r.tier !== 'core').length,
      newlyAdded,
      newlyAddedPaths,
      stalePaths,
      issues,
      codexBudget: targetBudget,
      catalogChanged,
      configChanged,
    };
  } finally {
    if (!dryRun) {
      releaseSyncLock(env.syncLockPath);
    }
  }
}

function collectOtherAntigravityPluginSkills(env) {
  const occupied = new Set();
  if (!fs.existsSync(env.antigravityPluginsDir)) return occupied;
  for (const pluginEnt of fs.readdirSync(env.antigravityPluginsDir, { withFileTypes: true })) {
    if (!pluginEnt.isDirectory() || pluginEnt.name === 'skill-shelf') continue;
    const skillsDir = path.join(env.antigravityPluginsDir, pluginEnt.name, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const skEnt of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (skEnt.isDirectory() && !skEnt.name.startsWith('.')) {
        occupied.add(skEnt.name);
      }
    }
  }
  return occupied;
}

function buildManagerSkillMarkdown(env) {
  const cliCmd = `node "${toPosix(env.runtimeCliPath)}"`;
  return [
    '---',
    'name: skill-shelf-manager',
    'description: Search on-demand local skills across Codex, Claude Code, and .agents repositories, incrementally sync newly installed skills, or promote and demote skills between Core and the On-Demand Shelf.',
    '---',
    '',
    '# Agent Skill Shelf Manager',
    '',
    'Use the local CLI runtime to query non-core skills, sync newly installed skills into the shelf, or adjust the active Core tier without editing original skill directories:',
    '',
    '```bash',
    `# Search all local and newly added skills (auto-syncs new skills into shelf)`,
    `${cliCmd} find "<keywords>"`,
    '',
    `# Incrementally sync newly installed skills into catalog and Codex config`,
    `${cliCmd} sync`,
    '',
    `# List core and shelf inventory`,
    `${cliCmd} list`,
    '',
    `# Promote a skill into active Core across configured hosts`,
    `${cliCmd} enable <skill-name>`,
    '',
    `# Demote a skill back to the On-Demand Shelf`,
    `${cliCmd} disable <skill-name>`,
    '```',
    '',
  ].join('\n');
}

/**
 * Apply Core + Shelf settings to Antigravity via an isolated reversible plugin.
 * @param {object} env
 * @param {object} scanResult
 * @param {Set<string>} coreSet
 * @param {object} [options]
 * @returns {object}
 */
export function applyAntigravity(env, scanResult, coreSet, options = {}) {
  const occupiedSkills = collectOtherAntigravityPluginSkills(env);
  const pluginDir = env.antigravityPluginDir;
  const pluginSkillsDir = path.join(pluginDir, 'skills');

  const synced = [];
  const skippedCollisions = [];
  const normalized = [];

  for (const skillName of [...coreSet].sort()) {
    const entry = scanResult.unique.get(skillName);
    if (!entry) continue;
    if (occupiedSkills.has(skillName)) {
      skippedCollisions.push(skillName);
      continue;
    }
    synced.push(skillName);
  }

  if (!options.dryRun) {
    fs.mkdirSync(path.join(pluginDir, 'rules'), { recursive: true });
    fs.mkdirSync(pluginSkillsDir, { recursive: true });

    const pluginJson = {
      name: 'skill-shelf',
      displayName: 'Agent Skill Shelf',
      version: '0.2.0',
      description: 'Tiered Core skills plus fast local routing and auto-sync for the On-Demand Skill Shelf.',
    };
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      `${JSON.stringify(pluginJson, null, 2)}\n`,
      'utf8'
    );

    const ruleContent = `---\ntrigger: always_on\n---\n\n${renderRoutingRule(env)}\n`;
    fs.writeFileSync(path.join(pluginDir, 'rules', 'skill-shelf.md'), ruleContent, 'utf8');

    const managerDir = path.join(pluginSkillsDir, 'skill-shelf-manager');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, 'SKILL.md'), buildManagerSkillMarkdown(env), 'utf8');

    const activeSet = new Set(synced);
    activeSet.add('skill-shelf-manager');

    for (const existing of fs.readdirSync(pluginSkillsDir, { withFileTypes: true })) {
      if (existing.isDirectory() && !activeSet.has(existing.name)) {
        fs.rmSync(path.join(pluginSkillsDir, existing.name), { recursive: true, force: true });
      }
    }

    for (const skillName of synced) {
      const entry = scanResult.unique.get(skillName);
      const destSkillDir = path.join(pluginSkillsDir, skillName);
      copySkillDirectory(entry.dir, destSkillDir);
      const norm = normalizeSkillFile(destSkillDir, skillName);
      if (norm.modified) {
        normalized.push({ name: skillName, reason: norm.reason });
      }
    }
  }

  return {
    host: 'antigravity',
    pluginDir,
    syncedCount: synced.length,
    syncedSkills: synced,
    skippedCollisions,
    normalized,
  };
}

/**
 * Remove the Antigravity skill-shelf plugin directory.
 * @param {object} env
 * @param {object} [options]
 * @returns {object}
 */
export function restoreAntigravity(env, options = {}) {
  const existed = fs.existsSync(env.antigravityPluginDir);
  if (existed && !options.dryRun) {
    fs.rmSync(env.antigravityPluginDir, { recursive: true, force: true });
  }
  return { host: 'antigravity', removedPluginDir: existed ? env.antigravityPluginDir : null };
}

/**
 * Apply On-Demand Shelf routing rule to Claude Code (CLAUDE.md) and prune stale managed copies.
 * Never modifies or deletes pre-existing user skills inside ~/.claude/skills/.
 * @param {object} env
 * @param {object} scanResult
 * @param {Set<string>} coreSet
 * @param {object} [options]
 * @returns {object}
 */
export function applyClaude(env, scanResult, coreSet, options = {}) {
  const mdBlockBody = renderRoutingRule(env);
  const existingClaudeMd = fs.existsSync(env.claudeMdPath)
    ? fs.readFileSync(env.claudeMdPath, 'utf8')
    : '';
  const nextClaudeMd = upsertManagedBlock(existingClaudeMd, MD_START, MD_END, mdBlockBody);

  const prevManaged = Array.isArray(options.claudeManagedCopies)
    ? options.claudeManagedCopies
    : [];
  const nextManaged = new Set();

  if (!options.dryRun) {
    fs.mkdirSync(env.claudeHome, { recursive: true });
    if (options.backupDir) {
      backupFile(env.claudeMdPath, options.backupDir, env.userHome);
    }
    atomicWriteFile(env.claudeMdPath, nextClaudeMd);

    for (const skillName of prevManaged) {
      const destSkillDir = path.join(env.claudeSkills, skillName);
      if (coreSet.has(skillName)) {
        const entry = scanResult.unique.get(skillName);
        if (entry && entry.dir !== destSkillDir) {
          copySkillDirectory(entry.dir, destSkillDir);
        }
        nextManaged.add(skillName);
      } else if (fs.existsSync(destSkillDir)) {
        fs.rmSync(destSkillDir, { recursive: true, force: true });
      }
    }

    if (options.promoteSkillToClaude) {
      const skillName = options.promoteSkillToClaude;
      const entry = scanResult.unique.get(skillName);
      const destSkillDir = path.join(env.claudeSkills, skillName);
      if (entry && entry.source !== 'claude' && !fs.existsSync(destSkillDir)) {
        fs.mkdirSync(env.claudeSkills, { recursive: true });
        copySkillDirectory(entry.dir, destSkillDir);
        nextManaged.add(skillName);
      }
    }
  } else {
    for (const s of prevManaged) {
      if (coreSet.has(s)) nextManaged.add(s);
    }
  }

  return {
    host: 'claude',
    claudeMdPath: env.claudeMdPath,
    claudeManagedCopies: [...nextManaged].sort(),
  };
}

/**
 * Restore Claude Code CLAUDE.md and remove ONLY copies created by skill-shelf enable.
 * @param {object} env
 * @param {Array<string>} managedCopies
 * @param {object} [options]
 * @returns {object}
 */
export function restoreClaude(env, managedCopies = [], options = {}) {
  const modifiedFiles = [];
  const removedCopies = [];

  if (fs.existsSync(env.claudeMdPath)) {
    const prev = fs.readFileSync(env.claudeMdPath, 'utf8');
    const next = removeManagedBlock(prev, MD_START, MD_END);
    if (next !== prev) {
      modifiedFiles.push(env.claudeMdPath);
      if (!options.dryRun) {
        atomicWriteFile(env.claudeMdPath, next);
      }
    }
  }

  for (const skillName of managedCopies) {
    const destSkillDir = path.join(env.claudeSkills, skillName);
    if (fs.existsSync(destSkillDir)) {
      removedCopies.push(destSkillDir);
      if (!options.dryRun) {
        fs.rmSync(destSkillDir, { recursive: true, force: true });
      }
    }
  }

  return { host: 'claude', modifiedFiles, removedCopies };
}

/**
 * Run health checks across shelf home, sync consistency, and configured host integrations.
 * @param {object} env
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }> }}
 */
export function runDoctorChecks(env) {
  const checks = [];
  const cfg = loadShelfConfig(env);

  checks.push({
    name: 'shelf-config',
    ok: Boolean(cfg && Array.isArray(cfg.coreSkills)),
    detail: cfg
      ? `Loaded config.json (${cfg.coreSkills.length} core skills, hosts=${(cfg.hosts || []).join(',')})`
      : `Missing or invalid ${env.configPath}`,
  });

  checks.push({
    name: 'catalog-jsonl',
    ok: fs.existsSync(env.catalogPath),
    detail: fs.existsSync(env.catalogPath)
      ? `Catalog present at ${env.catalogPath}`
      : `Missing ${env.catalogPath}`,
  });

  checks.push({
    name: 'runtime-cli',
    ok: fs.existsSync(env.runtimeCliPath),
    detail: fs.existsSync(env.runtimeCliPath)
      ? `Self-contained runtime at ${env.runtimeCliPath}`
      : `Missing runtime CLI at ${env.runtimeCliPath}`,
  });

  const hosts = cfg?.hosts || [];

  if (hosts.includes('codex')) {
    const tomlText = fs.existsSync(env.codexConfigPath)
      ? fs.readFileSync(env.codexConfigPath, 'utf8')
      : '';
    const tomlOk = tomlText.includes(TOML_START);
    const mdOk =
      fs.existsSync(env.codexAgentsMdPath) &&
      fs.readFileSync(env.codexAgentsMdPath, 'utf8').includes(MD_START);
    const skillsSections = (tomlText.match(/^\[skills\]\s*$/gm) || []).length;
    const budgetMatch = tomlText.match(/^\s*max_context_tokens\s*=\s*(\d+)/m);
    const budget = budgetMatch ? Number(budgetMatch[1]) : null;
    const budgetOk = budget === null || (budget > 2000 && budget <= MAX_CODEX_BUDGET);

    const drift = syncShelfIncremental(env, { dryRun: true });
    const driftOk = !drift.catalogChanged && !drift.configChanged && (drift.newlyAdded?.length || 0) === 0;

    checks.push({
      name: 'host-codex',
      ok: tomlOk && mdOk && skillsSections <= 1 && budgetOk && driftOk,
      detail: `config.toml managed=${tomlOk}, AGENTS.md managed=${mdOk}, [skills] sections=${skillsSections}, max_context_tokens=${budget ?? 'default'}, syncDrift=${!driftOk}`,
    });
  }

  if (hosts.includes('antigravity')) {
    const pluginJsonPath = path.join(env.antigravityPluginDir, 'plugin.json');
    const rulePath = path.join(env.antigravityPluginDir, 'rules', 'skill-shelf.md');
    const skillsDir = path.join(env.antigravityPluginDir, 'skills');
    let manifestOk = false;
    try {
      const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      manifestOk = pj?.name === 'skill-shelf';
    } catch {
      manifestOk = false;
    }
    const ruleOk = fs.existsSync(rulePath);
    const fmErrors = [];
    if (fs.existsSync(skillsDir)) {
      for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const mdPath = path.join(skillsDir, ent.name, 'SKILL.md');
        if (!fs.existsSync(mdPath)) {
          fmErrors.push(`${ent.name}: missing SKILL.md`);
          continue;
        }
        const parsed = parseSkillMarkdown(fs.readFileSync(mdPath, 'utf8'), ent.name);
        if (!parsed.valid) {
          fmErrors.push(`${ent.name}: ${parsed.issues.join(',')}`);
        }
      }
    }
    checks.push({
      name: 'host-antigravity',
      ok: manifestOk && ruleOk && fmErrors.length === 0,
      detail:
        fmErrors.length > 0
          ? `Frontmatter issues: ${fmErrors.join('; ')}`
          : `plugin.json=${manifestOk}, rule=${ruleOk}, all copied skills valid`,
    });
  }

  if (hosts.includes('claude')) {
    const mdOk =
      fs.existsSync(env.claudeMdPath) &&
      fs.readFileSync(env.claudeMdPath, 'utf8').includes(MD_START);
    checks.push({
      name: 'host-claude',
      ok: mdOk,
      detail: `CLAUDE.md managed=${mdOk}`,
    });
  }

  return {
    ok: checks.every(c => c.ok),
    checks,
  };
}
