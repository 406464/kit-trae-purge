#!/usr/bin/env node
/**
 * 自检：断言「规则真写进去了」且「内容没被改过」。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWords } from '../lib/words.js';
import { loadProfiles, matchProfile, playbookFor } from '../lib/profiles.js';
import { listTraeHomes, findTraeHome } from '../lib/locate.js';
import { runVerify } from '../lib/verify.js';
import { parseArgs, log, head, ok, bad, info, warn, relHome } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const args = parseArgs();
  const json = Boolean(args.json);

  const homes = listTraeHomes();
  if (!homes.length) {
    const fallback = findTraeHome();
    warn(`未找到 TRAE 配置目录（候选：${fallback.candidates.join(' , ')}）`);
    homes.push(fallback.home);
  }

  const words = loadWords(PKG_DIR, args['word-pack'] ? String(args['word-pack']) : '');
  const profiles = loadProfiles(PKG_DIR);
  const routeModel = args.model ? String(args.model) : '';

  const results = [];
  for (const home of homes) {
    const r = runVerify({ traeHome: home, words, profiles, routeModel });
    results.push({ home, ...r });
  }

  if (json) {
    log(JSON.stringify({ results, words: { hash: words.hash, fingerprint: words.hash.slice(0, 12), bytes: words.bytes } }, null, 2));
    return results.some((r) => r.verdict === 'FAIL') ? 1 : 0;
  }

  head('TRAE 破甲套件 · 自检');
  info(`词库：${words.mode}，${words.bytes} B，指纹 ${words.hash.slice(0, 12)}`);

  let anyFail = false;
  for (const r of results) {
    head(`配置根 ${relHome(r.home)}`);
    for (const l of r.layers) {
      if (l.status === 'PASS') ok(`${l.title}：${l.detail}`);
      else if (l.status === 'FAIL') {
        bad(`${l.title}：${l.detail}`);
        anyFail = true;
      } else if (l.status === 'SKIP') info(`${l.title}：${l.detail}（跳过）`);
      else warn(`${l.title}：${l.detail}`);
    }
    info(`判定：${r.verdict}（通过 ${r.summary.pass} / 失败 ${r.summary.fail} / 信息 ${r.summary.info}）`);

    if (routeModel) {
      const m = matchProfile(profiles, { model: routeModel, provider: routeModel });
      info(`模型「${routeModel}」命中档案：${m.profile?.id ?? '(无)'}（${m.how}）`);
      for (const p of playbookFor(m.profile)) info(`  ▸ ${p.lever}［${p.status}］${p.effect}`);
    }
  }

  log('');
  if (anyFail) {
    warn('自检未通过：跑 node scripts/install.mjs 重新安装，或看 docs/INSTALL.md 的排障段。');
  } else {
    ok('自检通过。规则已就位——记得完全重启 TRAE 并开新对话。');
  }
  log('');
  return anyFail ? 1 : 0;
}

process.exit(main());
