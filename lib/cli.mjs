/**
 * 命令行小工具：参数解析、日志、确认。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import readline from 'node:readline';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i += 1;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function log(...args) {
  console.log(...args);
}

export function warn(...args) {
  console.warn(...args);
}

export function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

export function bad(msg) {
  console.log(`  ✗ ${msg}`);
}

export function info(msg) {
  console.log(`  · ${msg}`);
}

export function head(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

/**
 * 交互确认。非 TTY 时直接拒绝，调用方应要求 --yes。
 */
export async function confirm(question, { assumeYes = false } = {}) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    console.error('\n当前不是交互式终端。请加 --yes 明确确认后再执行写盘操作。');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

export function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function relHome(p) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
