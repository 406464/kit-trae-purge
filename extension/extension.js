/**
 * TRAE 规则注入套件 —— VS Code / TRAE 扩展。
 *
 * 它只做一件事：把随包附带的行为契约写进 TRAE 的全局规则目录，
 * 让助手按指定形态输出。不改 IDE 二进制，不改其它规则，不联网。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RULE_FILE_NAME = 'rule-trae-purge-kit.md';
const MARKER_PREFIX = '<!--trae-purge-kit:';
const SENTINEL_PREFIX = '[trae-purge-kit:words ';
const STATE_DIR_NAME = '.trae-purge-kit';

let channel;

function out(line) {
  channel.appendLine(line);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').slice(0, 15);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function locateHome() {
  const cfg = vscode.workspace.getConfiguration('traePurgeKit');
  // 注意：section 已是 traePurgeKit，get 的键是属性名本身（不能再带前缀）
  const explicit = (cfg.get('traeHome') || '').trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.TRAE_HOME) candidates.push(process.env.TRAE_HOME);
  const home = os.homedir();
  candidates.push(path.join(home, '.trae-cn'), path.join(home, '.trae'));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return { home: c, found: true };
    } catch {
      /* continue */
    }
  }
  return { home: candidates[candidates.length - 1], found: false };
}

function layout(home) {
  const userRules = path.join(home, 'user_rules');
  return {
    home,
    userRules,
    rulePath: path.join(userRules, RULE_FILE_NAME),
    stateDir: path.join(home, STATE_DIR_NAME),
    statePath: path.join(home, STATE_DIR_NAME, 'state.json'),
  };
}

/**
 * 与 CLI 侧 lib/words.js 保持同一口径：读 extension/words/ 下所有 .md（排除 README*），
 * 按文件名排序拼接。只读 core.md 会让两条安装路径产出不同的规则文件与指纹。
 */
function readWords() {
  const dir = path.join(__dirname, 'words');
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => !f.toLowerCase().startsWith('readme'))
      .sort();
  } catch {
    names = [];
  }
  if (!names.length) throw new Error(`词库目录为空或缺失：${dir}`);
  const parts = [];
  for (const name of names) {
    const buf = fs.readFileSync(path.join(dir, name));
    parts.push(buf.toString('utf8').trim());
  }
  const text = parts.join('\n\n');
  const hash = sha256(Buffer.from(text, 'utf8'));
  const short = hash.slice(0, 12);
  return {
    text,
    hash,
    marker: `${MARKER_PREFIX}${short}-->`,
    sentinel: `${SENTINEL_PREFIX}${short}]`,
    bytes: Buffer.byteLength(text, 'utf8'),
    files: names,
  };
}

function renderBody(words) {
  return `${words.marker}\n${words.sentinel}\n\n${words.text}\n`;
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseBody(content) {
  const m = content.match(/<!--trae-purge-kit:([0-9a-f]{4,64})-->/);
  const s = content.match(/\[trae-purge-kit:words ([0-9a-f]{4,64})\]/);
  let body = content;
  if (m) body = body.replace(m[0], '');
  if (s) body = body.replace(s[0], '');
  body = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return {
    fingerprint: (m?.[1] ?? s?.[1] ?? null),
    bodyHash: sha256(Buffer.from(body, 'utf8')),
    hasMarker: Boolean(m),
    hasSentinel: Boolean(s),
  };
}

function listBackups(lay) {
  try {
    return fs
      .readdirSync(lay.userRules)
      .filter((f) => f.startsWith(`${RULE_FILE_NAME}.bak-`))
      .sort();
  } catch {
    return [];
  }
}

function readState(lay) {
  try {
    return JSON.parse(fs.readFileSync(lay.statePath, 'utf8'));
  } catch {
    return null;
  }
}

// 备份名必须唯一：同一秒内两次安装撞进同一个 .bak，后一次会覆盖前一次
// （前一次可能正是用户的原件），等于丢数据。
function uniqueBackupPath(lay) {
  const base = `${lay.rulePath}.bak-${stamp()}`;
  let cand = base;
  let n = 1;
  while (fs.existsSync(cand)) {
    cand = `${base}-${String(n).padStart(2, '0')}`;
    n += 1;
  }
  return cand;
}

// 不带本包标记的备份 = 用户自己的内容。状态丢失时只认这一类。
function foreignBackups(lay) {
  return listBackups(lay)
    .map((f) => path.join(lay.userRules, f))
    .filter((p) => {
      const t = readIfExists(p);
      return t !== null && !t.includes('trae-purge-kit');
    });
}

function install(words) {
  const { home, found } = locateHome();
  const lay = layout(home);
  if (!found) {
    const msg = `没找到 TRAE 配置目录（探测路径：${home}）。请先启动一次 TRAE，或在设置里填 traePurgeKit.traeHome。`;
    vscode.window.showWarningMessage(msg);
    out(`✗ ${msg}`);
    return;
  }
  try {
    fs.mkdirSync(lay.userRules, { recursive: true });
  } catch (e) {
    vscode.window.showErrorMessage(`创建规则目录失败：${e.message}`);
    out(`✗ 创建规则目录失败：${e.message}`);
    return;
  }

  const body = renderBody(words);
  const prev = readIfExists(lay.rulePath);
  if (prev === body) {
    vscode.window.showInformationMessage('TRAE 规则：规则已是最新，无需改动。');
    out('· 规则已是最新');
    return;
  }

  // 先记下「首次安装之前这里有没有文件」，卸载据此决定删除还是还原。
  const prevState = readState(lay);
  let preExisted = prevState && Object.prototype.hasOwnProperty.call(prevState, 'preExisted')
    ? prevState.preExisted
    : prev !== null && !prev.includes('trae-purge-kit');
  let originalFile = prevState?.originalFile ?? null;
  if (!prevState || !Object.prototype.hasOwnProperty.call(prevState, 'preExisted')) {
    if (preExisted) {
      try {
        fs.mkdirSync(lay.stateDir, { recursive: true });
        originalFile = path.join(lay.stateDir, 'original-rule.md');
        fs.writeFileSync(originalFile, prev, 'utf8');
      } catch (e) {
        preExisted = false;
        originalFile = null;
        out(`! 原始快照失败（卸载将直接删除）：${e.message}`);
      }
    }
  }

  let backup = null;
  if (prev !== null) {
    backup = uniqueBackupPath(lay);
    try {
      fs.copyFileSync(lay.rulePath, backup);
      out(`· 旧规则已备份：${backup}`);
    } catch (e) {
      out(`! 备份失败（继续写入）：${e.message}`);
      backup = null;
    }
  }

  try {
    fs.writeFileSync(lay.rulePath, body, 'utf8');
  } catch (e) {
    vscode.window.showErrorMessage(`写入规则失败：${e.message}`);
    out(`✗ 写入规则失败：${e.message}`);
    return;
  }

  try {
    fs.mkdirSync(lay.stateDir, { recursive: true });
    fs.writeFileSync(
      lay.statePath,
      JSON.stringify(
        {
          version: 1,
          installedAt: new Date().toISOString(),
          ruleFile: RULE_FILE_NAME,
          rulePath: lay.rulePath,
          wordsHash: words.hash,
          fingerprint: words.hash.slice(0, 12),
          bytes: Buffer.byteLength(body, 'utf8'),
          preExisted,
          originalFile,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    out(`! 状态文件写入失败（不影响规则）：${e.message}`);
  }

  out(`✓ 已写入 ${lay.rulePath}`);
  vscode.window.showInformationMessage('TRAE 规则：规则已安装。请完全重启 TRAE 并开新对话。');
}

function uninstall() {
  const { home } = locateHome();
  const lay = layout(home);
  if (readIfExists(lay.rulePath) === null) {
    vscode.window.showInformationMessage('TRAE 规则：未安装，无需卸载。');
    out('· 未安装');
    return;
  }
  const st = readState(lay);
  const stateUnusable = !st || !Object.prototype.hasOwnProperty.call(st, 'preExisted');
  const original = st?.preExisted === true && st.originalFile && fs.existsSync(st.originalFile) ? st.originalFile : null;
  const backups = listBackups(lay);
  const foreign = stateUnusable ? foreignBackups(lay) : [];
  const fallback = stateUnusable && foreign.length ? foreign[foreign.length - 1] : null;
  try {
    if (original) {
      fs.copyFileSync(original, lay.rulePath);
      out(`✓ 已还原用户原始文件：${original}`);
    } else if (fallback) {
      fs.copyFileSync(fallback, lay.rulePath);
      out(`✓ 状态缺失，已从用户原件备份还原：${fallback}`);
    } else {
      fs.rmSync(lay.rulePath, { force: true });
      out('✓ 已删除本包写入的规则文件');
    }
    // 只有能证明备份都是我们自己的时候才清理；判不准就留着，宁可多几个 .bak
    if (!stateUnusable) {
      for (const b of backups) fs.rmSync(path.join(lay.userRules, b), { force: true });
      if (backups.length) out(`· 已清理本包备份 ${backups.length} 个`);
    } else if (backups.length) {
      out(`· 状态缺失，${backups.length} 个备份全部保留（不删）`);
    }
    if (original) fs.rmSync(original, { force: true });
    fs.rmSync(lay.statePath, { force: true });
    if (!stateUnusable) fs.rmSync(lay.stateDir, { recursive: true, force: true });
  } catch (e) {
    vscode.window.showErrorMessage(`回滚失败：${e.message}`);
    out(`✗ 回滚失败：${e.message}`);
    return;
  }
  vscode.window.showInformationMessage('TRAE 规则：已回滚。完全重启 TRAE 后生效。');
}

function status(words) {
  const { home, found } = locateHome();
  const lay = layout(home);
  out(`配置根：${home}${found ? '' : '（未找到，TRAE 可能还没启动过）'}`);
  out(`规则文件：${lay.rulePath}`);
  const content = readIfExists(lay.rulePath);
  if (content === null) {
    out('状态：未安装');
    vscode.window.showInformationMessage('TRAE 规则：尚未安装。');
    return;
  }
  const p = parseBody(content);
  const expected = words.hash.slice(0, 12);
  out(`状态：已安装（${Buffer.byteLength(content, 'utf8')} 字节）`);
  out(`指纹：${p.fingerprint ?? '(无)'}（期望 ${expected}）`);
  out(`标记：${p.hasMarker ? '有' : '无'} / 哨兵：${p.hasSentinel ? '有' : '无'}`);
  out(`正文一致：${p.bodyHash === words.hash ? '是' : '否'}`);
  out(`备份数量：${listBackups(lay).length}`);
  out('');
  out('下一步：完全退出 TRAE（含托盘与后台进程）→ 重开 → 开新对话。');
  out('若 TRAE 云端仍报 979/983：那是服务端内容安全，规则改不动它。');
  out('请在「设置 > 模型管理」添加一个 OpenAI 兼容的自定义模型，并把聊天切到它。');
}

function verify(words) {
  const { home } = locateHome();
  const lay = layout(home);
  const content = readIfExists(lay.rulePath);
  const checks = [];
  if (content === null) {
    checks.push(['规则文件已安装', false, '文件不存在']);
  } else {
    const p = parseBody(content);
    checks.push(['规则文件已安装', true, lay.rulePath]);
    checks.push(['双标记齐全', p.hasMarker && p.hasSentinel, `标记=${p.hasMarker} 哨兵=${p.hasSentinel}`]);
    checks.push(['指纹一致', p.fingerprint === words.hash.slice(0, 12), `文件=${p.fingerprint ?? '(无)'} 期望=${words.hash.slice(0, 12)}`]);
    checks.push(['正文未被改动', p.bodyHash === words.hash, p.bodyHash === words.hash ? '一致' : '被改过']);
  }
  out('自检结果：');
  let fail = 0;
  for (const [name, pass, detail] of checks) {
    out(`  ${pass ? '✓' : '✗'} ${name}：${detail}`);
    if (!pass) fail += 1;
  }
  out('');
  if (fail) {
    out('未通过：跑「TRAE 规则：安装全局规则」重新安装。');
    vscode.window.showWarningMessage(`TRAE 规则注入自检：${fail} 项未通过。`);
  } else {
    out('全部通过。');
    vscode.window.showInformationMessage('TRAE 规则注入自检通过。');
  }
}

function activate(context) {
  channel = vscode.window.createOutputChannel('TRAE 规则注入套件');
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand('trae-purge-kit.install', () => {
      try {
        install(readWords());
      } catch (e) {
        vscode.window.showErrorMessage(`安装出错：${e.message}`);
        out(`✗ ${e.message}`);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('trae-purge-kit.uninstall', () => {
      try {
        uninstall();
      } catch (e) {
        vscode.window.showErrorMessage(`卸载出错：${e.message}`);
        out(`✗ ${e.message}`);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('trae-purge-kit.status', () => {
      try {
        status(readWords());
        channel.show(true);
      } catch (e) {
        out(`✗ ${e.message}`);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('trae-purge-kit.verify', () => {
      try {
        verify(readWords());
        channel.show(true);
      } catch (e) {
        out(`✗ ${e.message}`);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('trae-purge-kit.openRules', async () => {
      const { home } = locateHome();
      const lay = layout(home);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(lay.rulePath));
      await vscode.window.showTextDocument(doc);
    }),
  );

  const cfg = vscode.workspace.getConfiguration('traePurgeKit');
  if (cfg.get('enable')) {
    // 只提示，不自动写盘——自动写用户目录是不可逆动作，不该悄悄做。
    vscode.window
      .showInformationMessage('TRAE 规则注入套件已就绪。命令面板里用「TRAE 规则：安装全局规则」。', '安装')
      .then((choice) => {
        if (choice === '安装') vscode.commands.executeCommand('trae-purge-kit.install');
      });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
