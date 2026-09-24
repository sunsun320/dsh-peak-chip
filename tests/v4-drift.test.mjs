/**
 * v4 的"容易悄悄坏掉"检查：双副本一致性、年份相关常量、账本说明。
 *
 * 这三类都有过真实事故：
 *   · PRICES 在宿主和客户端各存一份（宿主算钱、客户端渲染），改一处忘一处
 *   · HOLIDAY_RANGES 硬编码年度节假日，跨年不更新会把峰谷算反
 *   · 账本 README 是给"将来在别的设备上做拟合的人"看的，规则变了它必须跟着变
 *
 * 用法：node v4-drift.test.mjs
 */
import { readFileSync } from 'node:fs';

const HOST = new URL('../lib/index.js', import.meta.url);
const CLIENT = new URL('../lib/client.js', import.meta.url);
/* 账本文件已删（v4.1.0），五条口径规则搬进了算法说明 —— 盯它 */
const DOC = new URL('../计费算法说明.md', import.meta.url);
const host = readFileSync(HOST, 'utf8');
const client = readFileSync(CLIENT, 'utf8');
const docTxt = readFileSync(DOC, 'utf8');

const problems = [];
const check = (label, ok) => { if (!ok) problems.push(label); };

/* ① 价目双副本：只比数字，不比写法（客户端那份多了个 name 字段、用的是 var） */
function pricesOf(src) {
  const table = {};
  const re = /\{\s*(?:name:\s*'[^']*',\s*)?match:\s*'([^']+)',\s*hit:\s*\[([^\]]+)\],\s*miss:\s*\[([^\]]+)\],\s*out:\s*\[([^\]]+)\]\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const nums = (s) => s.split(',').map((x) => Number(x.trim()));
    table[m[1]] = { hit: nums(m[2]), miss: nums(m[3]), out: nums(m[4]) };
  }
  return table;
}
const hp = pricesOf(host);
const cp = pricesOf(client);
check(`宿主价目表解析到 ${Object.keys(hp).length} 条（期望 2）`, Object.keys(hp).length === 2);
check('客户端价目表与宿主逐项一致：' + JSON.stringify(hp) + ' vs ' + JSON.stringify(cp),
  JSON.stringify(hp) === JSON.stringify(cp));

/* ①b 误差失效阈值也是双副本：宿主负责当日锁存，客户端只在拿不到 errorLatched 时兜底。
      两个数必须一致，否则「显示失效」和「真的锁存」会错开。 */
function latchOf(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*(\\d+(?:\\.\\d+)?)'));
  return m ? Number(m[1]) : NaN;
}
const hostLatch = latchOf(host, 'ALERT_RED');
const clientLatch = latchOf(client, 'ALERT_RED_UI');
check(`红色告警阈值双副本一致（宿主 ${hostLatch} / 客户端 ${clientLatch}）`,
  Number.isFinite(hostLatch) && hostLatch === clientLatch);

/* ② 峰谷规则：官方口径是"周一至周五（非法定节假日）9-12、14-18 为高峰，其余空闲" */
check('宿主含高峰时段常量', /PEAK_WINDOWS\s*=\s*\[\[9 \* 60, 12 \* 60\], \[14 \* 60, 18 \* 60\]\]/.test(host));

/* ③ 节假日表要覆盖"今天所在年 + 次年" —— 跨年是必须人工更新的硬点 */
const years = new Set((host.match(/'(20\d\d)-\d\d-\d\d'/g) || []).map((s) => s.slice(1, 5)));
const thisYear = String(new Date().getFullYear());
if (!years.has(thisYear)) problems.push(`HOLIDAY_RANGES 没有覆盖 ${thisYear} 年`);
else console.log(`  · 节假日表覆盖 ${[...years].sort().join(' / ')}（含今年 ${thisYear}）`);
if (!years.has(String(Number(thisYear) + 1))) {
  console.log(`  · 提示：还没有 ${Number(thisYear) + 1} 年的节假日数据，跨年前要补`);
}

/* ④ 账本 README 必须写清 v4 的三条关键规则 */
for (const [label, needle] of [
  ['充值识别不假设档位', '没有档位表'],
  ['写明中位数滤波', '中位数滤波'],
  ['写明千万别用 round(R)', 'round(R)'],
  ['写明 away 窗口要排除', '排除出拟合'],
  ['写明余额结算有延迟', '逐窗对不上'],
]) {
  check(`算法说明写明「${label}」`, docTxt.includes(needle));
}

/* ⑤ 路径不许写死（注释里解释"为什么不写死"可以，代码里不行）——
   油纸包会被搬到别的 DSH 上：Windows 那边 DSH_HOME 不是 /root/.dsh，
   所以一会儿客户端提示词里的手册路径必须由宿主用 import.meta.url 算出来。 */
for (const [label, src] of [['宿主', host], ['客户端', client]]) {
  const code = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(`${label}代码里不该出现硬编码 /root/.dsh`, !code.includes('/root/.dsh'));
}

/* ⑥ 已删除的 v3 概念不该在代码里复活（注释里提历史可以，代码里不行） */
const codeOnly = host.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const gone of ['TOPUP_TIERS', 'TOPUP_EPS', 'tierAtLeast', 'baseBalance', 'baseDayKey']) {
  check(`代码里不该再有 ${gone}`, !codeOnly.includes(gone));
}

console.log('=== v4 一致性检查 ===');
if (problems.length === 0) console.log('✓ 全部通过');
else {
  console.log('✗ 失败：');
  for (const p of problems) console.log('   · ' + p);
  process.exitCode = 1;
}
