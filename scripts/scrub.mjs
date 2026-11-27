#!/usr/bin/env node
/**
 * 隐私扫描（发布硬闸）：找出不该出现在分发件里的本机痕迹。
 *
 * 两类规则：
 *   P1 文件类 —— 图片、数据库、日志、备份文件、node_modules、dist 产物
 *   P2 内容类 —— 真实盘符路径、用户目录路径、用户名、IPv4、私钥、令牌样式串
 *
 * 关键设计：**不硬编码任何具体用户名或目录名**。使用者自己的名字由运行时
 * 探测（HOME/USERPROFILE）得到；额外的自定义黑名单走 --deny-file 传入。
 * 上一版的做法（把某个具体用户名拼进规则里）会让换人分发时扫描器完全失效。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, log, head, ok, bad, warn, info } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 敏感字面量用拼接构造，避免扫描器扫到自己。 */
const PII_PATTERNS = [
  { id: 'drive-path', re: /[A-Za-z]:[\\/](?:Users|Program Files|Windows|ProgramData)[\\/][^\s"'<>|]{2,}/g, desc: '真实盘符路径' },
  { id: 'user-home', re: /[\\/]Users[\\/][^\s"'<>/\\]{2,}/g, desc: '用户目录路径' },
  { id: 'posix-home', re: /\/home\/[a-z0-9._-]{2,}\//g, desc: 'Linux/macOS 家目录路径' },
  { id: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, desc: 'IPv4 地址' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, desc: '私钥块' },
  { id: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g, desc: 'Bearer 令牌' },
  { id: 'api-key-ish', re: /\b(?:sk|tp|ak)[-_][A-Za-z0-9_-]{16,}\b/g, desc: '疑似 API Key' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, desc: 'AWS Access Key' },
];

/** 回环地址不是隐私，放行。 */
const IP_EXEMPT = new Set(['127.0.0.1', '0.0.0.0', '::1']);

const BAD_FILE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.db', '.sqlite', '.sqlite3', '.log', '.bak', '.pem', '.key', '.pfx', '.p12']);
const BAD_DIR_NAMES = new Set(['node_modules', '.git', '.vscode-test', 'screenshots', 'pulled']);
const BAD_FILE_NAMES = new Set(['bili_credential.json', 'settings.json.local', 'state.json.local']);

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ kind: 'dir', name: e.name, path: full });
      walk(full, out);
    } else if (e.isFile()) {
      out.push({ kind: 'file', name: e.name, path: full });
    }
  }
  return out;
}

function scanText(text, extraDeny) {
  const hits = [];
  for (const p of PII_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = m[0];
      // 排除示例占位与文档里明确标注的示例路径
      if (/^[A-Za-z]:\\?(?:PATH|TARGET|HOST|PLACEHOLDER)\b/i.test(v)) continue;
      if (/<[^>]*>/.test(v)) continue;
      if (p.id === 'ipv4' && IP_EXEMPT.has(v)) continue;
      hits.push({ id: p.id, desc: p.desc, sample: v.slice(0, 80) });
      if (hits.length > 40) return hits;
    }
  }
  for (const d of extraDeny) {
    if (!d) continue;
    if (text.includes(d)) hits.push({ id: 'custom-deny', desc: '自定义黑名单', sample: d.slice(0, 40) });
  }
  return hits;
}

export function scrub(pkgDir = PKG_DIR, extraDeny = []) {
  const issues = [];
  const entries = walk(pkgDir);

  for (const e of entries) {
    const rel = path.relative(pkgDir, e.path);
    if (rel.startsWith('dist' + path.sep)) continue; // 打包产物本身由 pack 控制

    if (e.kind === 'dir') {
      if (BAD_DIR_NAMES.has(e.name)) issues.push({ level: 'FAIL', id: 'P1-dir', rel, note: `不应分发的目录：${e.name}` });
      continue;
    }

    const ext = path.extname(e.name).toLowerCase();
    if (BAD_FILE_EXT.has(ext)) issues.push({ level: 'FAIL', id: 'P1-file', rel, note: `不应分发的文件类型：${ext}` });
    if (BAD_FILE_NAMES.has(e.name)) issues.push({ level: 'FAIL', id: 'P1-name', rel, note: '不应分发的文件名' });

    const size = (() => {
      try {
        return fs.statSync(e.path).size;
      } catch {
        return 0;
      }
    })();
    if (size > 2 * 1024 * 1024) {
      issues.push({ level: 'WARN', id: 'P1-size', rel, note: `文件 ${(size / 1048576).toFixed(1)} MB，确认是否该进包` });
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.json' || ext === '.md' || ext === '.yml' || ext === '.yaml' || ext === '.txt') {
      let text = '';
      try {
        text = fs.readFileSync(e.path, 'utf8');
      } catch {
        continue;
      }
      const hits = scanText(text, extraDeny);
      for (const h of hits) {
        issues.push({ level: 'FAIL', id: `P2-${h.id}`, rel, note: `${h.desc}：${h.sample}` });
      }
    }
  }

  // 运行时探测到的家目录路径本身不应出现在包里
  const home = os.homedir();
  if (home && home.length > 3) {
    for (const e of entries) {
      if (e.kind !== 'file') continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt'].includes(ext)) continue;
      let text = '';
      try {
        text = fs.readFileSync(e.path, 'utf8');
      } catch {
        continue;
      }
      if (text.includes(home)) {
        issues.push({ level: 'FAIL', id: 'P2-home', rel: path.relative(pkgDir, e.path), note: '文件里出现了当前用户的家目录绝对路径' });
      }
    }
  }

  const fail = issues.filter((i) => i.level === 'FAIL');
  return { ok: fail.length === 0, issues, failCount: fail.length, warnCount: issues.length - fail.length };
}

function main() {
  const args = parseArgs();
  head('隐私扫描');

  const extraDeny = [];
  if (args['deny-file']) {
    try {
      for (const line of fs.readFileSync(String(args['deny-file']), 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) extraDeny.push(t);
      }
    } catch (e) {
      bad(`读取 --deny-file 失败：${e.message}`);
      return 1;
    }
    info(`自定义黑名单 ${extraDeny.length} 条`);
  }

  const r = scrub(PKG_DIR, extraDeny);
  for (const i of r.issues) {
    if (i.level === 'FAIL') bad(`${i.rel} — ${i.note}`);
    else warn(`${i.rel} — ${i.note}`);
  }
  if (r.ok) {
    ok(`隐私扫描通过（${r.warnCount} 条提示）`);
    return 0;
  }
  warn(`发现 ${r.failCount} 处必须处理的问题。`);
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
