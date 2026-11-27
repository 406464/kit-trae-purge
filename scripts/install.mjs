#!/usr/bin/env node
/**
 * 安装：把行为契约写进 TRAE 的全局规则目录。
 *
 * 写盘三处（都可回滚）：
 *   1) <TRAE_HOME>/user_rules/rule-trae-purge-kit.md   —— 真正起作用的那一份
 *   2) <TRAE_HOME>/user_rules/rule-trae-purge-kit.md.bak-<stamp>  —— 旧文件备份
 *   3) <TRAE_HOME>/.trae-purge-kit/state.json          —— 状态记录
 *
 * 不改 TRAE 二进制、不改其它规则、不联网。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWords } from '../lib/words.js';
import { loadProfiles } from '../lib/profiles.js';
import { findTraeHome, listTraeHomes, layoutFor } from '../lib/locate.js';
import { installRule, listSiblingRules } from '../lib/rules.js';
import { parseArgs, log, head, ok, bad, info, warn, confirm, bytesHuman, relHome } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = parseArgs();
  const dryRun = Boolean(args['dry-run']);
  const assumeYes = Boolean(args.yes);

  head('TRAE 规则注入套件 · 安装');

  const homes = args['trae-home'] ? [String(args['trae-home'])] : listTraeHomes();
  if (!homes.length) {
    const fallback = findTraeHome();
    warn(`未找到 TRAE 配置目录（候选：${fallback.candidates.join(' , ')}）`);
    warn('将按默认路径创建。若你的 TRAE 装在别处，用 --trae-home <目录> 指定。');
    homes.push(fallback.home);
  }

  const words = loadWords(PKG_DIR, args['word-pack'] ? String(args['word-pack']) : '');
  const profiles = loadProfiles(PKG_DIR);

  head('词库');
  info(`来源模式：${words.mode}，来源 ${words.sources.length} 个文件，${bytesHuman(words.bytes)}`);
  info(`指纹：${words.hash.slice(0, 12)}`);
  for (const s of words.sources) info(`  - ${s.name}（${bytesHuman(s.bytes)}）`);
  for (const w of words.warnings) warn(w);

  head('目标');
  const plans = [];
  for (const home of homes) {
    const layout = layoutFor(home);
    const exists = fs.existsSync(home);
    const siblings = exists ? listSiblingRules(home) : [];
    const others = siblings.filter((f) => !f.ours);
    info(`${relHome(layout.traeHome)}${exists ? '' : '（不存在，将创建）'}`);
    info(`  规则目录：${relHome(layout.userRules)}`);
    info(`  本包规则：${relHome(layout.rulePath)}`);
    info(`  其它规则：${others.length} 个，合计 ${bytesHuman(others.reduce((s, f) => s + f.bytes, 0))}`);
    plans.push({ home, layout });
  }

  if (dryRun) {
    head('演练（--dry-run，未写盘）');
    for (const p of plans) {
      const r = installRule({ traeHome: p.home, words, dryRun: true });
      info(`${relHome(p.layout.rulePath)} → ${r.action}（${bytesHuman(r.bytes)}）`);
      for (const w of r.warnings) warn(w);
    }
    log('\n演练结束，什么都没写。去掉 --dry-run 即可实际安装。\n');
    return 0;
  }

  head('确认');
  log(`  将向 ${plans.length} 个 TRAE 配置根写入全局规则文件。`);
  log('  旧文件会被备份为 .bak-<时间戳>，卸载时可原样恢复。');
  const proceed = await confirm('  继续？', { assumeYes });
  if (!proceed) {
    log('\n已取消，未做任何改动。\n');
    return 1;
  }

  head('执行');
  let failed = 0;
  for (const p of plans) {
    const r = installRule({ traeHome: p.home, words });
    if (r.action === 'failed') {
      bad(`${relHome(p.layout.rulePath)}：${r.warnings.join('；') || '未知错误'}`);
      failed += 1;
      continue;
    }
    if (r.action === 'already-current') {
      ok(`${relHome(p.layout.rulePath)}：已是最新，无需改动`);
    } else {
      ok(`${relHome(p.layout.rulePath)}：${r.action === 'created' ? '已创建' : '已更新'}（${bytesHuman(r.bytes)}）`);
    }
    if (r.backup) info(`  备份：${relHome(r.backup)}`);
    for (const w of r.warnings) warn(w);
  }

  head('下一步');
  log('  1) 完全退出 TRAE（含托盘与后台进程），再重新打开。');
  log('  2) 开一个新对话（旧对话的上下文不会补上规则）。');
  log('  3) 跑一次自检：node scripts/verify.mjs');
  log('  4) 若 TRAE 云端仍报 979/983 —— 那是服务端内容安全，规则改不动它；');
  log('     按 docs/BYPASS-LAYERS.md 的 L1 走：在「设置 > 模型管理」加一个');
  log('     OpenAI 兼容的自定义模型，然后把聊天切到它。');
  log('');
  log(`  已装载 ${profiles.length} 个模型入口档案；查看：node scripts/status.mjs --profiles`);
  log('');

  return failed ? 1 : 0;
}

process.exit(await main());
