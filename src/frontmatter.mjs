import fs from 'node:fs';
import path from 'node:path';

/**
 * Strip matching surrounding single or double quotes from a YAML scalar string.
 * @param {string} value
 * @returns {string}
 */
export function unquoteYaml(value) {
  return value.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
}

/**
 * Extract a concise fallback description from a Markdown body.
 * @param {string} body
 * @param {string} fallbackName
 * @returns {string}
 */
function extractFallbackDescription(body, fallbackName) {
  const blocks = body
    .split(/\r?\n\s*\r?\n/)
    .map(b => b.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const candidate = blocks.find(b => b.length > 0) || `Skill ${fallbackName}.`;
  return candidate.slice(0, 240);
}

/**
 * Parse a SKILL.md file's YAML frontmatter and report structural validity.
 * @param {string} source
 * @param {string} fallbackName
 * @returns {{
 *   hasFrontmatter: boolean,
 *   valid: boolean,
 *   name: string,
 *   description: string,
 *   front: string,
 *   body: string,
 *   issues: string[]
 * }}
 */
export function parseSkillMarkdown(source, fallbackName) {
  const cleanSource = source.replace(/^\uFEFF/, '');
  const fmMatch = cleanSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const issues = [];

  if (!fmMatch) {
    issues.push('missing_frontmatter');
    const description = extractFallbackDescription(cleanSource, fallbackName);
    return {
      hasFrontmatter: false,
      valid: false,
      name: fallbackName,
      description,
      front: '',
      body: cleanSource,
      issues,
    };
  }

  const front = fmMatch[1];
  const body = cleanSource.slice(fmMatch[0].length);

  const nameMatch = front.match(/^name:\s*(.+)$/m);
  const rawName = nameMatch ? unquoteYaml(nameMatch[1]) : '';
  if (!rawName) {
    issues.push('missing_name');
  } else if (rawName !== fallbackName) {
    issues.push('name_mismatch');
  }

  const descMatch = front.match(
    /^description:\s*([^\r\n]*)(?:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*))?/m
  );
  const firstLine = descMatch?.[1]?.trim() || '';
  let description = '';
  if (/^[>|][-+0-9]*$/.test(firstLine)) {
    description = (descMatch?.[2] || '').trim().replace(/\s+/g, ' ');
  } else {
    description = unquoteYaml(firstLine);
  }

  if (!description) {
    issues.push('missing_description');
    description = extractFallbackDescription(body, fallbackName);
  }

  return {
    hasFrontmatter: true,
    valid: issues.length === 0,
    name: rawName || fallbackName,
    description,
    front,
    body,
    issues,
  };
}

/**
 * Normalize copied SKILL.md frontmatter inside a plugin folder without touching originals.
 * @param {string} destSkillDir
 * @param {string} skillName
 * @returns {{ modified: boolean, reason?: string }}
 */
export function normalizeSkillFile(destSkillDir, skillName) {
  const mdPath = path.join(destSkillDir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) {
    throw new Error(`Copied skill directory is missing SKILL.md: ${mdPath}`);
  }

  const raw = fs.readFileSync(mdPath, 'utf8');
  const parsed = parseSkillMarkdown(raw, skillName);

  if (parsed.valid) {
    return { modified: false };
  }

  if (!parsed.hasFrontmatter) {
    const content = [
      '---',
      `name: ${skillName}`,
      `description: ${JSON.stringify(parsed.description)}`,
      '---',
      '',
      parsed.body.replace(/^\r?\n+/, ''),
    ].join('\n');
    fs.writeFileSync(mdPath, content, 'utf8');
    return { modified: true, reason: 'added missing frontmatter' };
  }

  let updatedFront = parsed.front;
  if (!/^name:\s*.+$/m.test(updatedFront)) {
    updatedFront = `name: ${skillName}\n${updatedFront}`;
  } else if (parsed.name !== skillName) {
    updatedFront = updatedFront.replace(/^name:\s*.+$/m, `name: ${skillName}`);
  }

  if (parsed.issues.includes('missing_description')) {
    if (/^description:/m.test(updatedFront)) {
      updatedFront = updatedFront.replace(
        /^description:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/m,
        `description: ${JSON.stringify(parsed.description)}`
      );
    } else {
      updatedFront = `${updatedFront.trimEnd()}\ndescription: ${JSON.stringify(parsed.description)}`;
    }
  }

  const normalized = `---\n${updatedFront.trimEnd()}\n---\n${parsed.body}`;
  fs.writeFileSync(mdPath, normalized, 'utf8');
  return { modified: true, reason: parsed.issues.join(', ') };
}
