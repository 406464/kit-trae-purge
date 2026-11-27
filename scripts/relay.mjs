#!/usr/bin/env node
/**
 * relay：放在 TRAE 与你自己的模型服务之间的本地中转。
 *
 * 它干三件事：
 *   L2  上游是 Gemini 系时，往请求体里注入宽松的 safetySettings
 *   L3  上游返回内容过滤类错误时，按「形式阶梯」改写最后一条 user 消息
 *   L4  改写后自动重投（默认最多 2 次，带退避）
 *
 * 流式纪律：
 *   上游返回 2xx 时**边收边发**（不缓冲），保住 TRAE 的增量输出体验。
 *   上游返回非 2xx 时才整体读入 body——过滤类错误通常走这条路（400 + error.code），
 *   这时才有重投的机会。
 *   代价：若上游用 200 + finish_reason=content_filter 的形式表达拒绝，
 *   本层无法在流中途重投（响应已开始下发）。这种情况原样透传，交给 TRAE 显示。
 *
 * 隐私纪律：
 *   - 只监听 127.0.0.1，不对外暴露
 *   - API Key 只从环境变量读，不写文件、不打日志、不回显
 *   - 默认**不记录**请求体与响应体；日志只有状态码、请求指纹、阶梯档位
 *   - 需要抓包排查时显式加 --log-bodies（会提示你日志里会出现明文）
 *
 * 用法：
 *   OPENAI_API_KEY=sk-xxx node scripts/relay.mjs --upstream https://api.example.com/v1
 *   然后在 TRAE「模型管理 → 自定义模型」里把服务地址填成 http://127.0.0.1:8788
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import { parseArgs, log, head, ok, warn, info } from '../lib/cli.mjs';
import {
  injectSafetySettings,
  applyLadder,
  looksBlocked,
  requestFingerprint,
} from '../lib/relay-core.mjs';

const args = parseArgs();

const PORT = Number(args.port ?? 8788);
const HOST = '127.0.0.1';
const UPSTREAM = String(args.upstream ?? process.env.UPSTREAM_BASE_URL ?? '');
const KEY_ENV = String(args['key-env'] ?? 'OPENAI_API_KEY');
const MAX_RETRIES = Number(args['max-retries'] ?? 2);
const LOG_BODIES = Boolean(args['log-bodies']);
const INJECT_SAFETY = args.safety !== 'off';
const STRIP_PREFIX = String(args['strip-prefix'] ?? '');
const UPSTREAM_KEY = process.env[KEY_ENV] ?? '';
/** 非 2xx 响应体的读取上限，防止上游返回超大错误体把内存吃满。 */
const MAX_ERROR_BODY = 1024 * 1024;

const stats = { requests: 0, blocked: 0, retries: 0, rewritten: 0, errors: 0, streamed: 0 };

function openUpstream(pathname, method, headers, bodyBuf) {
  let target;
  try {
    target = new URL(pathname, UPSTREAM.endsWith('/') ? UPSTREAM : `${UPSTREAM}/`);
  } catch {
    return Promise.resolve({ res: null, error: new Error('bad upstream url') });
  }
  if (STRIP_PREFIX && target.pathname.startsWith(STRIP_PREFIX)) {
    target.pathname = target.pathname.slice(STRIP_PREFIX.length) || '/';
  }
  const outHeaders = { ...headers };
  delete outHeaders.host;
  delete outHeaders['content-length'];
  delete outHeaders.connection;
  // 主动要求不压缩：否则上游回 gzip 的错误体无法判定是否过滤类，重投会静默失效
  outHeaders['accept-encoding'] = 'identity';
  if (UPSTREAM_KEY) outHeaders.authorization = `Bearer ${UPSTREAM_KEY}`;
  if (bodyBuf?.length) outHeaders['content-length'] = String(bodyBuf.length);

  const mod = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: outHeaders,
      },
      (res) => done({ res, error: null }),
    );
    req.on('error', (e) => done({ res: null, error: e }));
    if (bodyBuf?.length) req.write(bodyBuf);
    req.end();
  });
}

/** 整体读入一个响应（仅用于非 2xx）。 */
function readBody(res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size <= MAX_ERROR_BODY) chunks.push(c);
      else res.destroy();
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('close', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * 只用于**判定**：上游无视我们的 identity 请求、仍然回压缩体时，
 * 解开一份来看是不是过滤信号。转发时仍按原字节 + 原头发出，不动 body。
 */
function decodeForInspection(buf, encoding) {
  const enc = String(encoding ?? '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  } catch {
    return '';
  }
  return buf.toString('utf8');
}

/**
 * 转发响应头。body 字节我们没动过，所以 content-encoding 必须原样保留——
 * 剥掉头却把压缩字节交出去，客户端会当明文渲染成乱码。
 * 只重算长度与分块方式。
 */
function passHeaders(headers) {
  const out = { ...headers };
  delete out['content-length'];
  delete out['transfer-encoding'];
  return out;
}

function send(res, status, headers, body) {
  res.writeHead(status, passHeaders(headers));
  res.end(body);
}

/** 2xx 响应：边收边发。 */
function pipeThrough(res, upstreamRes) {
  res.writeHead(upstreamRes.statusCode ?? 200, passHeaders(upstreamRes.headers));
  upstreamRes.pipe(res);
  upstreamRes.on('error', () => res.end());
  stats.streamed += 1;
}

function logLine(o) {
  log(JSON.stringify({ t: new Date().toISOString(), ...o }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/__health') {
    send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, upstream: UPSTREAM ? 'set' : 'missing', stats }, null, 2));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);

  stats.requests += 1;

  let body = null;
  if (raw.length) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = null;
    }
  }

  let level = 0;
  const baseBody = body ? injectSafetySettings(body, url.pathname) : null;
  // 每一档都从**同一份原文**重写，不在上一档的产物上再包一层（否则前缀逐层叠加）
  const renderBody = () => {
    if (!baseBody) return raw;
    const clone = structuredClone(baseBody);
    return Buffer.from(JSON.stringify(level > 0 ? applyLadder(clone, level) : clone), 'utf8');
  };
  let outBody = renderBody();
  const fp = requestFingerprint(body ?? raw);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const { res: upstreamRes, error } = await openUpstream(url.pathname, req.method ?? 'POST', req.headers, outBody);

    if (!upstreamRes) {
      stats.errors += 1;
      logLine({ attempt, status: 0, blocked: false, level, fp, error: error?.message ?? 'upstream error' });
      if (attempt >= MAX_RETRIES) {
        send(res, 502, { 'content-type': 'application/json' }, JSON.stringify({ error: { message: `upstream error: ${error?.message ?? 'unknown'}` } }));
        return;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }

    const status = upstreamRes.statusCode ?? 502;

    // 2xx：直接流式透传，不缓冲。
    if (status >= 200 && status < 300) {
      logLine({ attempt, status, blocked: false, level, fp, streamed: true });
      pipeThrough(res, upstreamRes);
      return;
    }

    // 非 2xx：整体读入，判断是不是过滤类错误（压缩体先解开只为判定，不改字节）
    const errBuf = await readBody(upstreamRes);
    const text = decodeForInspection(errBuf, upstreamRes.headers['content-encoding']);
    const blocked = looksBlocked(status, text);

    if (!blocked) {
      logLine({ attempt, status, blocked: false, level, fp });
      if (LOG_BODIES) log(JSON.stringify({ t: new Date().toISOString(), note: 'body', body: text.slice(0, 4000) }));
      send(res, status, upstreamRes.headers, errBuf);
      return;
    }

    stats.blocked += 1;
    logLine({ attempt, status, blocked: true, level, fp });

    if (attempt >= MAX_RETRIES) {
      warn(`上游仍在过滤（已重试 ${attempt} 次，阶梯档位到 ${level}）。放弃绕过，把上游响应原样返回给 TRAE。`);
      send(res, status, upstreamRes.headers, errBuf);
      return;
    }

    level += 1;
    if (baseBody) {
      outBody = renderBody();
      stats.rewritten += 1;
    }
    stats.retries += 1;
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
});

head('TRAE 规则注入套件 · relay');
if (!UPSTREAM) {
  bad('缺少上游地址。用 --upstream https://your-endpoint/v1 或设环境变量 UPSTREAM_BASE_URL。');
  process.exit(1);
}
info(`上游：${UPSTREAM}`);
info(`监听：http://${HOST}:${PORT}`);
info(`API Key：${UPSTREAM_KEY ? `从环境变量 ${KEY_ENV} 读取（不落盘、不打印）` : `未设置 ${KEY_ENV}，将原样透传调用方的 Authorization 头`}`);
info(`安全阈值注入：${INJECT_SAFETY ? '开（仅 Gemini 系且调用方未显式设置时）' : '关'}`);
info(`重投阶梯：最多 ${MAX_RETRIES} 次（仅非 2xx 的过滤类错误可重投）`);
info(`日志：${LOG_BODIES ? '记录**非 2xx** 的错误体（注意隐私）；2xx 流式响应不记录' : '只记状态码、请求指纹与阶梯档位'}`);
log('');
ok(`在 TRAE「模型管理 → 自定义模型」里把服务地址填成 http://${HOST}:${PORT}，Key 照旧填你自己的。`);

server.listen(PORT, HOST, () => {
  log('relay 已启动（Ctrl+C 停止）。\n');
});

process.on('SIGINT', () => {
  log('\nrelay 已停止。');
  server.close(() => process.exit(0));
});
