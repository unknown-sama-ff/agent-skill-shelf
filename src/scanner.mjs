import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMarkdown } from './frontmatter.mjs';
import { normPath, toPosix } from './paths.mjs';

const SOURCE_PRIORITY = {
  codex: 4,
  claude: 3,
  agents: 2,
  custom: 1,
};

const IGNORED_DIRS = new Set(['node_modules', '.git', '__pycache__', '.updater']);

function sha256Short(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Recursively scan all configured local skill repositories (skipping hidden dot-dirs and node_modules).
 * Uses normalized file paths as unique identifiers so same-name skills in different roots are preserved.
 * @param {object} env
 * @param {object} [options]
 * @returns {object}
 */
export function scanSkillSources(env, options = {}) {
  const roots = [
    { source: 'codex', dir: env.codexSkills },
    { source: 'claude', dir: env.claudeSkills },
    { source: 'agents', dir: env.agentsSkills },
    ...(options.extraSources || []).map(dir => ({ source: 'custom', dir })),
  ];

  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 6;
  const entries = [];
  const bySource = {};
  const seenPaths = new Set();
  const scanErrors = [];

  function walk(dir, source, depth) {
    if (!dir || !fs.existsSync(dir) || depth > maxDepth) return;
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      scanErrors.push({ type: 'readdir_error', path: toPosix(dir), detail: err.message });
      return;
    }

    for (const ent of dirEntries) {
      if (ent.name.startsWith('.') || IGNORED_DIRS.has(ent.name)) continue;

      const skillDir = path.join(dir, ent.name);
      let stat;
      try {
        stat = fs.statSync(skillDir);
      } catch (err) {
        scanErrors.push({ type: 'stat_error', path: toPosix(skillDir), detail: err.message });
        continue;
      }
      if (!stat.isDirectory()) continue;

      const mdPath = path.join(skillDir, 'SKILL.md');
      if (fs.existsSync(mdPath)) {
        const key = normPath(mdPath);
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          let raw;
          try {
            raw = fs.readFileSync(mdPath, 'utf8');
          } catch (err) {
            scanErrors.push({ type: 'read_error', path: toPosix(mdPath), detail: err.message });
            raw = null;
          }
          if (raw !== null) {
            const parsed = parseSkillMarkdown(raw, ent.name);
            const entry = {
              name: ent.name,
              declaredName: parsed.name,
              description: parsed.description,
              path: toPosix(mdPath),
              normPath: key,
              dir: skillDir,
              source,
              depth,
              priority: SOURCE_PRIORITY[source] ?? 1,
              sha256: sha256Short(raw),
              hasFrontmatter: parsed.hasFrontmatter,
              validFrontmatter: parsed.valid,
              issues: parsed.issues,
              catalogChars: ent.name.length + parsed.description.length + 12,
            };
            entries.push(entry);
            bySource[source] += 1;
          }
        }
      }

      // Recurse to pick up nested skill collections (e.g., references/<skill>/SKILL.md)
      walk(skillDir, source, depth + 1);
    }
  }

  for (const root of roots) {
    bySource[root.source] = bySource[root.source] || 0;
    walk(root.dir, root.source, 0);
  }

  entries.sort((a, b) => a.normPath.localeCompare(b.normPath));

  const unique = new Map();
  const grouped = new Map();

  for (const entry of entries) {
    if (!grouped.has(entry.name)) grouped.set(entry.name, []);
    grouped.get(entry.name).push(entry);

    const prev = unique.get(entry.name);
    if (
      !prev ||
      entry.priority > prev.priority ||
      (entry.priority === prev.priority && entry.depth < prev.depth)
    ) {
      unique.set(entry.name, entry);
    }
  }

  const duplicates = [];
  for (const [name, list] of grouped.entries()) {
    if (list.length <= 1) continue;
    const kept = unique.get(name);
    const shadowed = list.filter(item => item.normPath !== kept.normPath);
    const distinctHashes = new Set(list.map(i => i.sha256)).size;
    duplicates.push({
      name,
      sameContent: distinctHashes === 1,
      kept: { source: kept.source, path: kept.path },
      shadowed: shadowed.map(s => ({ source: s.source, path: s.path, sameAsKept: s.sha256 === kept.sha256 })),
    });
  }

  const issueSkills = entries
    .filter(e => !e.validFrontmatter)
    .map(e => ({ name: e.name, source: e.source, path: e.path, issues: e.issues }));

  const uniqueList = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totalRawChars = entries.reduce((sum, e) => sum + e.catalogChars, 0);
  const estimatedPromptChars = uniqueList.reduce((sum, e) => sum + e.catalogChars, 0);

  return {
    entries,
    unique,
    uniqueList,
    duplicates,
    issueSkills,
    scanErrors,
    bySource,
    totalEntriesCount: entries.length,
    uniqueCount: uniqueList.length,
    totalRawChars,
    estimatedPromptChars,
    estimatedTokens: Math.ceil(estimatedPromptChars / 4),
  };
}

/**
 * Compute a deterministic default Core skill set capped at maxCore.
 * Prefers skills with valid frontmatter and higher-priority host sources.
 * @param {object} scanResult
 * @param {number} [maxCore=30]
 * @returns {string[]}
 */
export function suggestCoreSkills(scanResult, maxCore = 30) {
  const cap = Math.max(0, Number.isFinite(maxCore) ? maxCore : 30);
  if (cap === 0) return [];
  const ranked = [...scanResult.uniqueList].sort((a, b) => {
    const validDiff = Number(b.validFrontmatter) - Number(a.validFrontmatter);
    if (validDiff !== 0) return validDiff;
    const prioDiff = b.priority - a.priority;
    if (prioDiff !== 0) return prioDiff;
    return a.name.localeCompare(b.name);
  });
  return ranked.slice(0, cap).map(e => e.name).sort();
}
