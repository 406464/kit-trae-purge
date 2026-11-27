#!/usr/bin/env node
/**
 * 署名盖章与检查。
 *
 * 规则：
 *   - 署名文本必须逐字出现在：package.json 的 author、LICENSE、NOTICE、README.md、docs/*.md
 *   - 源码文件头（lib/ scripts/ extension/）必须带 @author 署名
 *   - 旧格式（dsh + @ + 406464 拼接而成）已作废，任何地方都不许出现
 *   - 署名只能落在注释与元数据上，不许出现在会执行的正文里
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, log, head, ok, bad, warn, info } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SIGN_TEXT = '署名：406464 — 大肥鱼 @ DeepSeek Harness';
/* 旧格式用拼接构造：否则这个文件自己就会命中「旧格式残留」检查。 */
export const SIGN_LEGACY = ['dsh', '@406464'].join('');

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);
// 署名只留在法律与元数据层；README.md 与 docs/*.md 属「介绍」，不留署名
const DOC_FILES = ['NOTICE', 'LICENSE'];
const INTRO_FILES = ['README.md', ...(fs.existsSync(path.join(PKG_DIR, 'docs')) ? fs.readdirSync(path.join(PKG_DIR, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`) : [])];

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (['node_modules', '.git', 'dist', '.vscode-test'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export function attest(pkgDir = PKG_DIR) {
  const issues = [];
  const checks = [];

  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };

  // 1. package.json author
  const pkgFile = path.join(pkgDir, 'package.json');
  const pkgText = read(pkgFile);
  if (pkgText === null) {
    issues.push('缺 package.json');
  } else {
    try {
      const pkg = JSON.parse(pkgText);
      if (pkg.author !== SIGN_TEXT) {
        issues.push(`package.json 的 author 不是权威署名原文（当前：${JSON.stringify(pkg.author)}）`);
      } else {
        checks.push('package.json author');
      }
    } catch (e) {
      issues.push(`package.json 解析失败：${e.message}`);
    }
  }

  // 2. 文档署名
  for (const f of DOC_FILES) {
    const t = read(path.join(pkgDir, f));
    if (t === null) {
      issues.push(`缺 ${f}`);
      continue;
    }
    if (!t.includes(SIGN_TEXT)) issues.push(`${f} 里没有权威署名`);
    else checks.push(f);
  }

  // 3. 反向断言：介绍层（README.md / docs/*.md / package.json description）出现署名 = 违规
  for (const rel of INTRO_FILES) {
    const t = read(path.join(pkgDir, rel));
    if (t === null) continue;
    if (t.includes(SIGN_TEXT)) issues.push(`${rel} 里出现了署名：介绍不留署名（署名只留 LICENSE/NOTICE/元数据/源码头）`);
  }
  {
    const t = read(path.join(pkgDir, 'package.json'));
    if (t) {
      try {
        const d = JSON.parse(t).description || '';
        if (d.includes(SIGN_TEXT)) issues.push('package.json 的 description 里带了署名：介绍不留');
      } catch { /* 上面已有解析检查 */ }
    }
  }

  // 4. 源码文件头
  const codeFiles = walk(pkgDir).filter((f) => CODE_EXT.has(path.extname(f)));
  for (const f of codeFiles) {
    const t = read(f) ?? '';
    if (!t.includes(SIGN_TEXT)) {
      issues.push(`源码文件头缺署名：${path.relative(pkgDir, f)}`);
    } else {
      checks.push(path.relative(pkgDir, f));
    }
  }

  // 5. 旧格式残留
  for (const f of walk(pkgDir)) {
    const t = read(f);
    if (t === null) continue;
    if (t.includes(SIGN_LEGACY)) {
      issues.push(`出现已作废的旧署名格式：${path.relative(pkgDir, f)}`);
    }
  }

  // 6. 署名不得进入会执行的正文（词库）
  const wordsDir = path.join(pkgDir, 'words');
  for (const f of fs.existsSync(wordsDir) ? fs.readdirSync(wordsDir) : []) {
    if (!f.endsWith('.md') || f.startsWith('README')) continue;
    const t = read(path.join(wordsDir, f)) ?? '';
    if (t.includes(SIGN_TEXT) || t.includes('406464')) {
      issues.push(`词库正文里出现了署名/标识（${f}）：署名只盖在注释与元数据上，进入模型上下文的正文不能带`);
    }
  }

  return { ok: issues.length === 0, issues, checks: checks.length };
}

function main() {
  const args = parseArgs();
  head('署名检查');
  const r = attest();
  if (r.ok) {
    ok(`署名检查通过（${r.checks} 处）`);
    return 0;
  }
  for (const i of r.issues) bad(i);
  warn(`共 ${r.issues.length} 项不合格。`);
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
