#!/usr/bin/env node
/**
 * 自检：在假环境里把整条链路跑一遍。
 *
 * S1 结构   —— 必需文件齐不齐
 * S2 机制   —— 词库装载 / 指纹 / 渲染 / 解析 往返一致
 * S3 数据   —— 档案 status 合法；词库六段齐；词库里没有署名
 * S4 假宿主 —— 在临时目录装 → 自检 → 卸载 → 确认清干净
 * S5 隐私   —— 复用 scrub 的规则
 * S6 relay  —— 形式阶梯与过滤判定的纯函数
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWords, renderRuleBody, parseRuleBody, hashText } from '../lib/words.js';
import { loadProfiles, matchProfile, playbookFor, validateProfiles, globToRegExp } from '../lib/profiles.js';
import { installRule, uninstallRule, readRule } from '../lib/rules.js';
import { runVerify } from '../lib/verify.js';
import { rewriteForLadder, looksBlocked, placeholderize, injectSafetySettings } from '../lib/relay-core.mjs';
import { attest } from './attest.mjs';
import { scrub } from './scrub.mjs';
import { parseArgs, log, head, ok, bad, warn, info } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function record(group, id, status, detail) {
  results.push({ group, id, status, detail });
}

const REQUIRED_FILES = [
  'package.json',
  'LICENSE',
  'NOTICE',
  'README.md',
  'words/core.md',
  'profiles/providers.json',
  'lib/words.js',
  'lib/profiles.js',
  'lib/verify.js',
  'lib/locate.js',
  'lib/rules.js',
  'lib/cli.mjs',
  'lib/zip.mjs',
  'lib/relay-core.mjs',
  'scripts/install.mjs',
  'scripts/uninstall.mjs',
  'scripts/status.mjs',
  'scripts/verify.mjs',
  'scripts/preflight.mjs',
  'scripts/relay.mjs',
  'scripts/relay-test.mjs',
  'scripts/attest.mjs',
  'scripts/scrub.mjs',
  'scripts/pack.mjs',
  'scripts/pack-vsix.mjs',
  'extension/package.json',
  'extension/extension.js',
  'docs/INSTALL.md',
  'docs/INSTALL.agent.md',
  'docs/CAPABILITY.md',
  'docs/BYPASS-LAYERS.md',
  'docs/ENTRY-GATE.md',
  'docs/NETWORK.md',
];

function main() {
  const args = parseArgs();
  const verbose = Boolean(args.verbose);

  head('TRAE 破甲套件 · 自检');

  /* S1 结构 */
  for (const f of REQUIRED_FILES) {
    const p = path.join(PKG_DIR, f);
    if (fs.existsSync(p)) record('S1', f, 'PASS', '存在');
    else record('S1', f, 'FAIL', '缺失');
  }

  /* S2 机制 */
  const words = loadWords(PKG_DIR, '');
  record('S2', 'words-loaded', words.mode === 'pack' ? 'PASS' : 'FAIL', `模式 ${words.mode}，${words.bytes} B`);
  record('S2', 'hash-stable', hashText(words.text) === words.hash ? 'PASS' : 'FAIL', words.hash.slice(0, 12));
  const rendered = renderRuleBody(words);
  const parsed = parseRuleBody(rendered);
  record('S2', 'render-parse-roundtrip', parsed.fingerprint === words.hash.slice(0, 12) ? 'PASS' : 'FAIL', `解析指纹 ${parsed.fingerprint}`);
  record('S2', 'body-roundtrip', parsed.bodyHash === words.hash ? 'PASS' : 'FAIL', '正文哈希一致');
  record('S2', 'double-marker', rendered.includes(words.marker) && rendered.includes(words.sentinel) ? 'PASS' : 'FAIL', '标记与哨兵都在');
  record('S2', 'readme-excluded', words.sources.every((s) => !s.name.toLowerCase().startsWith('readme')) ? 'PASS' : 'FAIL', `来源 ${words.sources.map((s) => s.name).join('、')}`);
  // 注入正文里不该出现：包名、标记前缀、署名编号（这些是套件自身元信息，进了上下文就是噪声）
  const metaRe = /trae-purge-kit|purge-kit|406464|<!--trae|MARKER_PREFIX|SENTINEL/;
  record('S2', 'no-meta-in-body', metaRe.test(words.text) ? 'FAIL' : 'PASS', metaRe.test(words.text) ? `正文出现套件元信息：${words.text.match(metaRe)?.[0]}` : '注入正文里没有套件自身的元信息');
  const profiles = loadProfiles(PKG_DIR);
  record('S2', 'profiles-loaded', profiles.length ? 'PASS' : 'FAIL', `${profiles.length} 个档案`);
  const m1 = matchProfile(profiles, { model: 'Doubao' });
  record('S2', 'profile-match-cloud', m1.profile?.id === 'trae-cloud' ? 'PASS' : 'FAIL', `命中 ${m1.profile?.id}（${m1.how}）`);
  const m2 = matchProfile(profiles, { model: 'my-custom-local-llama' });
  record('S2', 'profile-match-custom', m2.profile ? 'PASS' : 'FAIL', `命中 ${m2.profile?.id}（${m2.how}）`);
  const negHit = matchProfile(profiles, { model: 'doubao-custom' });
  record('S2', 'profile-negative-glob', negHit.profile?.id !== 'trae-cloud' ? 'PASS' : 'FAIL', `负向表生效，命中 ${negHit.profile?.id}`);
  record('S2', 'glob-to-regex', globToRegExp('*gemini*').test('google-gemini-3') ? 'PASS' : 'FAIL', 'glob 编译正确');
  record('S2', 'playbook-shape', playbookFor(profiles[0]).every((l) => ['observed', 'documented', 'unverified'].includes(l.status)) ? 'PASS' : 'FAIL', 'lever status 合法');

  /* S3 数据 */
  const profIssues = validateProfiles(profiles);
  record('S3', 'profile-status-valid', profIssues.length ? 'FAIL' : 'PASS', profIssues.join('；') || '全部合法');
  const coreText = fs.readFileSync(path.join(PKG_DIR, 'words', 'core.md'), 'utf8');
  const sections = ['一、工作方式', '二、措辞闸', '三、操作闸', '四、意图路由', '五、输出契约', '六、稳定性锚点'];
  const missing = sections.filter((s) => !coreText.includes(s));
  record('S3', 'core-sections', missing.length ? 'FAIL' : 'PASS', missing.length ? `缺 ${missing.join('、')}` : '六段齐');
  record('S3', 'core-no-signature', /406464/.test(coreText) ? 'FAIL' : 'PASS', '词库正文无署名');
  record('S3', 'core-size', Buffer.byteLength(coreText, 'utf8') <= 24 * 1024 ? 'PASS' : 'FAIL', `${Buffer.byteLength(coreText, 'utf8')} B`);

  /* S4 假宿主 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-purge-selftest-'));
  const fakeHome = path.join(tmp, '.trae-cn');
  fs.mkdirSync(path.join(fakeHome, 'user_rules'), { recursive: true });
  const rp = path.join(fakeHome, 'user_rules', 'rule-trae-purge-kit.md');
  try {
    const inst = installRule({ traeHome: fakeHome, words });
    record('S4', 'install', inst.action === 'created' ? 'PASS' : 'FAIL', `动作 ${inst.action}`);
    const v = runVerify({ traeHome: fakeHome, words, profiles });
    record('S4', 'verify-after-install', v.verdict === 'PASS' ? 'PASS' : 'FAIL', `判定 ${v.verdict}（通过 ${v.summary.pass} 失败 ${v.summary.fail}）`);
    // 篡改正文后必须判 FAIL（防假绿）
    fs.writeFileSync(rp, `${fs.readFileSync(rp, 'utf8')}\n悄悄加一行。\n`, 'utf8');
    const v2 = runVerify({ traeHome: fakeHome, words, profiles });
    record('S4', 'detect-tamper', v2.verdict === 'FAIL' ? 'PASS' : 'FAIL', `篡改后判定 ${v2.verdict}`);
    // 重复安装：不能再把「我们自己的旧文件」当成用户的原始文件
    const inst2 = installRule({ traeHome: fakeHome, words });
    record('S4', 'reinstall', inst2.action === 'updated' ? 'PASS' : 'FAIL', `动作 ${inst2.action}`);
    const st = JSON.parse(fs.readFileSync(path.join(fakeHome, '.trae-purge-kit', 'state.json'), 'utf8'));
    record('S4', 'pre-existed-false', st.preExisted === false ? 'PASS' : 'FAIL', `preExisted=${st.preExisted}`);
    const un = uninstallRule({ traeHome: fakeHome });
    record('S4', 'uninstall', un.action === 'removed' ? 'PASS' : 'FAIL', `动作 ${un.action}`);
    const after = readRule(fakeHome);
    record('S4', 'clean-after-uninstall', after.exists === false ? 'PASS' : 'FAIL', after.exists ? '文件仍在' : '已清干净');
    record('S4', 'no-backup-leftover', after.backups.length === 0 ? 'PASS' : 'FAIL', `残留备份 ${after.backups.length} 个`);

    // 用户原本就有同名文件时，卸载必须还原它，而不是删掉
    const fakeHome2 = path.join(tmp, '.trae-cn-2');
    fs.mkdirSync(path.join(fakeHome2, 'user_rules'), { recursive: true });
    const rp2 = path.join(fakeHome2, 'user_rules', 'rule-trae-purge-kit.md');
    fs.writeFileSync(rp2, '用户自己写的规则，不该被删。\n', 'utf8');
    installRule({ traeHome: fakeHome2, words });
    const st2 = JSON.parse(fs.readFileSync(path.join(fakeHome2, '.trae-purge-kit', 'state.json'), 'utf8'));
    record('S4', 'pre-existed-true', st2.preExisted === true ? 'PASS' : 'FAIL', `preExisted=${st2.preExisted}`);
    const un2 = uninstallRule({ traeHome: fakeHome2 });
    const back = fs.readFileSync(rp2, 'utf8');
    record('S4', 'restore-user-file', un2.action === 'restored-original' && back.includes('不该被删') ? 'PASS' : 'FAIL', `动作 ${un2.action}`);

    // 状态文件丢失时不得删掉用户内容：应还原最新备份并保留备份
    const fakeHome3 = path.join(tmp, '.trae-cn-3');
    fs.mkdirSync(path.join(fakeHome3, 'user_rules'), { recursive: true });
    const rp3 = path.join(fakeHome3, 'user_rules', 'rule-trae-purge-kit.md');
    fs.writeFileSync(rp3, '用户自己的原件内容。\n', 'utf8');
    installRule({ traeHome: fakeHome3, words });
    installRule({ traeHome: fakeHome3, words: { ...words, text: '换个词库', hash: hashText('换个词库'), hash12: '' } });
    fs.rmSync(path.join(fakeHome3, '.trae-purge-kit', 'state.json'), { force: true });
    const un3 = uninstallRule({ traeHome: fakeHome3 });
    const back3 = fs.existsSync(rp3) ? fs.readFileSync(rp3, 'utf8') : '';
    record('S4', 'state-loss-safe-rollback', un3.action === 'restored-backup' && back3.includes('用户自己的原件内容') ? 'PASS' : 'FAIL', `动作 ${un3.action}，用户内容保住=${back3.includes('用户自己的原件内容')}`);

    // 备份名不得撞车：同一秒内「安装 → 篡改 → 再安装」必须留下两份备份，
    // 且其中一份仍是用户的原件（撞名会让第二次把原件备份覆盖掉 = 丢数据）
    const fakeHome4 = path.join(tmp, '.trae-cn-4');
    fs.mkdirSync(path.join(fakeHome4, 'user_rules'), { recursive: true });
    const rp4 = path.join(fakeHome4, 'user_rules', 'rule-trae-purge-kit.md');
    fs.writeFileSync(rp4, '同一秒内的原件。\n', 'utf8');
    installRule({ traeHome: fakeHome4, words });
    fs.writeFileSync(rp4, `${fs.readFileSync(rp4, 'utf8')}\n中间被改过。\n`, 'utf8');
    installRule({ traeHome: fakeHome4, words });
    const bk4 = readRule(fakeHome4).backups;
    const foreign4 = bk4.filter((b) => !fs.readFileSync(path.join(fakeHome4, 'user_rules', b), 'utf8').includes('trae-purge-kit'));
    record('S4', 'backup-no-collision', bk4.length >= 2 && foreign4.length >= 1 ? 'PASS' : 'FAIL', `备份 ${bk4.length} 份，其中用户原件 ${foreign4.length} 份`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* S5 隐私 */
  const sc = scrub(PKG_DIR, []);
  record('S5', 'scrub', sc.ok ? 'PASS' : 'FAIL', sc.ok ? `无 FAIL（${sc.warnCount} 条提示）` : `${sc.failCount} 处 FAIL`);

  /* S6 relay 纯函数 */
  const l0 = rewriteForLadder('原始文本', 0);
  const l1 = rewriteForLadder('原始文本', 1);
  const l3 = rewriteForLadder('原始文本', 3);
  record('S6', 'ladder-distinct', l0 !== l1 && l1 !== l3 ? 'PASS' : 'FAIL', '各档产出不同');
  const ph = placeholderize('访问 127.0.0.1:8080 与 C:\\tmp\\a.txt');
  record('S6', 'placeholderize', ph.includes('HOST') && ph.includes('PATH') ? 'PASS' : 'FAIL', ph);
  const inj = injectSafetySettings({ contents: [] }, '/v1beta/models/x:generateContent');
  record('S6', 'inject-safety', Array.isArray(inj.safetySettings) ? 'PASS' : 'FAIL', 'Gemini 路径已注入');
  const inj2 = injectSafetySettings({ messages: [] }, '/v1/chat/completions');
  record('S6', 'no-inject-openai', inj2.safetySettings === undefined ? 'PASS' : 'FAIL', 'OpenAI 兼容路径不注入');
  const callerSet = { messages: [], safetySettings: [{ category: 'KEEP_ME', threshold: 'BLOCK_LOW_AND_ABOVE' }] };
  const inj3 = injectSafetySettings(callerSet, '/v1/chat/completions');
  record('S6', 'respect-caller-safety', inj3.safetySettings.length === 1 && inj3.safetySettings[0].category === 'KEEP_ME' ? 'PASS' : 'FAIL', '调用方显式设置的阈值不被覆盖');
  record('S6', 'detect-blocked', looksBlocked(400, '{"error":{"code":"content_filter"}}') ? 'PASS' : 'FAIL', '识别过滤信号');
  record('S6', 'not-blocked-normal', looksBlocked(200, '{"choices":[{"message":{"content":"ok"}}]}') ? 'FAIL' : 'PASS', '正常响应不误判');

  /* S9 扩展设置键与 manifest 一致性（防止 cfg.get 写错前缀被静默忽略） */
  try {
    const extPkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'extension', 'package.json'), 'utf8'));
    const contrib = extPkg.contributes?.configuration;
    const props = Object.keys(contrib?.properties ?? {});
    const sections = new Set(props.map((k) => k.split('.')[0]));
    const extSrc = fs.readFileSync(path.join(PKG_DIR, 'extension', 'extension.js'), 'utf8');
    const usedSections = [...extSrc.matchAll(/getConfiguration\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    record('S9', 'config-section-declared', usedSections.length && usedSections.every((s) => sections.has(s)) ? 'PASS' : 'FAIL', `getConfiguration 用了 ${usedSections.join('、') || '(无)'}；manifest 声明 ${[...sections].join('、')}`);
    const gets = [...extSrc.matchAll(/cfg\.get\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    const bad = gets.filter((g) => {
      if (props.includes(g)) return false; // 完整 id 也可
      const prefixed = [...sections].some((s) => g.startsWith(`${s}.`));
      if (prefixed) return true; // section 已给，键里不能再带前缀
      return !props.some((p) => p.endsWith(`.${g}`));
    });
    record('S9', 'config-get-keys-valid', bad.length === 0 ? 'PASS' : 'FAIL', bad.length ? `无效键：${bad.join('、')}（会被静默读成 undefined）` : `${gets.length} 个 cfg.get 键都对得上 manifest`);
  } catch (e) {
    record('S9', 'config-static-check', 'FAIL', e.message);
  }

  /* S10 status 文本输出的显示断言（曾有 bug：读错字段导致装对了也永远报「指纹不一致」） */
  {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-purge-status-'));
    const fh = path.join(tmp2, '.trae-cn');
    fs.mkdirSync(path.join(fh, 'user_rules'), { recursive: true });
    try {
      installRule({ traeHome: fh, words });
      const st = spawnSync(process.execPath, [path.join(PKG_DIR, 'scripts', 'status.mjs'), '--trae-home', fh], { encoding: 'utf8', timeout: 30000 });
      const outp = `${st.stdout ?? ''}${st.stderr ?? ''}`;
      const good = outp.includes('✓ 指纹一致') && !outp.includes('✗ 指纹不一致');
      record('S10', 'status-text-consistent', good ? 'PASS' : 'FAIL', good ? 'status 文本模式正确报告指纹一致' : `输出：${outp.split('\n').filter((l) => l.includes('指纹')).join(' | ').slice(0, 200)}`);
      // 篡改后 status 必须翻脸报不一致
      fs.appendFileSync(path.join(fh, 'user_rules', 'rule-trae-purge-kit.md'), '\n改一笔。\n', 'utf8');
      const st2 = spawnSync(process.execPath, [path.join(PKG_DIR, 'scripts', 'status.mjs'), '--trae-home', fh], { encoding: 'utf8', timeout: 30000 });
      const outp2 = `${st2.stdout ?? ''}${st2.stderr ?? ''}`;
      record('S10', 'status-detects-tamper', outp2.includes('正文被改动过') ? 'PASS' : 'FAIL', '改动后 status 应报正文不符');
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  }

  /* S11 两条安装路径的词库口径必须一致（CLI 是整目录排除 README*；扩展曾只读 core.md） */
  {
    const cliNames = words.sources.filter((s) => s.name !== '(skeleton)').map((s) => s.name).sort();
    const extSrc = fs.readFileSync(path.join(PKG_DIR, 'extension', 'extension.js'), 'utf8');
    const packSrc = fs.readFileSync(path.join(PKG_DIR, 'scripts', 'pack-vsix.mjs'), 'utf8');
    const extOk = /readdirSync\(dir\)/.test(extSrc) && /startsWith\('readme'\)/.test(extSrc) && !/words',\s*'core\.md'/.test(extSrc);
    const packOk = /startsWith\('readme'\)/.test(packSrc) && !/words',\s*'core\.md'/.test(packSrc);
    record('S11', 'ext-pack-uses-dir-filter', extOk && packOk ? 'PASS' : 'FAIL', `扩展=${extOk} 打包=${packOk}；词库文件=${cliNames.join(' , ') || '(骨架)'}`);
  }

  /* 署名 */
  const at = attest(PKG_DIR);
  record('S7', 'attest', at.ok ? 'PASS' : 'FAIL', at.ok ? `${at.checks} 处署名齐` : at.issues.join('；'));

  /* S8 relay 端到端机制测试（进程内假上游 + 子进程 relay） */
  const rt = spawnSync(process.execPath, [path.join(PKG_DIR, 'scripts', 'relay-test.mjs')], { encoding: 'utf8', timeout: 60000 });
  const rtOut = `${rt.stdout ?? ''}${rt.stderr ?? ''}`;
  const rtFails = (rtOut.match(/✗/g) ?? []).length;
  record('S8', 'relay-e2e', rt.status === 0 && rtFails === 0 ? 'PASS' : 'FAIL', rt.status === 0 ? 'relay 机制测试通过（本地夹具）' : `退出码 ${rt.status}，失败 ${rtFails} 项${rt.error ? `（${rt.error.message}）` : ''}`);

  /* 汇总 */
  head('结果');
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  let fails = 0;
  for (const [g, rs] of groups) {
    const gf = rs.filter((r) => r.status === 'FAIL');
    if (gf.length) {
      bad(`${g}：${gf.length} 项失败`);
      for (const r of gf) info(`  ✗ ${r.id} — ${r.detail}`);
      fails += gf.length;
    } else {
      ok(`${g}：${rs.length} 项通过`);
      if (verbose) for (const r of rs) info(`  · ${r.id} — ${r.detail}`);
    }
  }

  log('');
  if (fails) {
    bad(`自检未通过：${fails} 项 FAIL。`);
    return 1;
  }
  ok(`自检全部通过（${results.length} 项）。`);
  return 0;
}

process.exit(main());
