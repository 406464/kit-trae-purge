#!/usr/bin/env node
/**
 * 状态总览。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWords } from '../lib/words.js';
import { loadProfiles, matchProfile, playbookFor } from '../lib/profiles.js';
import { findTraeHome, listTraeHomes, layoutFor, findAppDirs, readTraeVersion, probeCustomModelSignals } from '../lib/locate.js';
import { readRule, listSiblingRules } from '../lib/rules.js';
import { parseArgs, log, head, ok, bad, info, warn, bytesHuman, relHome } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const args = parseArgs();
  const json = Boolean(args.json);

  const homes = args['trae-home'] ? [String(args['trae-home'])] : listTraeHomes();
  const primary = homes[0] ?? findTraeHome().home;

  const words = loadWords(PKG_DIR, args['word-pack'] ? String(args['word-pack']) : '');
  const profiles = loadProfiles(PKG_DIR);

  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const report = {
    package: { name: pkg.name, version: pkg.version },
    hosts: [],
    words: {
      mode: words.mode,
      hash: words.hash,
      fingerprint: words.hash.slice(0, 12),
      bytes: words.bytes,
      sources: words.sources,
      warnings: words.warnings,
    },
    profiles: [],
  };

  if (!json) head('TRAE 破甲套件 · 状态');

  for (const home of homes) {
    const layout = layoutFor(home);
    const rule = readRule(home);
    const siblings = listSiblingRules(home);
    const others = siblings.filter((f) => !f.ours);
    const appDirs = findAppDirs();
    const versions = appDirs.map((d) => ({ dir: d, version: readTraeVersion(d) })).filter((v) => v.version);
    const probe = probeCustomModelSignals(home);

    const host = {
      traeHome: home,
      userRules: layout.userRules,
      rulePath: layout.rulePath,
      ruleExists: rule.exists,
      ruleBytes: rule.bytes,
      fingerprint: rule.fingerprint,
      fingerprintMatches: rule.fingerprint === words.hash.slice(0, 12),
      bodyMatches: rule.bodyHash === words.hash,
      hasMarker: rule.hasMarker,
      hasSentinel: rule.hasSentinel,
      backups: rule.backups,
      otherRules: others.map((f) => ({ name: f.name, bytes: f.bytes })),
      otherRulesBytes: others.reduce((s, f) => s + f.bytes, 0),
      totalRulesBytes: others.reduce((s, f) => s + f.bytes, 0) + rule.bytes,
      ideVersions: versions,
      customModelProbe: probe,
    };
    report.hosts.push(host);

    if (json) continue;

    head(`配置根 ${relHome(home)}`);
    if (versions.length) {
      for (const v of versions) info(`TRAE IDE：${v.version}（${relHome(v.dir)}）`);
    } else {
      info('TRAE IDE：未在常见位置探测到（不影响使用）');
    }
    if (rule.exists) {
      ok(`规则已安装：${relHome(layout.rulePath)}（${bytesHuman(rule.bytes)}）`);
      if (host.fingerprintMatches) ok(`指纹一致：${rule.fingerprint}`);
      else bad(`指纹不一致：文件=${rule.fingerprint ?? '(无)'} 期望=${words.hash.slice(0, 12)}`);
      if (host.bodyMatches) ok('正文与当前词库一致');
      else bad('正文被改动过：与当前词库不符（跑 node scripts/install.mjs 覆盖回去）');
      info(`标记 ${rule.hasMarker ? '有' : '无'} / 哨兵 ${rule.hasSentinel ? '有' : '无'} / 备份 ${rule.backups.length} 个`);
    } else {
      info(`规则未安装（目标：${relHome(layout.rulePath)}）`);
    }
    info(`其它规则 ${others.length} 个，合计 ${bytesHuman(host.otherRulesBytes)}；本包写入后规则总量 ${bytesHuman(host.totalRulesBytes)} / 32768 B`);
    for (const f of others) info(`  · ${f.name}（${bytesHuman(f.bytes)}）`);
    warn(`自定义模型判定：${probe.conclusion}`);
  }

  if (args.profiles || args.match) {
    if (!json) head('模型入口档案');
    if (args.match) {
      const route = { model: String(args.match), provider: String(args.match) };
      const m = matchProfile(profiles, route);
      report.match = { route, profileId: m.profile?.id ?? null, how: m.how };
      if (!json) {
        info(`输入：${route.model}`);
        info(`命中档案：${m.profile?.id ?? '(无)'}（方式 ${m.how}）`);
        for (const p of playbookFor(m.profile)) {
          info(`  ▸ ${p.lever}［${p.status}］${p.effect}`);
          info(`    做法：${p.how}`);
          if (p.risk) warn(`    代价：${p.risk}`);
        }
      }
    } else {
      report.profiles = profiles.map((p) => ({
        id: p.id,
        family: p.family,
        displayName: p.displayName,
        levers: playbookFor(p).map((l) => ({ id: l.lever, status: l.status })),
      }));
      if (!json) {
        for (const p of profiles) {
          info(`${p.id}（${p.displayName ?? ''}）［${p.family}］`);
          for (const l of playbookFor(p)) info(`  ▸ ${l.lever}［${l.status}］${l.effect}`);
        }
      }
    }
  }

  if (json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log('');
  }
  return 0;
}

process.exit(main());
