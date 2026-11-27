/**
 * 定位 TRAE 的配置根与相关目录。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** TRAE 各发行版在用户目录下的配置根名。 */
export const TRAE_HOME_NAMES = ['.trae-cn', '.trae'];

/** 常见的 IDE 数据目录名（%APPDATA% 下的）。 */
export const DATA_FOLDER_NAMES = ['Trae CN', 'TRAE SOLO CN', 'Trae', 'TRAE'];

/** 本套件自己的状态目录名（放在 TRAE 配置根下，点开头，避免被规则扫描器捡到）。 */
export const STATE_DIR_NAME = '.trae-purge-kit';

/** 注入的全局规则文件名。 */
export const RULE_FILE_NAME = 'rule-trae-purge-kit.md';

export function resolveHome() {
  return os.homedir();
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 找到 TRAE 的配置根（通常是 ~/.trae-cn）。
 * @returns {{home:string, candidates:string[], found:boolean}}
 */
export function findTraeHome(home = resolveHome()) {
  const candidates = [];
  for (const name of TRAE_HOME_NAMES) {
    candidates.push(path.join(home, name));
  }
  // 少数环境把 TRAE_HOME 指到别处
  if (process.env.TRAE_HOME) candidates.unshift(process.env.TRAE_HOME);
  const found = candidates.find((c) => existsDir(c));
  return { home: found ?? candidates[0], candidates, found: Boolean(found) };
}

/**
 * 列出所有可能的 TRAE 配置根（多版本共存时用得上）。
 */
export function listTraeHomes(home = resolveHome()) {
  const out = [];
  for (const name of TRAE_HOME_NAMES) {
    const p = path.join(home, name);
    if (existsDir(p)) out.push(p);
  }
  return out;
}

/**
 * 计算一个配置根下的关键路径。
 */
export function layoutFor(traeHome) {
  const userRules = path.join(traeHome, 'user_rules');
  const plugins = path.join(traeHome, 'plugins');
  const stateDir = path.join(traeHome, STATE_DIR_NAME);
  const rulePath = path.join(userRules, RULE_FILE_NAME);
  const statePath = path.join(stateDir, 'state.json');
  return { traeHome, userRules, plugins, stateDir, rulePath, statePath };
}

/**
 * 尽力而为地找出 IDE 安装目录（只用于版本探测，失败不致命）。
 */
export function findAppDirs(home = resolveHome()) {
  const roots = [];
  const localApp = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (localApp) {
    roots.push(path.join(localApp, 'Programs'));
    roots.push(path.join(localApp, 'Trae CN'));
  }
  if (programFiles) roots.push(programFiles);
  if (programFilesX86) roots.push(programFilesX86);
  roots.push('/Applications');
  roots.push('/opt');

  // 很多机器把 IDE 装在某个盘根目录（Trae CN / TRAE / Trae），扫一圈盘根。
  if (process.platform === 'win32') {
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) {
      const drive = `${String.fromCharCode(c)}:\\`;
      try {
        if (fs.existsSync(drive)) roots.push(drive);
      } catch {
        /* ignore */
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/trae/i.test(e.name)) continue;
      const full = path.join(root, e.name);
      if (seen.has(full)) continue;
      seen.add(full);
      const marker = path.join(full, 'resources', 'app', 'product.json');
      if (fs.existsSync(marker)) out.push(full);
    }
  }
  return out;
}

/**
 * 读取 TRAE 的版本号（从 product.json 的 version 字段）。
 */
export function readTraeVersion(appDir) {
  try {
    const p = path.join(appDir, 'resources', 'app', 'product.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j.version ?? null;
  } catch {
    return null;
  }
}

/**
 * 探测 TRAE 当前是否配置了自定义模型。
 *
 * 说明：TRAE 把模型配置存在加密的 database.db 里，无法在运行时可靠读出，
 * 因此这里只能给出**间接信号**：是否存在用户自建的插件/技能目录、是否出现
 * 自定义模型相关配置键。返回值里的 confidence 字段必须原样呈现给使用者，
 * 不要把它说成「已确认使用自定义模型」。
 */
export function probeCustomModelSignals(traeHome) {
  const signals = [];
  const layout = layoutFor(traeHome);
  const skillConfig = path.join(traeHome, 'skill-config.json');
  if (fs.existsSync(skillConfig)) {
    try {
      const j = JSON.parse(fs.readFileSync(skillConfig, 'utf8'));
      const managed = j?.managedSkills;
      if (managed && typeof managed === 'object' && Object.keys(managed).length) {
        signals.push({ kind: 'managed-skills', detail: `managedSkills 有 ${Object.keys(managed).length} 项` });
      }
    } catch {
      signals.push({ kind: 'managed-skills', detail: 'skill-config.json 存在但解析失败' });
    }
  }
  if (fs.existsSync(layout.plugins)) {
    signals.push({ kind: 'plugins-dir', detail: '插件目录存在（与自定义模型无直接关系，仅作环境信号）' });
  }
  return {
    confidence: 'low',
    conclusion: 'TRAE 的模型配置保存在加密库中，脚本无法确认当前用的是内置云模型还是自定义模型；请以 TRAE 设置 > 模型管理 的界面为准。',
    signals,
  };
}
