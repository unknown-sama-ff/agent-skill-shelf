import fs from 'node:fs';
import path from 'node:path';
import { normPath, toPosix } from './paths.mjs';

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
 * Persist catalog rows to <shelfHome>/catalog.jsonl atomically when changed.
 * @param {string} shelfHome
 * @param {Array<object>} rows
 * @returns {boolean} Whether the file was written (changed)
 */
export function saveCatalog(shelfHome, rows) {
  fs.mkdirSync(shelfHome, { recursive: true });
  const catalogPath = path.join(shelfHome, 'catalog.jsonl');
  const content = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  if (fs.existsSync(catalogPath)) {
    const prev = fs.readFileSync(catalogPath, 'utf8').replace(/\r\n/g, '\n');
    if (prev === content) return false;
  }
  const tmpPath = `${catalogPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, catalogPath);
  } catch {
    fs.copyFileSync(tmpPath, catalogPath);
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
  }
  return true;
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
 * Build path-keyed catalog rows from scanResult while preserving all distinct skill paths,
 * existing bilingual tags, and auto-sync metadata.
 * @param {object} scanResult
 * @param {Set<string>} coreSet
 * @param {Array<object>} existingRows
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function buildCatalogRows(scanResult, coreSet, existingRows = [], options = {}) {
  const existingByPath = new Map();
  const tagsByName = new Map();

  for (const row of existingRows) {
    if (row?.path) {
      existingByPath.set(normPath(row.path), row);
    }
    if (row?.name && Array.isArray(row.tags) && row.tags.length > 0 && !tagsByName.has(row.name)) {
      tagsByName.set(row.name, normalizeTags(row.tags));
    }
  }

  const nowIso = options.nowIso || new Date().toISOString();
  const markNewOrigin = options.origin || null;

  return scanResult.entries.map(entry => {
    const owner = scanResult.unique.get(entry.name);
    const isCanonicalCore = coreSet.has(entry.name) && owner && owner.normPath === entry.normPath;
    const prev = existingByPath.get(entry.normPath);
    const tags =
      prev && Array.isArray(prev.tags) && prev.tags.length > 0
        ? normalizeTags(prev.tags)
        : tagsByName.get(entry.name) || [];

    const row = {
      name: entry.name,
      tier: isCanonicalCore ? 'core' : 'shelf',
      source: entry.source,
      path: toPosix(entry.path),
      sha256: entry.sha256 || '',
      description: entry.description,
      tags,
    };

    if (prev?.addedAt) {
      if (prev.origin) row.origin = prev.origin;
      row.addedAt = prev.addedAt;
    } else if (!prev && markNewOrigin) {
      row.origin = markNewOrigin;
      row.addedAt = nowIso;
    }

    return row;
  });
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
 * Deduplicates only exact-content duplicates (same name + sha256), preserving same-name skills
 * with distinct content across different roots, and distinguishes core, shelf, and newly discovered skills.
 * @param {Array<object>} rows
 * @param {string} query
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function searchSkills(rows, query, options = {}) {
  const limit = Math.max(1, Number.isFinite(options.limit) ? options.limit : 5);
  const tierFilter = options.tier && options.tier !== 'all' ? options.tier : null;
  const newlyAddedPaths = options.newlyAddedPaths || new Set();
  const cleanQuery = String(query || '').trim().toLowerCase();
  if (!cleanQuery) return [];

  const pool = rows.filter(r => {
    if (r.stale) return false;
    if (!tierFilter) return true;
    if (tierFilter === 'new') {
      return r.path ? newlyAddedPaths.has(normPath(r.path)) : false;
    }
    return r.tier === tierFilter;
  });

  const { ascii, cjkPhrases, cjkBigrams } = extractQueryTerms(cleanQuery);
  const allTerms = [...ascii, ...cjkPhrases];
  const nDocs = Math.max(1, pool.length);

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
    let matchedCount = 0;

    for (const term of ascii) {
      const idf = idfMap.get(term) ?? 1;
      let hit = false;
      if (hasWordBoundary(nameLower, term)) {
        score += 40;
        hit = true;
      } else if (nameLower.includes(term)) {
        score += 18;
        hit = true;
      }

      if (tagsLower.includes(term)) {
        score += 35;
        hit = true;
      } else if (tagsJoined.includes(term)) {
        score += 16;
        hit = true;
      }

      if (hasWordBoundary(descLower, term)) {
        score += Math.min(18, Math.max(6, Math.round(6 + 4 * idf)));
        hit = true;
      } else if (descLower.includes(term)) {
        score += Math.min(10, Math.max(3, Math.round(3 + 2 * idf)));
        hit = true;
      }
      if (hit) matchedCount += 1;
    }

    for (const phrase of cjkPhrases) {
      const idf = idfMap.get(phrase) ?? 1;
      let hit = false;
      if (nameLower.includes(phrase)) { score += 40; hit = true; }
      if (tagsLower.includes(phrase)) {
        score += 35;
        hit = true;
      } else if (tagsJoined.includes(phrase)) {
        score += 22;
        hit = true;
      }
      if (descLower.includes(phrase)) {
        score += Math.min(20, Math.max(8, Math.round(8 + 4 * idf)));
        hit = true;
      }
      if (hit) matchedCount += 1;
    }

    if (allTerms.length > 1 && matchedCount === allTerms.length) {
      score += 30;
    }

    if (cjkBigrams.length > 0 && cjkBigrams.some(bg => !cjkPhrases.includes(bg))) {
      for (const bg of cjkBigrams) {
        if (cjkPhrases.includes(bg)) continue;
        if (nameLower.includes(bg)) score += 18;
        if (tagsJoined.includes(bg)) score += 16;
        if (descLower.includes(bg)) score += 8;
      }
    }

    if (score > 0) {
      const isNew = row.path ? newlyAddedPaths.has(normPath(row.path)) : false;
      const tier = row.tier || 'shelf';
      scored.push({
        name: row.name,
        tier,
        discovery: isNew ? 'new' : tier,
        source: row.source,
        path: row.path,
        sha256: row.sha256 || '',
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
      Number(b.source === 'codex') - Number(a.source === 'codex') ||
      a.name.localeCompare(b.name) ||
      String(a.path || '').localeCompare(String(b.path || ''))
  );

  // Deduplicate ONLY exact-content duplicates (same name + same sha256)
  const seenExact = new Set();
  const deduped = [];
  for (const item of scored) {
    const key = item.sha256
      ? `${item.name.toLowerCase()}::${item.sha256}`
      : `${item.name.toLowerCase()}::${item.description.slice(0, 120).toLowerCase()}`;
    if (seenExact.has(key)) continue;
    seenExact.add(key);
    const { sha256: _omit, ...publicItem } = item;
    deduped.push(publicItem);
    if (deduped.length >= limit) break;
  }

  return deduped;
}
