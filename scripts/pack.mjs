#!/usr/bin/env node
/**
 * 打包：attest → scrub → selfcheck，三关全过才产出 zip。
 *
 * 用自带的极简 ZIP 写入器（lib/zip.mjs），不依赖外部 zip 命令，
 * 并且固定时间戳与文件顺序，同样的源码产出同样的包。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildZip, collectFiles } from '../lib/zip.mjs';
import { attest } from './attest.mjs';
import { scrub } from './scrub.mjs';
import { parseArgs, log, head, ok, bad, warn, info } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const args = parseArgs();
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const name = `${pkg.name}-${pkg.version}`;

  head('打包前检查');

  const at = attest(PKG_DIR);
  if (!at.ok) {
    for (const i of at.issues) bad(i);
    bad('署名检查未过，拒绝打包。');
    return 1;
  }
  ok(`署名检查通过（${at.checks} 处）`);

  const sc = scrub(PKG_DIR, []);
  if (!sc.ok) {
    for (const i of sc.issues.filter((x) => x.level === 'FAIL')) bad(`${i.rel} — ${i.note}`);
    bad('隐私扫描未过，拒绝打包。');
    return 1;
  }
  ok(`隐私扫描通过（${sc.warnCount} 条提示）`);

  head('自检');
  const sc2 = spawnSync(process.execPath, [path.join(PKG_DIR, 'scripts', 'selfcheck.mjs')], { encoding: 'utf8' });
  if (sc2.stdout) process.stdout.write(sc2.stdout);
  if (sc2.stderr) process.stderr.write(sc2.stderr);
  if (sc2.status !== 0) {
    bad('自检未过，拒绝打包。');
    return 1;
  }

  head('打包');
  const files = collectFiles(PKG_DIR, {
    skip: ['node_modules', '.git', 'dist', '.vscode-test', '.DS_Store'],
  });
  const filtered = files.filter((f) => !f.name.startsWith('dist/'));
  const entries = [
    { name: `${name}/`, data: Buffer.alloc(0) },
    ...filtered.map((f) => ({ name: `${name}/${f.name}`, data: f.data })),
  ];
  const zip = buildZip(entries);

  const distDir = path.join(PKG_DIR, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const out = path.join(distDir, `${name}.zip`);
  fs.writeFileSync(out, zip);

  ok(`已产出 ${out}（${(zip.length / 1024).toFixed(1)} KB，${filtered.length} 个文件）`);
  info('包内不含 dist/、node_modules/、日志、数据库、备份文件。');
  warn('给别人的时候提醒对方：先看 docs/INSTALL.md，再跑 scripts/preflight.mjs。');
  log('');
  return 0;
}

process.exit(main());
