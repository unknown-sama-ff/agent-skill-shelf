import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Convert Windows backslashes to POSIX forward slashes for portable TOML/Markdown paths.
 * @param {string} targetPath
 * @returns {string}
 */
export function toPosix(targetPath) {
  return path.resolve(targetPath).replace(/\\/g, '/');
}

/**
 * Normalize a filesystem path into a canonical case-insensitive POSIX key.
 * @param {string} targetPath
 * @returns {string}
 */
export function normPath(targetPath) {
  return toPosix(targetPath).toLowerCase();
}

/**
 * Resolve host configuration and shelf storage directories for the active environment.
 * @param {object} [options]
 * @returns {object}
 */
export function resolveEnvironment(options = {}) {
  const userHome = path.resolve(
    options.userHome || process.env.SKILL_SHELF_USER_HOME || os.homedir()
  );
  const shelfHome = path.resolve(
    options.shelfHome ||
      process.env.SKILL_SHELF_HOME ||
      path.join(userHome, '.agent-skill-shelf')
  );
  const codexHome = path.resolve(
    options.codexHome || process.env.CODEX_HOME || path.join(userHome, '.codex')
  );
  const agentsHome = path.resolve(
    options.agentsHome || path.join(userHome, '.agents')
  );
  const claudeHome = path.resolve(
    options.claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(userHome, '.claude')
  );
  const geminiConfigHome = path.resolve(
    options.geminiConfigHome || path.join(userHome, '.gemini', 'config')
  );

  const antigravityPluginsDir = path.join(geminiConfigHome, 'plugins');
  const antigravityPluginDir = path.join(antigravityPluginsDir, 'skill-shelf');
  const runtimeDir = path.join(shelfHome, 'runtime');
  const runtimeCliPath = path.join(runtimeDir, 'bin', 'skill-shelf.mjs');

  return {
    userHome,
    shelfHome,
    codexHome,
    agentsHome,
    claudeHome,
    geminiConfigHome,
    codexSkills: path.join(codexHome, 'skills'),
    agentsSkills: path.join(agentsHome, 'skills'),
    claudeSkills: path.join(claudeHome, 'skills'),
    codexConfigPath: path.join(codexHome, 'config.toml'),
    codexAgentsMdPath: path.join(codexHome, 'AGENTS.md'),
    claudeMdPath: path.join(claudeHome, 'CLAUDE.md'),
    antigravityPluginsDir,
    antigravityPluginDir,
    runtimeDir,
    runtimeCliPath,
    catalogPath: path.join(shelfHome, 'catalog.jsonl'),
    configPath: path.join(shelfHome, 'config.json'),
    backupsDir: path.join(shelfHome, 'backups'),
    syncLogPath: path.join(shelfHome, 'sync.log'),
    syncLockPath: path.join(shelfHome, 'sync.lock'),
  };
}

/**
 * Detect installed agent hosts present under the resolved user home.
 * @param {object} env
 * @returns {{ codex: boolean, antigravity: boolean, claude: boolean, agentsShared: boolean, detectedList: string[] }}
 */
export function detectHosts(env) {
  const codex = fs.existsSync(env.codexHome);
  const antigravity =
    fs.existsSync(env.geminiConfigHome) ||
    fs.existsSync(path.dirname(env.geminiConfigHome));
  const claude = fs.existsSync(env.claudeHome);
  const agentsShared = fs.existsSync(env.agentsHome);

  const detectedList = [];
  if (codex) detectedList.push('codex');
  if (antigravity) detectedList.push('antigravity');
  if (claude) detectedList.push('claude');

  return { codex, antigravity, claude, agentsShared, detectedList };
}
