#!/usr/bin/env node
/**
 * 卸载 / 回滚：把本包写的规则文件还原掉。
 *
 * 有备份就还原备份，没有备份就删掉本包自己写的那个文件。
 * 不碰用户其它规则。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTraeHomes, findTraeHome, layoutFor } from '../lib/locate.js';
import { uninstallRule, readRule, readState } from '../lib/rules.js';
import { parseArgs, log, head, ok, bad, info, warn, confirm, relHome } from '../lib/cli.mjs';

async function main() {
  const args = parseArgs();
  const dryRun = Boolean(args['dry-run']);
  const assumeYes = Boolean(args.yes);

  head('TRAE 规则注入套件 · 卸载');

  const homes = args['trae-home'] ? [String(args['trae-home'])] : listTraeHomes();
  if (!homes.length) {
    const fallback = findTraeHome();
    warn(`未找到 TRAE 配置目录（候选：${fallback.candidates.join(' , ')}）`);
    homes.push(fallback.home);
  }

  const targets = [];
  for (const home of homes) {
    const layout = layoutFor(home);
    const rule = readRule(home);
    if (!rule.exists) {
      info(`${relHome(layout.rulePath)}：未安装，跳过`);
      continue;
    }
    targets.push({ home, layout, rule });
  }

  if (!targets.length) {
    log('\n没有需要清理的安装痕迹。\n');
    return 0;
  }

  head('将执行');
  for (const t of targets) {
    const st = readState(t.home);
    const willRestore = st?.preExisted === true && st?.originalFile && fs.existsSync(st.originalFile);
    const action = willRestore ? 'restore-user-original' : 'delete-our-file';
    info(`${relHome(t.layout.rulePath)} → ${action}`);
    if (willRestore) info('  用户原本就有同名文件，卸载会把它还原回去（不删）');
    if (t.rule.backups.length) info(`  同时清理本包产生的 ${t.rule.backups.length} 个备份`);
  }
  info('本包只动自己写的那一个文件与自己的备份；同目录其它规则原样保留。');

  if (dryRun) {
    log('\n演练（--dry-run，未写盘）。\n');
    return 0;
  }

  const proceed = await confirm('  继续回滚？', { assumeYes });
  if (!proceed) {
    log('\n已取消，未做任何改动。\n');
    return 1;
  }

  head('执行');
  let failed = 0;
  for (const t of targets) {
    const r = uninstallRule({ traeHome: t.home });
    if (r.action === 'failed') {
      bad(`${relHome(t.layout.rulePath)}：${r.warnings.join('；')}`);
      failed += 1;
      continue;
    }
    ok(`${relHome(t.layout.rulePath)}：${r.action === 'restored-original' ? '已还原用户原始文件' : r.action === 'removed' ? '已删除' : r.action}`);
    if (r.restored) info(`  还原自：${relHome(r.restored)}`);
    if (r.cleanedBackups) info(`  已清理本包备份 ${r.cleanedBackups} 个`);
    for (const w of r.warnings) warn(w);
  }

  log('\n完全退出并重开 TRAE 后生效。\n');
  return failed ? 1 : 0;
}

process.exit(await main());
