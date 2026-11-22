import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMarkdown } from './frontmatter.mjs';

const SOURCE_PRIORITY = {
  codex: 4,
  claude: 3,
  agents: 2,
  custom: 1,
};

/**
 * Scan all configured local skill repositories (skipping hidden dot-dirs and node_modules).
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

  const entries = [];
  const bySource = {};

  for (const root of roots) {
    bySource[root.source] = bySource[root.source] || 0;
    if (!root.dir || !fs.existsSync(root.dir)) continue;

    const dirEntries = fs.readdirSync(root.dir, { withFileTypes: true });
    for (const ent of dirEntries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;

      const skillDir = path.join(root.dir, ent.name);
      const mdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(mdPath)) continue;

      let raw;
      try {
        raw = fs.readFileSync(mdPath, 'utf8');
      } catch {
        continue;
      }

      const parsed = parseSkillMarkdown(raw, ent.name);
      const entry = {
        name: ent.name,
        declaredName: parsed.name,
        description: parsed.description,
        path: mdPath,
        dir: skillDir,
        source: root.source,
        priority: SOURCE_PRIORITY[root.source] ?? 1,
        hasFrontmatter: parsed.hasFrontmatter,
        validFrontmatter: parsed.valid,
        issues: parsed.issues,
        catalogChars: ent.name.length + parsed.description.length + 12,
      };
      entries.push(entry);
      bySource[root.source] += 1;
    }
  }

  const unique = new Map();
  const grouped = new Map();

  for (const entry of entries) {
    if (!grouped.has(entry.name)) grouped.set(entry.name, []);
    grouped.get(entry.name).push(entry);

    const prev = unique.get(entry.name);
    if (!prev || entry.priority > prev.priority) {
      unique.set(entry.name, entry);
    }
  }

  const duplicates = [];
  for (const [name, list] of grouped.entries()) {
    if (list.length <= 1) continue;
    const kept = unique.get(name);
    const shadowed = list.filter(item => item.path !== kept.path);
    duplicates.push({
      name,
      kept: { source: kept.source, path: kept.path },
      shadowed: shadowed.map(s => ({ source: s.source, path: s.path })),
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
