/**
 * provider 档案装载与匹配。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_STATUS = new Set(['observed', 'documented', 'unverified']);

/** glob → RegExp。只支持 * 与 ?，其余字符转义。 */
export function globToRegExp(glob) {
  let out = '';
  for (const ch of String(glob)) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * 读取 profiles/providers.json。
 * @returns {Array<object>} 档案数组；文件缺失或损坏时返回 []
 */
export function loadProfiles(pkgDir) {
  const file = path.join(pkgDir, 'profiles', 'providers.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw?.profiles) ? raw.profiles : [];
  return list.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.levers));
}

/**
 * 匹配一个「模型名或服务商名」到档案。
 * 顺序：精确等值 → glob（先过负向表）→ fallback → 无命中。
 *
 * @param {Array<object>} profiles
 * @param {{provider?:string, model?:string, name?:string}} route
 */
export function matchProfile(profiles, route) {
  const candidates = [route?.provider, route?.model, route?.name]
    .filter((v) => typeof v === 'string' && v.length);

  for (const p of profiles) {
    const exact = Array.isArray(p.matchExact) ? p.matchExact : [];
    if (exact.some((e) => candidates.includes(e))) {
      return { profile: p, how: 'exact' };
    }
  }

  for (const p of profiles) {
    const globs = Array.isArray(p.matchGlob) ? p.matchGlob : [];
    if (!globs.length) continue;
    const negs = Array.isArray(p.matchNegGlob) ? p.matchNegGlob : [];
    const negRes = negs.map(globToRegExp);
    const hit = globs
      .map(globToRegExp)
      .some((re) => candidates.some((c) => re.test(c)));
    if (!hit) continue;
    const negated = negRes.some((re) => candidates.some((c) => re.test(c)));
    if (negated) continue;
    return { profile: p, how: 'glob' };
  }

  const fallback = profiles.find((p) => p.id === 'fallback');
  if (fallback) return { profile: fallback, how: 'fallback' };
  return { profile: null, how: 'none' };
}

/**
 * 取档案的 lever 列表，附带该档案的状态标注。
 */
export function playbookFor(profile) {
  if (!profile) return [];
  return (Array.isArray(profile.levers) ? profile.levers : []).map((l) => ({
    lever: l.id,
    appliesTo: l.appliesTo ?? '',
    effect: l.effect ?? '',
    status: ALLOWED_STATUS.has(l.status) ? l.status : 'unverified',
    how: l.how ?? '',
    risk: l.risk ?? '',
  }));
}

/**
 * 自检用：档案数据是否合规（status 只允许三值，id 唯一）。
 */
export function validateProfiles(profiles) {
  const issues = [];
  const seen = new Set();
  for (const p of profiles) {
    if (seen.has(p.id)) issues.push(`档案 id 重复：${p.id}`);
    seen.add(p.id);
    for (const l of Array.isArray(p.levers) ? p.levers : []) {
      if (!ALLOWED_STATUS.has(l.status)) {
        issues.push(`档案 ${p.id} 的 lever ${l.id} 的 status=${l.status} 不在 {observed, documented, unverified} 内`);
      }
    }
  }
  return issues;
}
