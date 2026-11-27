#!/usr/bin/env node
/**
 * 环境体检：装之前先看清机器状态。
 *
 * 只读，不写盘，不联网。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTraeHomes, findTraeHome, layoutFor, findAppDirs, readTraeVersion } from '../lib/locate.js';
import { readRule, listSiblingRules } from '../lib/rules.js';
import { parseArgs, log, head, ok, bad, warn, info } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function main() {
  const args = parseArgs();
  head('TRAE 破甲套件 · 环境体检');

  const results = [];
  const add = (level, name, detail, advice = '') => results.push({ level, name, detail, advice });

  // 1. Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) add('PASS', 'Node.js 版本', `v${process.versions.node}`);
  else add('FAIL', 'Node.js 版本', `v${process.versions.node}`, '需要 Node.js >= 18');

  // 2. 平台
  add('INFO', '平台', `${os.platform()} ${os.arch()}，用户目录 ${os.homedir()}`);

  // 3. TRAE 配置根
  const homes = listTraeHomes();
  if (homes.length) {
    for (const h of homes) add('PASS', 'TRAE 配置根', h);
  } else {
    const fb = findTraeHome();
    add('WARN', 'TRAE 配置根', `未找到，候选 ${fb.candidates.join(' , ')}`, '装 TRAE 后再装本套件，或用 --trae-home 指定');
  }

  // 4. IDE 版本
  const appDirs = findAppDirs();
  if (appDirs.length) {
    for (const d of appDirs) add('PASS', 'TRAE IDE', `${readTraeVersion(d) ?? '(版本未知)'} @ ${d}`);
  } else {
    add('INFO', 'TRAE IDE', '未在常见位置探测到（不影响使用）');
  }

  // 5. 规则目录可写（先 access 判定；不行再落一个 .tmp 探针并立刻删）
  for (const h of homes) {
    const layout = layoutFor(h);
    let writable = false;
    let detail = '目录不存在（安装时会创建）';
    try {
      fs.mkdirSync(layout.userRules, { recursive: true });
      try {
        fs.accessSync(layout.userRules, fs.constants.W_OK);
        writable = true;
        detail = layout.userRules;
      } catch (e) {
        const probe = path.join(layout.userRules, '.write-probe.tmp');
        try {
          fs.writeFileSync(probe, 'x');
          writable = true;
          detail = `${layout.userRules}（access 报不可写，实测写入成功：${e.code ?? e.message}）`;
        } catch (e2) {
          detail = `${layout.userRules}（${e2.code ?? e2.message}）`;
        } finally {
          fs.rmSync(probe, { force: true });
        }
      }
    } catch (e) {
      detail = `${layout.userRules}（${e.message}）`;
    }
    if (writable) add('PASS', '规则目录可写', detail);
    else add('FAIL', '规则目录可写', detail, '不要用管理员权限硬写用户目录；确认该路径属于当前用户');
  }

  // 6. 规则目录里已有的其它文件
  for (const h of homes) {
    const siblings = listSiblingRules(h).filter((f) => !f.ours);
    const bytes = siblings.reduce((s, f) => s + f.bytes, 0);
    if (siblings.length) {
      add('INFO', '同目录已有规则', `${siblings.length} 个，合计 ${bytes} B（本包写入后需仍 ≤ 32768 B）`);
      for (const f of siblings) info(`  · ${f.name}（${f.bytes} B）`);
    } else {
      add('INFO', '同目录已有规则', '无');
    }
  }

  // 7. 本包是否已安装
  for (const h of homes) {
    const rule = readRule(h);
    if (rule.exists) add('INFO', '本包安装状态', `已安装于 ${rule.path}`);
    else add('INFO', '本包安装状态', '未安装');
  }

  // 8. relay 端口
  const port = Number(args.port ?? 8788);
  const free = await checkPort(port);
  if (free) add('PASS', `relay 端口 ${port}`, '空闲，可用于 scripts/relay.mjs');
  else add('WARN', `relay 端口 ${port}`, '已被占用', '换一个端口：node scripts/relay.mjs --port 8790');

  // 9. 包自检
  add('INFO', '包路径', PKG_DIR);

  head('结论');
  let fail = 0;
  for (const r of results) {
    if (r.level === 'PASS') ok(`${r.name}：${r.detail}`);
    else if (r.level === 'FAIL') {
      bad(`${r.name}：${r.detail}`);
      if (r.advice) warn(`  处置：${r.advice}`);
      fail += 1;
    } else if (r.level === 'WARN') {
      warn(`${r.name}：${r.detail}`);
      if (r.advice) warn(`  处置：${r.advice}`);
    } else {
      info(`${r.name}：${r.detail}`);
    }
  }
  log('');
  if (fail) {
    warn(`${fail} 项 FAIL：先处理上面标 FAIL 的条目，再跑安装。`);
  } else {
    ok('体检通过，可以安装。');
  }
  log('');
  return fail ? 1 : 0;
}

process.exit(await main());
