import fs from 'node:fs';
import path from 'node:path';
import {
  applyAntigravity,
  applyClaude,
  applyCodex,
  DEFAULT_CODEX_BUDGET,
  installRuntime,
  loadShelfConfig,
  REPO_ROOT,
  resolveCodexBudget,
  restoreAntigravity,
  restoreClaude,
  restoreCodex,
  runDoctorChecks,
  saveShelfConfig,
  syncShelfIncremental,
} from './hosts.mjs';
import { detectHosts, normPath, resolveEnvironment } from './paths.mjs';
import { scanSkillSources, suggestCoreSkills } from './scanner.mjs';
import {
  buildCatalogRows,
  loadCatalog,
  normalizeTags,
  saveCatalog,
  searchSkills,
} from './search.mjs';

const VALID_HOSTS = new Set(['codex', 'antigravity', 'claude']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '-q' || arg === '--quiet') {
      flags.quiet = true;
    } else if (
      arg === '--json' ||
      arg === '--pretty' ||
      arg === '--dry-run' ||
      arg === '--purge-home' ||
      arg === '--export' ||
      arg === '--no-sync' ||
      arg === '--check'
    ) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.2.0';
  } catch {
    return '0.2.0';
  }
}

function printHelp() {
  console.log(`agent-skill-shelf v${getPackageVersion()}
Tiered skill governance (Core + On-Demand Shelf) for Codex, Claude Code, and Antigravity.

Usage:
  skill-shelf <command> [options]

Commands:
  audit                      Read-only scan of installed hosts, skills, duplicates, and savings
  apply                      Configure Core + On-Demand Shelf across detected or selected hosts
  sync                       Incrementally index newly installed skills into Shelf and sync Codex config
  find "<query>"             Auto-sync & search the shelf (BM25 + CJK tags + multi-source aware)
  enable <name>              Promote a skill from the On-Demand Shelf into Core
  disable <name>             Demote a Core skill back to the On-Demand Shelf
  list                       Show Core and Shelf counts and skill names
  tags --export | --import   Export skill metadata or import bilingual search tags JSON
  tags --set <name> <t1,t2>  Set comma-separated search tags for a skill
  doctor                     Verify runtime, catalog, sync drift, and host integrations
  restore                    Remove managed host blocks/plugins and restore original configs

Common Options:
  --user-home <dir>          Override user home directory (for testing or custom layouts)
  --shelf-home <dir>         Override shelf data/runtime directory
  --hosts <a,b,c>            Comma-separated hosts: codex,antigravity,claude
  --core <a,b,c>             Comma-separated Core skill names for apply
  --core-file <path>         File containing Core skill names (one per line or JSON array)
  --max-core <n>             Max auto-selected Core skills when --core is omitted (default: 30)
  --codex-budget <n>         Codex [skills].max_context_tokens (default: 8000, max: 10000)
  --no-sync                  Skip automatic incremental sync before find
  --check                    With sync: dry-run and exit 1 if catalog or config drift is detected
  --quiet, -q                Suppress routine sync output
  --dry-run                  Preview mutations without writing files
  --json                     Output machine-readable JSON
  -h, --help                 Show this help message
  -v, --version              Show version`);
}

function resolveRequestedHosts(flags, env, fallbackHosts = null) {
  if (flags.hosts) {
    const list = flags.hosts
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    for (const h of list) {
      if (!VALID_HOSTS.has(h)) {
        throw new Error(`Unsupported host "${h}". Supported hosts: codex, antigravity, claude.`);
      }
    }
    return [...new Set(list)];
  }
  if (fallbackHosts && fallbackHosts.length > 0) return fallbackHosts;
  return detectHosts(env).detectedList;
}

function parseCoreSelection(flags, scanResult) {
  if (flags.core) {
    const names = flags.core
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return names.filter(n => scanResult.unique.has(n));
  }
  if (flags['core-file']) {
    const raw = fs.readFileSync(path.resolve(flags['core-file']), 'utf8').trim();
    let names;
    if (raw.startsWith('[')) {
      names = JSON.parse(raw);
    } else {
      names = raw
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    }
    return names.filter(n => scanResult.unique.has(n));
  }
  const maxCore = flags['max-core'] !== undefined ? parseInt(flags['max-core'], 10) : 30;
  return suggestCoreSkills(scanResult, Number.isNaN(maxCore) ? 30 : maxCore);
}

function syncHostsAndCatalog(env, scanResult, hosts, coreSkills, options = {}) {
  const coreSet = new Set(coreSkills);
  const prevConfig = loadShelfConfig(env);
  const codexBudget = resolveCodexBudget(
    options.codexBudget !== undefined ? options.codexBudget : prevConfig?.codexBudget,
    DEFAULT_CODEX_BUDGET
  );
  const existingCatalog = loadCatalog(env.shelfHome);
  const catalogRows = buildCatalogRows(scanResult, coreSet, existingCatalog);

  let backupDir = null;
  if (!options.dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = path.join(env.backupsDir, stamp);
    installRuntime(env.shelfHome);
    saveCatalog(env.shelfHome, catalogRows);
  }

  let claudeManagedCopies = prevConfig?.claudeManagedCopies || [];
  const prevManagedKey = JSON.stringify([...claudeManagedCopies].sort());
  const hostResults = [];

  for (const host of hosts) {
    if (host === 'codex') {
      hostResults.push(
        applyCodex(env, scanResult, coreSet, { ...options, backupDir, codexBudget })
      );
    } else if (host === 'antigravity') {
      hostResults.push(applyAntigravity(env, scanResult, coreSet, options));
    } else if (host === 'claude') {
      const res = applyClaude(env, scanResult, coreSet, {
        ...options,
        backupDir,
        claudeManagedCopies,
      });
      claudeManagedCopies = res.claudeManagedCopies;
      hostResults.push(res);
    }
  }

  let finalCatalogRows = catalogRows;
  if (!options.dryRun && JSON.stringify([...claudeManagedCopies].sort()) !== prevManagedKey) {
    const postScan = scanSkillSources(env);
    finalCatalogRows = buildCatalogRows(postScan, coreSet, catalogRows);
    saveCatalog(env.shelfHome, finalCatalogRows);
  }

  const nextConfig = {
    version: 2,
    hosts,
    coreSkills: [...coreSet].sort(),
    codexBudget,
    claudeManagedCopies,
    updatedAt: new Date().toISOString(),
  };

  if (!options.dryRun) {
    saveShelfConfig(env, nextConfig);
  }

  return {
    dryRun: Boolean(options.dryRun),
    hosts,
    codexBudget,
    coreCount: nextConfig.coreSkills.length,
    shelfCount: finalCatalogRows.filter(r => r.tier !== 'core').length,
    totalCatalogEntries: finalCatalogRows.length,
    totalUniqueSkills: scanResult.uniqueCount,
    backupDir: options.dryRun ? null : backupDir,
    hostResults,
  };
}

function cmdAudit(env, flags) {
  const detected = detectHosts(env);
  const scan = scanSkillSources(env);
  const maxCore = flags['max-core'] !== undefined ? parseInt(flags['max-core'], 10) : 30;
  const suggestedCore = suggestCoreSkills(scan, Number.isNaN(maxCore) ? 30 : maxCore);
  const suggestedSet = new Set(suggestedCore);

  const coreChars = scan.uniqueList
    .filter(e => suggestedSet.has(e.name))
    .reduce((sum, e) => sum + e.catalogChars, 0);
  const savedCharsPct =
    scan.totalRawChars > 0
      ? Math.round(((scan.totalRawChars - coreChars) / scan.totalRawChars) * 100)
      : 0;

  const report = {
    userHome: env.userHome,
    shelfHome: env.shelfHome,
    detectedHosts: detected,
    bySource: scan.bySource,
    totalEntriesCount: scan.totalEntriesCount,
    uniqueCount: scan.uniqueCount,
    duplicatesCount: scan.duplicates.length,
    duplicates: scan.duplicates,
    frontmatterIssuesCount: scan.issueSkills.length,
    frontmatterIssues: scan.issueSkills,
    estimatedRawPromptChars: scan.totalRawChars,
    estimatedUniquePromptChars: scan.estimatedPromptChars,
    estimatedUniqueTokens: scan.estimatedTokens,
    suggestedCoreCount: suggestedCore.length,
    suggestedCoreSkills: suggestedCore,
    estimatedCorePromptChars: coreChars,
    estimatedCoreTokens: Math.ceil(coreChars / 4),
    estimatedReductionPercent: savedCharsPct,
  };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('=== Agent Skill Shelf Audit (Read-Only) ===');
  console.log(`Detected hosts : ${detected.detectedList.join(', ') || 'none'}`);
  console.log(`By source      : ${JSON.stringify(scan.bySource)}`);
  console.log(
    `Skills         : ${scan.totalEntriesCount} total entries, ${scan.uniqueCount} unique, ${scan.duplicates.length} duplicate(s), ${scan.issueSkills.length} frontmatter issue(s)`
  );
  console.log(
    `Prompt catalog : ~${scan.totalRawChars} chars raw -> ~${coreChars} chars with ${suggestedCore.length} Core skills (${savedCharsPct}% reduction)`
  );
  if (scan.duplicates.length > 0) {
    console.log(`Duplicates     : ${scan.duplicates.map(d => d.name).join(', ')}`);
  }
  if (scan.issueSkills.length > 0) {
    console.log(
      `Issues         : ${scan.issueSkills.map(i => `${i.name}(${i.issues.join('+')})`).join(', ')}`
    );
  }
}

function cmdApply(env, flags) {
  const scan = scanSkillSources(env);
  const hosts = resolveRequestedHosts(flags, env);
  if (hosts.length === 0) {
    throw new Error('No supported host directories found and --hosts was not specified.');
  }
  const coreSkills = parseCoreSelection(flags, scan);
  const result = syncHostsAndCatalog(env, scan, hosts, coreSkills, {
    dryRun: Boolean(flags['dry-run']),
    codexBudget: flags['codex-budget'],
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `${result.dryRun ? '[DRY-RUN] ' : ''}Applied agent-skill-shelf: hosts=[${result.hosts.join(', ')}], core=${result.coreCount}, shelf=${result.shelfCount}, codexBudget=${result.codexBudget}`
  );
  if (result.backupDir) {
    console.log(`Backups saved to: ${result.backupDir}`);
  }
}

function cmdSync(env, flags) {
  const dryRun = Boolean(flags['dry-run'] || flags.check);
  const res = syncShelfIncremental(env, {
    dryRun,
    codexBudget: flags['codex-budget'],
  });

  if (!res.initialized) {
    throw new Error(`Shelf is not initialized at ${env.configPath}. Run "skill-shelf apply" first.`);
  }

  if (flags.json) {
    console.log(JSON.stringify({ ...res, newlyAddedPaths: undefined }, null, 2));
  } else if (!flags.quiet) {
    console.log(
      `${res.dryRun ? '[DRY-RUN] ' : ''}Synced skill-shelf: total=${res.totalCatalog}, core=${res.coreCount}, shelf=${res.shelfCount}, added=${res.newlyAdded.length}, stale=${res.stalePaths.length}, catalogChanged=${res.catalogChanged}, configChanged=${res.configChanged}`
    );
  }

  if (flags.check && (res.catalogChanged || res.configChanged || res.newlyAdded.length > 0)) {
    process.exitCode = 1;
  }
}

function buildLiveSearchRows(env, options = {}) {
  let newlyAddedPaths = new Set();

  if (!options.noSync && fs.existsSync(env.configPath)) {
    const syncRes = syncShelfIncremental(env, { dryRun: false });
    if (syncRes?.newlyAddedPaths) {
      newlyAddedPaths = syncRes.newlyAddedPaths;
    }
  }

  const savedRows = loadCatalog(env.shelfHome);
  if (!options.noSync && savedRows.length > 0 && fs.existsSync(env.configPath)) {
    return { rows: savedRows, newlyAddedPaths };
  }

  const cfg = loadShelfConfig(env);
  const coreSet = new Set(cfg?.coreSkills || []);
  const scan = scanSkillSources(env);

  if (scan.entries.length === 0 && savedRows.length > 0) {
    return { rows: savedRows, newlyAddedPaths };
  }

  const savedByPath = new Map(savedRows.filter(r => r?.path).map(r => [normPath(r.path), r]));
  const rows = buildCatalogRows(scan, coreSet, savedRows);
  for (const r of rows) {
    if (!savedByPath.has(normPath(r.path))) {
      newlyAddedPaths.add(normPath(r.path));
    }
  }
  return { rows, newlyAddedPaths };
}

function cmdFind(env, flags, positional) {
  const query = positional.join(' ').trim();
  if (!query) {
    throw new Error('Usage: skill-shelf find "<keywords>" [--limit N] [--tier all|core|shelf|new] [--no-sync]');
  }
  const limit = flags.limit !== undefined ? parseInt(flags.limit, 10) : 5;
  const { rows, newlyAddedPaths } = buildLiveSearchRows(env, { noSync: Boolean(flags['no-sync']) });
  const results = searchSkills(rows, query, {
    limit: Number.isNaN(limit) ? 5 : limit,
    tier: flags.tier || 'all',
    newlyAddedPaths,
  });

  if (flags.pretty) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log('No matching local skill.');
    return;
  }
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
}

function cmdToggle(env, flags, positional, enable) {
  const skillName = positional[0];
  if (!skillName) {
    throw new Error(`Usage: skill-shelf ${enable ? 'enable' : 'disable'} <skill-name>`);
  }
  const cfg = loadShelfConfig(env);
  if (!cfg) {
    throw new Error(`Shelf is not initialized at ${env.configPath}. Run "skill-shelf apply" first.`);
  }
  const scan = scanSkillSources(env);
  if (enable && !scan.unique.has(skillName)) {
    throw new Error(`Skill "${skillName}" was not found in local skill sources.`);
  }
  if (!enable && skillName === 'skill-shelf-manager') {
    throw new Error('Cannot disable built-in manager skill "skill-shelf-manager".');
  }

  const hosts = resolveRequestedHosts(flags, env, cfg.hosts);
  const coreSet = new Set(cfg.coreSkills || []);
  if (enable) coreSet.add(skillName);
  else coreSet.delete(skillName);

  const syncOptions = { codexBudget: flags['codex-budget'] };
  if (enable && hosts.includes('claude')) {
    syncOptions.promoteSkillToClaude = skillName;
  }

  const result = syncHostsAndCatalog(env, scan, hosts, [...coreSet], syncOptions);
  const payload = {
    action: enable ? 'enabled' : 'disabled',
    skill: skillName,
    hosts: result.hosts,
    coreCount: result.coreCount,
    shelfCount: result.shelfCount,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function cmdList(env, flags) {
  const { rows } = buildLiveSearchRows(env, { noSync: Boolean(flags['no-sync']) });
  const tier = flags.tier || 'all';
  const filtered = tier === 'all' ? rows : rows.filter(r => r.tier === tier);
  const core = rows.filter(r => r.tier === 'core').map(r => r.name);
  const shelf = rows.filter(r => r.tier !== 'core').map(r => r.name);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          totalEntries: rows.length,
          coreCount: core.length,
          shelfCount: shelf.length,
          items: filtered,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Total: ${rows.length} | Core: ${core.length} | Shelf: ${shelf.length}`);
  if (core.length > 0) console.log(`Core : ${core.join(', ')}`);
  if (tier !== 'core' && shelf.length > 0) console.log(`Shelf: ${shelf.join(', ')}`);
}

function cmdTags(env, flags, positional) {
  const { rows } = buildLiveSearchRows(env, { noSync: true });

  if (flags.export) {
    const seen = new Set();
    const payload = [];
    for (const r of rows) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      payload.push({
        name: r.name,
        description: r.description,
        tags: r.tags || [],
      });
    }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (flags.out) {
      const outPath = path.resolve(flags.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, serialized, 'utf8');
      console.log(`Exported ${payload.length} skills to ${outPath}`);
    } else {
      process.stdout.write(serialized);
    }
    return;
  }

  if (flags.import) {
    const importPath = path.resolve(flags.import);
    const raw = JSON.parse(fs.readFileSync(importPath, 'utf8'));
    const tagMap = new Map();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item?.name && Array.isArray(item.tags)) {
          tagMap.set(item.name, normalizeTags(item.tags));
        }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [name, tags] of Object.entries(raw)) {
        if (Array.isArray(tags)) tagMap.set(name, normalizeTags(tags));
      }
    } else {
      throw new Error('Import file must be a JSON object {skillName: [tags]} or array of {name, tags}.');
    }

    let updated = 0;
    const nextRows = rows.map(r => {
      if (!tagMap.has(r.name)) return r;
      updated += 1;
      return { ...r, tags: tagMap.get(r.name) };
    });
    saveCatalog(env.shelfHome, nextRows);
    console.log(JSON.stringify({ action: 'imported', updatedSkills: updated }));
    return;
  }

  if (flags.set) {
    const skillName = flags.set;
    const rawTags = positional[0] || '';
    const tags = normalizeTags(rawTags.split(','));
    const matches = rows.filter(r => r.name === skillName);
    if (matches.length === 0) {
      throw new Error(`Skill "${skillName}" not found in local catalog.`);
    }
    for (const target of matches) {
      target.tags = tags;
    }
    saveCatalog(env.shelfHome, rows);
    console.log(JSON.stringify({ action: 'set-tags', name: skillName, tags }));
    return;
  }

  throw new Error('Usage: skill-shelf tags <--export [--out PATH] | --import PATH | --set <name> <t1,t2>>');
}

function cmdDoctor(env, flags) {
  const report = runDoctorChecks(env);
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.checks) {
      console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.name}: ${c.detail}`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

function cmdRestore(env, flags) {
  const cfg = loadShelfConfig(env);
  const hosts = resolveRequestedHosts(flags, env, cfg?.hosts || null);
  const dryRun = Boolean(flags['dry-run']);
  const results = [];

  for (const host of hosts) {
    if (host === 'codex') results.push(restoreCodex(env, { dryRun }));
    else if (host === 'antigravity') results.push(restoreAntigravity(env, { dryRun }));
    else if (host === 'claude') {
      results.push(restoreClaude(env, cfg?.claudeManagedCopies || [], { dryRun }));
    }
  }

  let purgedHome = false;
  if (flags['purge-home'] && fs.existsSync(env.shelfHome)) {
    purgedHome = true;
    if (!dryRun) {
      fs.rmSync(env.shelfHome, { recursive: true, force: true });
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        restoredHosts: hosts,
        purgedHome,
        results,
      },
      null,
      2
    )
  );
}

/**
 * CLI entrypoint executed by bin/skill-shelf.mjs.
 * @param {string[]} argv
 */
export function runCli(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.version) {
    console.log(getPackageVersion());
    return;
  }
  if (flags.help || positional.length === 0) {
    printHelp();
    return;
  }

  const command = positional[0];
  const rest = positional.slice(1);
  const env = resolveEnvironment({
    userHome: flags['user-home'],
    shelfHome: flags['shelf-home'],
  });

  switch (command) {
    case 'audit':
      cmdAudit(env, flags);
      break;
    case 'apply':
      cmdApply(env, flags);
      break;
    case 'sync':
      cmdSync(env, flags);
      break;
    case 'find':
      cmdFind(env, flags, rest);
      break;
    case 'enable':
      cmdToggle(env, flags, rest, true);
      break;
    case 'disable':
      cmdToggle(env, flags, rest, false);
      break;
    case 'list':
      cmdList(env, flags);
      break;
    case 'tags':
      cmdTags(env, flags, rest);
      break;
    case 'doctor':
      cmdDoctor(env, flags);
      break;
    case 'restore':
      cmdRestore(env, flags);
      break;
    default:
      throw new Error(`Unknown command "${command}". Run "skill-shelf --help" for usage.`);
  }
}
