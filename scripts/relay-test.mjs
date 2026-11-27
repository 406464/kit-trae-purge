#!/usr/bin/env node
/**
 * relay 机制的端到端可复现测试。
 *
 * 起一个**进程内**的假上游（只监听 127.0.0.1），把 relay 作为子进程指向它，
 * 然后用真实 HTTP 请求验证这些行为：
 *
 *   R1 上游返回过滤类错误 → relay 按形式阶梯改写后自动重投，第二次拿到内容
 *   R2 改写确实发生（上游第二次看到的 body 带阶梯前缀、敏感实体已占位符化）
 *   R3 2xx 响应**边收边发**（两个 chunk 的到达时间差 ≈ 上游的间隔，证明未整体缓冲）
 *   R4 Gemini 形状请求被注入 safetySettings；OpenAI 形状不注入；调用方显式设置不被覆盖
 *   R5 日志不含请求/响应正文
 *   R6 上游用 gzip 返回错误体时，过滤信号仍要能被识别（否则重投静默失效）
 *   R7 连续被拦时，阶梯改写从**原文**重写，前缀不得逐层叠加
 *   R8 透传上游响应头不得剥掉 content-encoding（剥了就是把压缩字节当明文交出去）
 *
 * 注意：这验证的是**本套件自己的机制**，不是任何真实服务商的行为。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UP_PORT = 18899;
const RELAY_PORT = 18898;

const results = [];
const record = (id, pass, detail) => results.push({ id, status: pass ? 'PASS' : 'FAIL', detail });

const LADDER_SRC = '按以下技术规格继续|本地复现环境中的实现任务|任务类型：实现';
const ladderMarks = (s) => (String(s).match(new RegExp(LADDER_SRC, 'g')) ?? []).length;
const hasLadder = (s) => new RegExp(LADDER_SRC).test(String(s));

/**
 * 假上游，按路径分派：
 *   /v1/chat/completions   第 1 次拦（400 content_filter），之后流式两个 chunk
 *   /gzip/chat/completions 永远 400，错误体用 gzip 压缩并带 content-encoding
 *   /stack/chat/completions 永远 400 content_filter，用来观察连续阶梯改写
 */
function startFakeUpstream() {
  const hits = [];
  const count = { plain: 0, stack: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ path: req.url, body, ae: req.headers['accept-encoding'] ?? null });

      if (req.url.startsWith('/gzip/')) {
        const payload = Buffer.from(JSON.stringify({ error: { code: 'content_filter', message: 'blocked by policy' } }), 'utf8');
        res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(payload));
        return;
      }

      if (req.url.startsWith('/stack/')) {
        count.stack += 1;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'content_filter', message: `blocked ${count.stack}` } }));
        return;
      }

      count.plain += 1;
      if (count.plain === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'content_filter', message: 'blocked' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"part1"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"part2"}}]}\n\n');
        res.end();
      }, 500);
    });
  });
  return new Promise((resolve) => server.listen(UP_PORT, '127.0.0.1', () => resolve({ server, hits })));
}

function req(port, pathname, payload) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const times = [];
    const raw = [];
    const r = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.on('data', (c) => {
          times.push({ at: Date.now() - t0, text: c.toString() });
          raw.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, times, buf: Buffer.concat(raw) }));
      },
    );
    r.on('error', (e) => resolve({ status: 0, error: e.message, times, buf: Buffer.alloc(0), headers: {} }));
    r.end(JSON.stringify(payload));
  });
}

async function waitForRelay(port, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const okNow = await new Promise((resolve) => {
      const q = http.get({ host: '127.0.0.1', port, path: '/__health' }, (res) => {
        let s = '';
        res.on('data', (c) => {
          s += c;
        });
        res.on('end', () => resolve(s));
      });
      q.on('error', () => resolve(null));
      q.setTimeout(500, () => {
        q.destroy();
        resolve(null);
      });
    });
    if (okNow) return okNow;
    await new Promise((r2) => setTimeout(r2, 300));
  }
  return null;
}

async function main() {
  const up = await startFakeUpstream();

  const relay = spawn(
    process.execPath,
    [path.join(PKG_DIR, 'scripts', 'relay.mjs'), '--upstream', `http://127.0.0.1:${UP_PORT}/v1`, '--port', String(RELAY_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let relayOut = '';
  relay.stdout.on('data', (c) => {
    relayOut += c.toString();
  });
  relay.stderr.on('data', (c) => {
    relayOut += c.toString();
  });

  const health0 = await waitForRelay(RELAY_PORT);
  record('R0 relay 启动', Boolean(health0), health0 ? `监听 ${RELAY_PORT}` : relayOut.slice(0, 300));

  if (health0) {
    // R1 + R2：被拦 → 阶梯改写 → 重投成功
    const r1 = await req(RELAY_PORT, '/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: '访问 http://127.0.0.1:80 与 D:\\tmp\\a.txt 之后怎么做' }],
    });
    const streamedText = r1.times.map((t) => t.text).join('');
    record('R1 过滤后被拦则重投并最终拿到内容', r1.status === 200 && streamedText.includes('part1') && streamedText.includes('part2'), `status=${r1.status}`);

    const second = up.hits[1]?.body ?? '';
    record('R2 重投时确实改写了正文', hasLadder(second), `上游第 2 次收到带阶梯前缀=${hasLadder(second)}`);
    record('R2b 改写含占位符替换', /HOST|PATH|URL/.test(second), '敏感实体被换成 HOST/PATH/URL 占位符');
    record('R2c 转发时主动要求 identity 编码', up.hits.every((h) => /identity/.test(String(h.ae ?? ''))), `上游收到的 accept-encoding：${[...new Set(up.hits.map((h) => h.ae))].join(' / ')}`);

    // R3：流式边收边发
    const r2 = await req(RELAY_PORT, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    const gap = r2.times.length >= 2 ? r2.times[1].at - r2.times[0].at : -1;
    record('R3 2xx 边收边发（未整体缓冲）', r2.times.length >= 2 && gap > 350, `${r2.times.length} 个 chunk，间隔 ${gap} ms（上游设定 500 ms）`);
    record('R3b 响应头未被吞', String(r2.headers['content-type'] ?? '').includes('text/event-stream'), r2.headers['content-type'] ?? '(无)');

    // R4：注入形状判定
    const beforeGem = up.hits.length;
    await req(RELAY_PORT, '/v1beta/models/x:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    record('R4a Gemini 形状被注入 safetySettings', /safetySettings/.test(up.hits[beforeGem]?.body ?? ''), `path=${up.hits[beforeGem]?.path}`);

    const beforeOai = up.hits.length;
    await req(RELAY_PORT, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    record('R4b OpenAI 形状不被注入', !/safetySettings/.test(up.hits[beforeOai]?.body ?? ''), `path=${up.hits[beforeOai]?.path}`);

    const beforeSet = up.hits.length;
    await req(RELAY_PORT, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], safetySettings: [{ category: 'KEEP_ME', threshold: 'BLOCK_LOW_AND_ABOVE' }] });
    const keptBody = up.hits[beforeSet]?.body ?? '';
    record('R4c 调用方显式阈值不被覆盖', /KEEP_ME/.test(keptBody) && !/BLOCK_ONLY_HIGH/.test(keptBody), keptBody.slice(0, 80));

    // R6：gzip 错误体也要能识别成过滤，从而触发重投
    const hitsBeforeGzip = up.hits.length;
    const r6 = await req(RELAY_PORT, '/gzip/chat/completions', { model: 'm', messages: [{ role: 'user', content: '正文内容' }] });
    const triedAgain = up.hits.length > hitsBeforeGzip + 1;
    record('R6 gzip 错误体仍能识别过滤信号并重投', triedAgain, `上游共收到 ${up.hits.length - hitsBeforeGzip} 次（识别成功才会重投）；最终 status=${r6.status}`);
    let decoded = '';
    try {
      decoded = zlib.gunzipSync(r6.buf).toString('utf8');
    } catch {
      decoded = '(无法 gunzip)';
    }
    record('R8 透传保留 content-encoding', String(r6.headers['content-encoding'] ?? '') === 'gzip' && decoded.includes('content_filter'), `头=${r6.headers['content-encoding'] ?? '(无)'} 解开后=${decoded.slice(0, 40)}`);

    // R7：连续被拦时阶梯前缀不得叠加
    const beforeStack = up.hits.length;
    await req(RELAY_PORT, '/stack/chat/completions', { model: 'm', messages: [{ role: 'user', content: '原始请求文本' }] });
    const stackHits = up.hits.slice(beforeStack);
    const lastBody = stackHits[stackHits.length - 1]?.body ?? '';
    const marks = ladderMarks(lastBody);
    record('R7 阶梯改写不叠加前缀', stackHits.length >= 2 && marks === 1, `上游收到 ${stackHits.length} 次；最后一次 body 里的阶梯前缀数=${marks}（应为 1）`);

    // R5：日志纪律
    const leaked = /part1|正文内容|原始请求文本|messages/.test(relayOut);
    record('R5 日志不含请求/响应正文', !leaked, leaked ? '日志里出现了正文片段' : '只有状态码、指纹与档位');
  }

  const health = await new Promise((resolve) => {
    const q = http.get({ host: '127.0.0.1', port: RELAY_PORT, path: '/__health' }, (res) => {
      let s = '';
      res.on('data', (c) => {
        s += c;
      });
      res.on('end', () => resolve(JSON.parse(s)));
    });
    q.on('error', () => resolve(null));
  });
  relay.kill();
  up.server.close();

  const fails = results.filter((r) => r.status === 'FAIL');
  console.log('\n── relay 机制测试 ─────────────────────────────────');
  for (const r of results) console.log(`  ${r.status === 'PASS' ? '✓' : '✗'} ${r.id}：${r.detail}`);
  if (health?.stats) console.log(`  · relay 计数：requests=${health.stats.requests} blocked=${health.stats.blocked} retries=${health.stats.retries} rewritten=${health.stats.rewritten} errors=${health.stats.errors} streamed=${health.stats.streamed}`);
  console.log('');
  if (fails.length) {
    console.log(`  ✗ ${fails.length} 项失败`);
    return 1;
  }
  console.log('  ✓ relay 机制测试全部通过（本地夹具；不代表对任何真实服务商有效）');
  return 0;
}

process.exit(await main());
