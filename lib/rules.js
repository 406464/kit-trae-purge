/**
 * 规则文件的写入 / 读取 / 回滚。
 *
 * 只做三件事：写一个 md、读一个 md、恢复一个备份。不改 TRAE 二进制，
 * 不改 TRAE 其它配置，不联网。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderRuleBody, parseRuleBody, hashText } from './words.js';
import { layoutFor, RULE_FILE_NAME } from './locate.js';

export { RULE_FILE_NAME };

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').slice(0, 15);
}

export function backupPathFor(rulePath, s = stamp()) {
  // 备份名必须唯一：同一秒内两次安装若撞进同一个 .bak，后一次会把前一次
  // （可能正是用户原件的那份）覆盖掉，等于丢数据。撞名就往后加序号。
  let cand = `${rulePath}.bak-${s}`;
  let n = 1;
  while (fs.existsSync(cand)) {
    cand = `${rulePath}.bak-${s}-${String(n).padStart(2, '0')}`;
    n += 1;
  }
  return cand;
}

export function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 读状态文件（记着「首次安装之前这里有没有文件」）。 */
export function readState(traeHome) {
  const layout = layoutFor(traeHome);
  try {
    return JSON.parse(fs.readFileSync(layout.statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(traeHome, obj) {
  const layout = layoutFor(traeHome);
  try {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.statePath, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 首次安装时把「原始文件」另存一份，卸载时据此还原；原本不存在（或原本就是我们写的）则记 preExisted:false。 */
function ensureOriginalSnapshot(traeHome, prev) {
  const layout = layoutFor(traeHome);
  const state = readState(traeHome);
  if (state && Object.prototype.hasOwnProperty.call(state, 'preExisted')) return state;
  const next = state ?? {};
  // 已经带我们标记的文件 = 我们上次装的，不算用户的原始文件
  const oursAlready = prev !== null && prev.includes('trae-purge-kit');
  next.preExisted = prev !== null && !oursAlready;
  if (next.preExisted) {
    const orig = path.join(layout.stateDir, 'original-rule.md');
    try {
      fs.mkdirSync(layout.stateDir, { recursive: true });
      fs.writeFileSync(orig, prev, 'utf8');
      next.originalFile = orig;
    } catch {
      /* 快照失败：卸载时退化为删除备份 */
    }
  }
  return next;
}

/**
 * 读取已安装的规则状态。
 * @returns {{exists:boolean, path:string, bytes:number, fingerprint:string|null, bodyHash:string|null, hasMarker:boolean, hasSentinel:boolean, hasBackup:boolean, backups:string[]}}
 */
export function readRule(traeHome) {
  const layout = layoutFor(traeHome);
  const content = readIfExists(layout.rulePath);
  const dir = path.dirname(layout.rulePath);
  let backups = [];
  try {
    backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${RULE_FILE_NAME}.bak-`)).sort();
  } catch {
    backups = [];
  }
  if (content === null) {
    return {
      exists: false,
      path: layout.rulePath,
      bytes: 0,
      fingerprint: null,
      bodyHash: null,
      hasMarker: false,
      hasSentinel: false,
      hasBackup: backups.length > 0,
      backups,
    };
  }
  const parsed = parseRuleBody(content);
  return {
    exists: true,
    path: layout.rulePath,
    bytes: Buffer.byteLength(content, 'utf8'),
    fingerprint: parsed.fingerprint,
    bodyHash: parsed.bodyHash,
    hasMarker: content.includes('<!--trae-purge-kit:'),
    hasSentinel: content.includes('[trae-purge-kit:words '),
    hasBackup: backups.length > 0,
    backups,
  };
}

/**
 * 写入规则文件（幂等）。
 *
 * @param {object} opts
 * @param {string} opts.traeHome
 * @param {object} opts.words  loadWords() 的返回
 * @param {boolean} [opts.dryRun]
 * @returns {{action:string, path:string, backup:string|null, bytes:number, changed:boolean, dryRun:boolean, warnings:string[]}}
 */
export function installRule({ traeHome, words, dryRun = false }) {
  const layout = layoutFor(traeHome);
  const warnings = [];
  const body = renderRuleBody(words);
  const nextBytes = Buffer.byteLength(body, 'utf8');
  const prev = readIfExists(layout.rulePath);
  const changed = prev !== body;

  // 首次安装时先记下「这里原本有没有文件」——卸载据此决定是删除还是还原。
  const baseState = dryRun ? (readState(traeHome) ?? {}) : ensureOriginalSnapshot(traeHome, prev);

  if (!changed && !dryRun) {
    return { action: 'already-current', path: layout.rulePath, backup: null, bytes: nextBytes, changed: false, dryRun, warnings };
  }

  if (!dryRun) {
    try {
      fs.mkdirSync(layout.userRules, { recursive: true });
    } catch (e) {
      warnings.push(`无法创建规则目录：${e.message}`);
      return { action: 'failed', path: layout.rulePath, backup: null, bytes: nextBytes, changed, dryRun, warnings };
    }
  }

  let backup = null;
  if (prev !== null) {
    backup = backupPathFor(layout.rulePath);
    if (!dryRun) {
      try {
        fs.copyFileSync(layout.rulePath, backup);
      } catch (e) {
        warnings.push(`备份失败（继续写入，请自行确认原文件）：${e.message}`);
        backup = null;
      }
    }
  }

  if (!dryRun) {
    try {
      fs.writeFileSync(layout.rulePath, body, 'utf8');
    } catch (e) {
      warnings.push(`写入失败：${e.message}`);
      return { action: 'failed', path: layout.rulePath, backup, bytes: nextBytes, changed, dryRun, warnings };
    }
    const saved = writeState(traeHome, {
      ...baseState,
      version: 1,
      installedAt: new Date().toISOString(),
      ruleFile: RULE_FILE_NAME,
      rulePath: layout.rulePath,
      wordsHash: words.hash,
      fingerprint: words.hash.slice(0, 12),
      marker: words.marker,
      sentinel: words.sentinel,
      bytes: nextBytes,
      mode: words.mode,
    });
    if (!saved) warnings.push('状态文件写入失败（不影响规则本身；卸载将退化为还原最新备份）');
  }

  return {
    action: prev === null ? 'created' : 'updated',
    path: layout.rulePath,
    backup,
    bytes: nextBytes,
    changed: true,
    dryRun,
    warnings,
  };
}

/**
 * 卸载：回到「首次安装之前」的样子。
 *
 * - 原本没有这个文件 → 删掉我们写的文件 + 我们产生的所有备份
 * - 原本有（用户自己的同名文件）→ 还原那份原始快照
 *
 * 只动本包产生的文件，不碰用户其它规则。
 */
export function uninstallRule({ traeHome, dryRun = false }) {
  const layout = layoutFor(traeHome);
  const warnings = [];
  const info = readRule(traeHome);
  const state = readState(traeHome);

  if (!info.exists) {
    if (!dryRun) {
      try {
        fs.rmSync(layout.statePath, { force: true });
        if (state?.originalFile) fs.rmSync(state.originalFile, { force: true });
        fs.rmSync(layout.stateDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { action: 'not-installed', path: layout.rulePath, restored: null, removed: false, cleanedBackups: 0, dryRun, warnings };
  }

  const preExisted = state?.preExisted === true;
  const original = preExisted && state.originalFile ? state.originalFile : null;
  const backups = info.backups.map((f) => path.join(path.dirname(layout.rulePath), f));

  // 状态文件丢失时无法证明「原本有没有用户的文件」——保守处理：
  // 在备份里挑**最新的、不带我们标记的那一份**（那才是用户的原件）还原，且保留全部备份。
  // 若所有备份都带我们的标记，说明这里原本就没有用户的文件，删除才是对的。
  const stateUnusable = !state || !Object.prototype.hasOwnProperty.call(state, 'preExisted');
  const foreignBackups = stateUnusable
    ? backups.filter((b) => {
        const t = readIfExists(b);
        return t !== null && !t.includes('trae-purge-kit');
      })
    : [];
  const fallbackSource = stateUnusable && foreignBackups.length ? foreignBackups[foreignBackups.length - 1] : null;
  const allOurs = stateUnusable && !foreignBackups.length;

  if (!dryRun) {
    try {
      if (original && fs.existsSync(original)) {
        fs.copyFileSync(original, layout.rulePath);
      } else if (fallbackSource) {
        fs.copyFileSync(fallbackSource, layout.rulePath);
      } else {
        fs.rmSync(layout.rulePath, { force: true });
      }
      // 我们产生的备份：只有在能证明原本没有文件时才清掉
      if (!stateUnusable && !original) {
        for (const b of backups) fs.rmSync(b, { force: true });
      }
      if (original) fs.rmSync(original, { force: true });
      fs.rmSync(layout.statePath, { force: true });
      if (!stateUnusable) fs.rmSync(layout.stateDir, { recursive: true, force: true });
    } catch (e) {
      warnings.push(`回滚失败：${e.message}`);
      return { action: 'failed', path: layout.rulePath, restored: original ?? fallbackSource, removed: false, cleanedBackups: 0, dryRun, warnings };
    }
  }

  if (stateUnusable && fallbackSource) {
    warnings.push('状态文件缺失：已从「不带本包标记的最新备份」还原用户原件，全部备份保留未删');
  }
  if (stateUnusable && allOurs) {
    warnings.push('状态文件缺失，但全部备份都带本包标记 → 判定此处原本没有用户文件，已删除规则文件并保留备份');
  }

  return {
    action: original ? 'restored-original' : fallbackSource ? 'restored-backup' : 'removed',
    path: layout.rulePath,
    restored: original ?? fallbackSource,
    removed: !original && !fallbackSource,
    cleanedBackups: !stateUnusable && !original ? backups.length : 0,
    dryRun,
    warnings,
  };
}

/**
 * 列出规则目录里其它文件（只报名字与大小，不读内容）。
 * ours=true 涵盖本包写的规则文件与本包产生的备份：它们都不该算进「用户的其它规则」，
 * 否则体积判定会把自己留下的备份算成用户的规则，虚报超限。
 */
export function listSiblingRules(traeHome) {
  const layout = layoutFor(traeHome);
  try {
    return fs
      .readdirSync(layout.userRules, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = path.join(layout.userRules, e.name);
        let size = 0;
        try {
          size = fs.statSync(p).size;
        } catch {
          /* ignore */
        }
        const ours = e.name === RULE_FILE_NAME || e.name.startsWith(`${RULE_FILE_NAME}.bak-`);
        return { name: e.name, bytes: size, ours, isBackup: e.name.startsWith(`${RULE_FILE_NAME}.bak-`) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * 计算规则目录里所有 md 的字节总和——TRAE 的 32KB 上限是按「全部规则」算的。
 */
export function totalRulesBytes(traeHome) {
  return listSiblingRules(traeHome).reduce((sum, f) => sum + (f.ours ? 0 : f.bytes), 0);
}

export { hashText };
