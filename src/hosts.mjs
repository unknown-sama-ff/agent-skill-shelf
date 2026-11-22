import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSkillFile, parseSkillMarkdown } from './frontmatter.mjs';
import { toPosix } from './paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const TOML_START = '# AGENT_SKILL_SHELF_START';
export const TOML_END = '# AGENT_SKILL_SHELF_END';
export const MD_START = '<!-- AGENT_SKILL_SHELF_START -->';
export const MD_END = '<!-- AGENT_SKILL_SHELF_END -->';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * Save <shelfHome>/config.json.
 * @param {object} env
 * @param {object} config
 */
export function saveShelfConfig(env, config) {
  fs.mkdirSync(env.shelfHome, { recursive: true });
  fs.writeFileSync(env.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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

/**
 * Apply Core + Shelf settings to Codex (config.toml + AGENTS.md).
 * @param {object} env
 * @param {object} scanResult
 * @param {Set<string>} coreSet
 * @param {object} options
 * @returns {object}
 */
export function applyCodex(env, scanResult, coreSet, options = {}) {
  const hiddenEntries = scanResult.entries.filter(entry => {
    if (entry.source !== 'codex' && entry.source !== 'agents') return false;
    if (!coreSet.has(entry.name)) return true;
    const owner = scanResult.unique.get(entry.name);
    return Boolean(owner && owner.path !== entry.path);
  });

  hiddenEntries.sort((a, b) => a.path.localeCompare(b.path));
  const tomlLines = [
    '# Managed by agent-skill-shelf. Run `skill-shelf restore` to remove safely.',
  ];
  for (const entry of hiddenEntries) {
    tomlLines.push('[[skills.config]]');
    tomlLines.push(`path = "${toPosix(entry.path)}"`);
    tomlLines.push('enabled = false');
    tomlLines.push('');
  }
  const tomlBlockBody = tomlLines.join('\n').trimEnd();
  const mdBlockBody = renderRoutingRule(env);

  const existingToml = fs.existsSync(env.codexConfigPath)
    ? fs.readFileSync(env.codexConfigPath, 'utf8')
    : '';
  const nextToml = upsertManagedBlock(existingToml, TOML_START, TOML_END, tomlBlockBody);

  const existingAgentsMd = fs.existsSync(env.codexAgentsMdPath)
    ? fs.readFileSync(env.codexAgentsMdPath, 'utf8')
    : '';
  const nextAgentsMd = upsertManagedBlock(existingAgentsMd, MD_START, MD_END, mdBlockBody);

  if (!options.dryRun) {
    fs.mkdirSync(env.codexHome, { recursive: true });
    if (options.backupDir) {
      backupFile(env.codexConfigPath, options.backupDir, env.userHome);
      backupFile(env.codexAgentsMdPath, options.backupDir, env.userHome);
    }
    fs.writeFileSync(env.codexConfigPath, nextToml, 'utf8');
    fs.writeFileSync(env.codexAgentsMdPath, nextAgentsMd, 'utf8');
  }

  return {
    host: 'codex',
    hiddenEntriesCount: hiddenEntries.length,
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
        fs.writeFileSync(filePath, next, 'utf8');
      }
    }
  }
  return { host: 'codex', modifiedFiles: changed };
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
    'description: Search on-demand local skills across Codex, Claude Code, and .agents repositories, or promote and demote skills between the Core catalog and the On-Demand Shelf.',
    '---',
    '',
    '# Agent Skill Shelf Manager',
    '',
    'Use the local CLI runtime to query non-core skills or adjust the active Core tier without editing original skill directories:',
    '',
    '```bash',
    `# Search all local and newly added skills`,
    `${cliCmd} find "<keywords>"`,
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
      version: '0.1.0',
      description: 'Tiered Core skills plus fast local routing for the On-Demand Skill Shelf.',
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
    fs.writeFileSync(env.claudeMdPath, nextClaudeMd, 'utf8');

    // Sync managed copies: keep/refresh if in coreSet, remove if demoted out of coreSet
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

    // If an explicit enable requested copying a skill not originally in ~/.claude/skills
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
        fs.writeFileSync(env.claudeMdPath, next, 'utf8');
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
 * Run health checks across shelf home and configured host integrations.
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
    const tomlOk =
      fs.existsSync(env.codexConfigPath) &&
      fs.readFileSync(env.codexConfigPath, 'utf8').includes(TOML_START);
    const mdOk =
      fs.existsSync(env.codexAgentsMdPath) &&
      fs.readFileSync(env.codexAgentsMdPath, 'utf8').includes(MD_START);
    checks.push({
      name: 'host-codex',
      ok: tomlOk && mdOk,
      detail: `config.toml managed=${tomlOk}, AGENTS.md managed=${mdOk}`,
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
