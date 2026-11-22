import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'skill-shelf.mjs');

function runCliCmd(args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return res;
}

function writeSkill(root, name, content) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}

describe('agent-skill-shelf end-to-end', () => {
  let tmpRoot;
  let userHome;
  let shelfHome;
  let origConfigToml;
  let origAgentsMd;
  let origClaudeMd;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-shelf-test-'));
    userHome = path.join(tmpRoot, 'home');
    shelfHome = path.join(tmpRoot, 'shelf');

    const codexHome = path.join(userHome, '.codex');
    const agentsHome = path.join(userHome, '.agents');
    const claudeHome = path.join(userHome, '.claude');
    const geminiPlugins = path.join(userHome, '.gemini', 'config', 'plugins');

    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'ignored-system'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', '.system', 'ignored-system', 'SKILL.md'),
      '---\nname: ignored-system\ndescription: hidden system skill\n---\n',
      'utf8'
    );
    fs.mkdirSync(path.join(agentsHome, 'skills', '.updater', 'backup-1'), { recursive: true });
    fs.writeFileSync(
      path.join(agentsHome, 'skills', '.updater', 'backup-1', 'SKILL.md'),
      '---\nname: backup-1\ndescription: hidden backup skill\n---\n',
      'utf8'
    );

    // Codex skills
    writeSkill(
      path.join(codexHome, 'skills'),
      'api-design',
      '---\nname: api-design\ndescription: REST API design guidelines and status codes.\n---\n\n# API Design\n'
    );
    writeSkill(
      path.join(codexHome, 'skills'),
      'python-testing',
      '---\nname: python-testing\ndescription: Pytest testing patterns and fixtures.\n---\n\n# Python Testing\n'
    );

    // Shared .agents skills (including a duplicate of api-design and a frontmatter-less skill)
    writeSkill(
      path.join(agentsHome, 'skills'),
      'api-design',
      '---\nname: api-design\ndescription: Duplicate shared copy.\n---\n'
    );
    writeSkill(
      path.join(agentsHome, 'skills'),
      'no-frontmatter-skill',
      '# No Frontmatter Skill\n\nHelpful workflow for rendering geometric CAD sections.\n'
    );
    writeSkill(
      path.join(agentsHome, 'skills'),
      'postgres-patterns',
      '---\nname: postgres-patterns\ndescription: PostgreSQL schema design, indexing, and SQL optimization.\n---\n'
    );
    writeSkill(
      path.join(agentsHome, 'skills'),
      'already-in-other-plugin',
      '---\nname: already-in-other-plugin\ndescription: Should be skipped inside Antigravity plugin on collision.\n---\n'
    );

    // Pre-existing Claude skill (must NEVER be deleted by disable/restore)
    writeSkill(
      path.join(claudeHome, 'skills'),
      'claude-native-skill',
      '---\nname: claude-native-skill\ndescription: User-installed native Claude skill.\n---\n'
    );

    // Another pre-existing Antigravity plugin containing already-in-other-plugin
    writeSkill(
      path.join(geminiPlugins, 'official-vendor', 'skills'),
      'already-in-other-plugin',
      '---\nname: already-in-other-plugin\ndescription: Vendor copy.\n---\n'
    );
    fs.writeFileSync(
      path.join(geminiPlugins, 'official-vendor', 'plugin.json'),
      '{"name":"official-vendor"}\n',
      'utf8'
    );

    origConfigToml = 'model = "gpt-5"\nsandbox_mode = "workspace-write"\n';
    origAgentsMd = '# User Codex Rules\nKeep edits minimal.\n';
    origClaudeMd = '# User Claude Rules\nRun tests before finishing.\n';

    fs.writeFileSync(path.join(codexHome, 'config.toml'), origConfigToml, 'utf8');
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), origAgentsMd, 'utf8');
    fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), origClaudeMd, 'utf8');
  });

  after(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('1. audit detects hosts, excludes dot-dirs, flags duplicates & frontmatter issues', () => {
    const res = runCliCmd(['audit', '--json', '--max-core', '2', '--user-home', userHome, '--shelf-home', shelfHome]);
    assert.equal(res.status, 0, res.stderr);
    const data = JSON.parse(res.stdout);

    assert.equal(data.detectedHosts.codex, true);
    assert.equal(data.detectedHosts.antigravity, true);
    assert.equal(data.detectedHosts.claude, true);
    assert.equal(data.uniqueCount, 6);
    assert.equal(data.totalEntriesCount, 7);
    assert.equal(data.duplicatesCount, 1);
    assert.equal(data.duplicates[0].name, 'api-design');
    assert.equal(data.duplicates[0].kept.source, 'codex');
    assert.equal(data.frontmatterIssuesCount, 1);
    assert.equal(data.frontmatterIssues[0].name, 'no-frontmatter-skill');
    assert.ok(data.estimatedReductionPercent > 0);
  });

  it('2. apply --dry-run performs zero mutations', () => {
    const res = runCliCmd([
      'apply',
      '--dry-run',
      '--core', 'api-design,no-frontmatter-skill,already-in-other-plugin',
      '--user-home', userHome,
      '--shelf-home', shelfHome,
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(shelfHome), false);
    assert.equal(
      fs.readFileSync(path.join(userHome, '.codex', 'config.toml'), 'utf8'),
      origConfigToml
    );
    assert.equal(
      fs.existsSync(path.join(userHome, '.gemini', 'config', 'plugins', 'skill-shelf')),
      false
    );
  });

  it('3. apply writes runtime, backups, normalized Antigravity copies, and preserves host files', () => {
    const res = runCliCmd([
      'apply',
      '--core', 'api-design,no-frontmatter-skill,already-in-other-plugin',
      '--user-home', userHome,
      '--shelf-home', shelfHome,
    ]);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(fs.existsSync(path.join(shelfHome, 'runtime', 'bin', 'skill-shelf.mjs')), true);
    assert.equal(fs.existsSync(path.join(shelfHome, 'catalog.jsonl')), true);
    assert.equal(fs.existsSync(path.join(shelfHome, 'config.json')), true);

    const backups = fs.readdirSync(path.join(shelfHome, 'backups'));
    assert.ok(backups.length >= 1);

    const toml = fs.readFileSync(path.join(userHome, '.codex', 'config.toml'), 'utf8');
    assert.ok(toml.includes('model = "gpt-5"'));
    assert.ok(toml.includes('# AGENT_SKILL_SHELF_START'));
    assert.ok(toml.includes('.agents/skills/api-design/SKILL.md'));
    assert.ok(toml.includes('postgres-patterns/SKILL.md'));

    const agentsMd = fs.readFileSync(path.join(userHome, '.codex', 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('# User Codex Rules'));
    assert.ok(agentsMd.includes('<!-- AGENT_SKILL_SHELF_START -->'));

    const claudeMd = fs.readFileSync(path.join(userHome, '.claude', 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('# User Claude Rules'));
    assert.ok(claudeMd.includes('<!-- AGENT_SKILL_SHELF_START -->'));

    // Antigravity plugin checks
    const pluginDir = path.join(userHome, '.gemini', 'config', 'plugins', 'skill-shelf');
    const pluginJson = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(pluginJson.name, 'skill-shelf');

    // Normalized frontmatter in copy, while original remains untouched
    const normMd = fs.readFileSync(
      path.join(pluginDir, 'skills', 'no-frontmatter-skill', 'SKILL.md'),
      'utf8'
    );
    assert.ok(normMd.startsWith('---\nname: no-frontmatter-skill\ndescription:'));
    const origNoFm = fs.readFileSync(
      path.join(userHome, '.agents', 'skills', 'no-frontmatter-skill', 'SKILL.md'),
      'utf8'
    );
    assert.ok(origNoFm.startsWith('# No Frontmatter Skill'));

    // Collision with official-vendor plugin should be skipped
    assert.equal(
      fs.existsSync(path.join(pluginDir, 'skills', 'already-in-other-plugin')),
      false
    );
  });

  it('4. re-running apply is strictly idempotent', () => {
    const res = runCliCmd([
      'apply',
      '--core', 'api-design,no-frontmatter-skill,already-in-other-plugin',
      '--user-home', userHome,
      '--shelf-home', shelfHome,
    ]);
    assert.equal(res.status, 0, res.stderr);

    for (const [file, marker] of [
      [path.join(userHome, '.codex', 'config.toml'), '# AGENT_SKILL_SHELF_START'],
      [path.join(userHome, '.codex', 'AGENTS.md'), '<!-- AGENT_SKILL_SHELF_START -->'],
      [path.join(userHome, '.claude', 'CLAUDE.md'), '<!-- AGENT_SKILL_SHELF_START -->'],
    ]) {
      const content = fs.readFileSync(file, 'utf8');
      const occurrences = content.split(marker).length - 1;
      assert.equal(occurrences, 1, `Expected 1 managed block in ${file}, found ${occurrences}`);
    }
  });

  it('5. tags persist across re-apply and find supports English, Chinese, and new disk skills', () => {
    const setRes = runCliCmd([
      'tags', '--set', 'postgres-patterns', '数据库,索引,postgresql',
      '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(setRes.status, 0, setRes.stderr);

    const importFile = path.join(tmpRoot, 'tags-import.json');
    fs.writeFileSync(
      importFile,
      JSON.stringify({ 'python-testing': ['单测', 'pytest', '夹具'] }),
      'utf8'
    );
    const impRes = runCliCmd([
      'tags', '--import', importFile,
      '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(impRes.status, 0, impRes.stderr);

    // Re-apply must preserve tags
    const reapplyRes = runCliCmd([
      'apply',
      '--core', 'api-design,no-frontmatter-skill',
      '--user-home', userHome,
      '--shelf-home', shelfHome,
    ]);
    assert.equal(reapplyRes.status, 0, reapplyRes.stderr);

    const cnRes = runCliCmd([
      'find', '数据库索引', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(cnRes.status, 0, cnRes.stderr);
    const firstCn = JSON.parse(cnRes.stdout.trim().split(/\r?\n/)[0]);
    assert.equal(firstCn.name, 'postgres-patterns');

    const enRes = runCliCmd([
      'find', 'pytest fixtures', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(enRes.status, 0, enRes.stderr);
    const firstEn = JSON.parse(enRes.stdout.trim().split(/\r?\n/)[0]);
    assert.equal(firstEn.name, 'python-testing');

    // Drop a brand new skill onto disk without running apply again
    writeSkill(
      path.join(userHome, '.agents', 'skills'),
      'docker-compose-helper',
      '---\nname: docker-compose-helper\ndescription: Multi-container Docker Compose orchestration.\n---\n'
    );
    const liveRes = runCliCmd([
      'find', 'docker compose', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(liveRes.status, 0, liveRes.stderr);
    const firstLive = JSON.parse(liveRes.stdout.trim().split(/\r?\n/)[0]);
    assert.equal(firstLive.name, 'docker-compose-helper');
  });

  it('6. enable and disable sync skills between shelf and core without deleting sources', () => {
    const enRes = runCliCmd([
      'enable', 'postgres-patterns', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(enRes.status, 0, enRes.stderr);

    const pluginSkill = path.join(
      userHome, '.gemini', 'config', 'plugins', 'skill-shelf', 'skills', 'postgres-patterns', 'SKILL.md'
    );
    assert.equal(fs.existsSync(pluginSkill), true);
    assert.equal(
      fs.existsSync(path.join(userHome, '.claude', 'skills', 'postgres-patterns', 'SKILL.md')),
      true
    );

    const tomlAfterEnable = fs.readFileSync(path.join(userHome, '.codex', 'config.toml'), 'utf8');
    assert.equal(tomlAfterEnable.includes('postgres-patterns/SKILL.md'), false);

    const disRes = runCliCmd([
      'disable', 'postgres-patterns', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(disRes.status, 0, disRes.stderr);
    assert.equal(fs.existsSync(pluginSkill), false);
    assert.equal(fs.existsSync(path.join(userHome, '.claude', 'skills', 'postgres-patterns')), false);

    // Original source skill must remain untouched
    assert.equal(
      fs.existsSync(path.join(userHome, '.agents', 'skills', 'postgres-patterns', 'SKILL.md')),
      true
    );
    // Pre-existing Claude native skill must remain untouched
    assert.equal(
      fs.existsSync(path.join(userHome, '.claude', 'skills', 'claude-native-skill', 'SKILL.md')),
      true
    );
  });

  it('7. doctor exits 0 with all checks passing', () => {
    const res = runCliCmd(['doctor', '--json', '--user-home', userHome, '--shelf-home', shelfHome]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.checks.every(c => c.ok));
  });

  it('8. restore cleanly removes managed configs/plugins and preserves original files verbatim', () => {
    // Enable one skill so Claude managed copy cleanup is also exercised on restore
    const enRes = runCliCmd([
      'enable', 'postgres-patterns', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(enRes.status, 0, enRes.stderr);

    const res = runCliCmd([
      'restore', '--purge-home', '--user-home', userHome, '--shelf-home', shelfHome,
    ]);
    assert.equal(res.status, 0, res.stderr);

    assert.equal(
      fs.readFileSync(path.join(userHome, '.codex', 'config.toml'), 'utf8'),
      origConfigToml
    );
    assert.equal(
      fs.readFileSync(path.join(userHome, '.codex', 'AGENTS.md'), 'utf8'),
      origAgentsMd
    );
    assert.equal(
      fs.readFileSync(path.join(userHome, '.claude', 'CLAUDE.md'), 'utf8'),
      origClaudeMd
    );
    assert.equal(
      fs.existsSync(path.join(userHome, '.gemini', 'config', 'plugins', 'skill-shelf')),
      false
    );
    assert.equal(fs.existsSync(path.join(userHome, '.claude', 'skills', 'postgres-patterns')), false);
    assert.equal(
      fs.existsSync(path.join(userHome, '.claude', 'skills', 'claude-native-skill', 'SKILL.md')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(userHome, '.agents', 'skills', 'postgres-patterns', 'SKILL.md')),
      true
    );
    assert.equal(fs.existsSync(shelfHome), false);
  });
});
