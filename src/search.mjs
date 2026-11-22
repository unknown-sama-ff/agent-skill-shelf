import fs from 'node:fs';
import path from 'node:path';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'use', 'when', 'this', 'that', 'from', 'into',
  'your', 'skill', 'agent', 'to', 'of', 'in', 'on', 'a', 'an', 'is', 'are',
  'or', 'by', 'as', 'at', 'be', 'it', 'if', 'can', 'will',
]);

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;
const ASCII_REGEX = /[a-z0-9][a-z0-9_-]*/g;

/**
 * Extract searchable ASCII tokens and CJK terms/bigrams from a query string.
 * @param {string} query
 * @returns {{ ascii: string[], cjkPhrases: string[], cjkBigrams: string[] }}
 */
export function extractQueryTerms(query) {
  const lower = String(query || '').trim().toLowerCase();
  const rawAscii = lower.match(ASCII_REGEX) || [];
  const filteredAscii = rawAscii.filter(t => !STOPWORDS.has(t));
  const ascii = [...new Set(filteredAscii.length > 0 ? filteredAscii : rawAscii)];

  const cjkPhrases = [...new Set(lower.match(CJK_REGEX) || [])];
  const cjkBigrams = new Set();
  for (const phrase of cjkPhrases) {
    if (phrase.length <= 2) {
      cjkBigrams.add(phrase);
      continue;
    }
    for (let i = 0; i < phrase.length - 1; i++) {
      cjkBigrams.add(phrase.slice(i, i + 2));
    }
  }

  return { ascii, cjkPhrases, cjkBigrams: [...cjkBigrams] };
}

/**
 * Load catalog.jsonl entries from shelfHome if present.
 * @param {string} shelfHome
 * @returns {Array<object>}
 */
export function loadCatalog(shelfHome) {
  const catalogPath = path.join(shelfHome, 'catalog.jsonl');
  if (!fs.existsSync(catalogPath)) return [];
  const lines = fs.readFileSync(catalogPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.name) rows.push(parsed);
    } catch {
      // Ignore malformed lines in user-edited catalog
    }
  }
  return rows;
}

/**
 * Persist catalog rows to <shelfHome>/catalog.jsonl.
 * @param {string} shelfHome
 * @param {Array<object>} rows
 */
export function saveCatalog(shelfHome, rows) {
  fs.mkdirSync(shelfHome, { recursive: true });
  const catalogPath = path.join(shelfHome, 'catalog.jsonl');
  const content = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(catalogPath, content, 'utf8');
}

/**
 * Normalize a list of tag strings.
 * @param {Array<string>} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const clean = String(t || '').trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * Build catalog rows from scanResult while preserving existing bilingual tags.
 * @param {object} scanResult
 * @param {Set<string>} coreSet
 * @param {Array<object>} existingRows
 * @returns {Array<object>}
 */
export function buildCatalogRows(scanResult, coreSet, existingRows = []) {
  const tagsByName = new Map();
  for (const row of existingRows) {
    if (row?.name && Array.isArray(row.tags) && row.tags.length > 0) {
      tagsByName.set(row.name, normalizeTags(row.tags));
    }
  }

  return scanResult.uniqueList.map(entry => ({
    name: entry.name,
    tier: coreSet.has(entry.name) ? 'core' : 'shelf',
    source: entry.source,
    path: entry.path,
    description: entry.description,
    tags: tagsByName.get(entry.name) || [],
  }));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWordBoundary(text, term) {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, 'i');
  return re.test(text);
}

/**
 * Search skills using hybrid lexical + BM25-like IDF weighting and CJK tag/phrase matching.
 * @param {Array<object>} rows
 * @param {string} query
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function searchSkills(rows, query, options = {}) {
  const limit = Math.max(1, Number.isFinite(options.limit) ? options.limit : 5);
  const tierFilter = options.tier && options.tier !== 'all' ? options.tier : null;
  const cleanQuery = String(query || '').trim().toLowerCase();
  if (!cleanQuery) return [];

  const pool = tierFilter ? rows.filter(r => r.tier === tierFilter) : rows;
  const { ascii, cjkPhrases, cjkBigrams } = extractQueryTerms(cleanQuery);
  const allTerms = [...ascii, ...cjkPhrases];
  const nDocs = Math.max(1, pool.length);

  // Precompute IDF weights across the searchable corpus
  const idfMap = new Map();
  for (const term of allTerms) {
    let df = 0;
    for (const r of pool) {
      const text = `${r.name} ${(r.tags || []).join(' ')} ${r.description || ''}`.toLowerCase();
      if (text.includes(term)) df += 1;
    }
    const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
    idfMap.set(term, idf);
  }

  const scored = [];
  for (const row of pool) {
    const nameLower = String(row.name || '').toLowerCase();
    const descLower = String(row.description || '').toLowerCase();
    const tagsLower = normalizeTags(row.tags || []);
    const tagsJoined = tagsLower.join(' ');

    let score = nameLower === cleanQuery ? 1000 : 0;

    for (const term of ascii) {
      const idf = idfMap.get(term) ?? 1;
      if (hasWordBoundary(nameLower, term)) {
        score += 40;
      } else if (nameLower.includes(term)) {
        score += 18;
      }

      if (tagsLower.includes(term)) {
        score += 35;
      } else if (tagsJoined.includes(term)) {
        score += 16;
      }

      if (hasWordBoundary(descLower, term)) {
        score += Math.min(18, Math.max(6, Math.round(6 + 4 * idf)));
      } else if (descLower.includes(term)) {
        score += Math.min(10, Math.max(3, Math.round(3 + 2 * idf)));
      }
    }

    for (const phrase of cjkPhrases) {
      const idf = idfMap.get(phrase) ?? 1;
      if (nameLower.includes(phrase)) score += 40;
      if (tagsLower.includes(phrase)) {
        score += 35;
      } else if (tagsJoined.includes(phrase)) {
        score += 22;
      }
      if (descLower.includes(phrase)) {
        score += Math.min(20, Math.max(8, Math.round(8 + 4 * idf)));
      }
    }

    // Fallback bigram recall for longer Chinese phrases without exact phrase hit
    if (cjkBigrams.length > 0 && cjkBigrams.some(bg => !cjkPhrases.includes(bg))) {
      for (const bg of cjkBigrams) {
        if (cjkPhrases.includes(bg)) continue;
        if (nameLower.includes(bg)) score += 18;
        if (tagsJoined.includes(bg)) score += 16;
        if (descLower.includes(bg)) score += 8;
      }
    }

    if (score > 0) {
      scored.push({
        name: row.name,
        tier: row.tier || 'shelf',
        source: row.source,
        path: row.path,
        tags: row.tags || [],
        description: String(row.description || '').slice(0, 240),
        score,
      });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.tier === 'core') - Number(a.tier === 'core') ||
      a.name.localeCompare(b.name)
  );

  return scored.slice(0, limit);
}
