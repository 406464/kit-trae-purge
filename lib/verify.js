/**
 * 断言式自检：验证「规则真的写进去了」且「内容没被改过」。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import { readRule, listSiblingRules } from './rules.js';
import { hashText } from './words.js';

/** TRAE 对全部规则的总大小上限。 */
export const TRAE_RULES_LIMIT_BYTES = 32 * 1024;

/**
 * @param {object} opts
 * @param {string} opts.traeHome
 * @param {object} opts.words loadWords() 的返回
 * @param {Array}  [opts.profiles]
 * @param {string} [opts.routeModel]
 * @returns {{ok:boolean, verdict:'PASS'|'PARTIAL'|'FAIL', summary:{pass:number,fail:number,skip:number,info:number}, layers:Array}}
 */
export function runVerify({ traeHome, words, profiles = [], routeModel = '' }) {
  const layers = [];
  const add = (id, status, title, detail, evidence = {}) =>
    layers.push({ id, status, title, detail, evidence });

  const rule = readRule(traeHome);

  // A1 装载：文件在不在，标记齐不齐
  if (!rule.exists) {
    add('A1', 'FAIL', '规则文件已安装', `未找到 ${rule.path}`, { path: rule.path });
  } else if (!rule.hasMarker && !rule.hasSentinel) {
    add('A1', 'FAIL', '规则文件已安装', '文件存在，但没有本包的标记与哨兵，可能不是本包装的', { path: rule.path });
  } else {
    add('A1', 'PASS', '规则文件已安装', `已写入 ${rule.path}`, { path: rule.path, bytes: rule.bytes });
  }

  // A2 指纹：写进去的是不是这份词库
  const expectedFp = words.hash.slice(0, 12);
  if (!rule.exists) {
    add('A2', 'FAIL', '词库指纹一致', '规则文件不存在，无法比对指纹', { expected: expectedFp });
  } else if (rule.fingerprint !== expectedFp) {
    add('A2', 'FAIL', '词库指纹一致', `指纹不符：文件=${rule.fingerprint ?? '(无)'} 期望=${expectedFp}（词库改过或文件被手改）`, {
      expected: expectedFp,
      actual: rule.fingerprint,
    });
  } else {
    add('A2', 'PASS', '词库指纹一致', `指纹 ${expectedFp} 双标记均命中`, { fingerprint: expectedFp });
  }

  // A3 正文：正文一字不差
  const expectedBodyHash = hashText(words.text);
  if (!rule.exists) {
    add('A3', 'FAIL', '正文未被改动', '规则文件不存在', {});
  } else if (rule.bodyHash !== expectedBodyHash) {
    add('A3', 'FAIL', '正文未被改动', '正文哈希与当前词库不一致（文件被手工编辑过）', {
      expected: expectedBodyHash.slice(0, 12),
      actual: (rule.bodyHash ?? '').slice(0, 12),
    });
  } else {
    add('A3', 'PASS', '正文未被改动', `正文哈希 ${expectedBodyHash.slice(0, 12)}`, {});
  }

  // A4 体积：TRAE 32KB 总上限
  const others = listSiblingRules(traeHome).filter((f) => !f.ours);
  const othersBytes = others.reduce((s, f) => s + f.bytes, 0);
  const total = othersBytes + rule.bytes;
  if (total > TRAE_RULES_LIMIT_BYTES) {
    add('A4', 'FAIL', '规则总体积在上限内', `规则总字节 ${total} 超过 TRAE 的 ${TRAE_RULES_LIMIT_BYTES} 上限（其余规则 ${othersBytes} + 本包 ${rule.bytes}）`, {
      total,
      limit: TRAE_RULES_LIMIT_BYTES,
      others: others.map((f) => ({ name: f.name, bytes: f.bytes })),
    });
  } else {
    add('A4', 'PASS', '规则总体积在上限内', `规则总字节 ${total} / ${TRAE_RULES_LIMIT_BYTES}`, { total, limit: TRAE_RULES_LIMIT_BYTES });
  }

  // A5 路由档案：只报事实，不判成败
  if (routeModel) {
    add('A5', 'INFO', '模型入口档案', `按模型名「${routeModel}」匹配档案（结果见 status 输出）`, { routeModel });
  } else {
    add('A5', 'INFO', '模型入口档案', '未指定模型名，跳过匹配', {});
  }

  const summary = { pass: 0, fail: 0, skip: 0, info: 0 };
  for (const l of layers) {
    if (l.status === 'PASS') summary.pass += 1;
    else if (l.status === 'FAIL') summary.fail += 1;
    else if (l.status === 'SKIP') summary.skip += 1;
    else summary.info += 1;
  }

  let verdict = 'FAIL';
  if (summary.fail === 0 && summary.pass >= 2) verdict = 'PASS';
  else if (summary.fail === 0) verdict = 'PARTIAL';

  return { ok: verdict === 'PASS', verdict, summary, layers, profiles };
}
