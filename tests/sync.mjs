/* 防漂移：宿主和客户端各存了一份价目表/峰谷规则，两份必须完全一致。
   改了一处忘了另一处，记账和面板就会各说各话 —— 这个测试专门盯这件事。 */
import { readFileSync } from 'node:fs';

const HOST = new URL('../lib/index.js', import.meta.url);
const CLIENT = new URL('../lib/client.js', import.meta.url);
const host = readFileSync(HOST, 'utf8');
const client = readFileSync(CLIENT, 'utf8');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✅ ' + label + ' 一致'); }
  else { fail++; console.log('  ❌ ' + label + ' 漂了\n      宿主 ' + g + '\n      客户端 ' + w); }
}

/** 抓 `名字 = <数组字面量>` 里的数组字面量并求值（都是我们自己写的纯字面量）。 */
function grabArray(src, name) {
  const re = new RegExp(name + '\\s*=\\s*(\\[[\\s\\S]*?\\n\\s*\\];)');
  const m = src.match(re);
  if (m === null) throw new Error('抓不到 ' + name);
  return eval(m[1].replace(/;$/, ''));
}

/* 价目表：客户端带 name 字段，宿主不带，只比计价用的三项 */
function priceMap(src) {
  const rows = grabArray(src, 'PRICES');
  const out = {};
  for (const row of rows) out[row.match] = { hit: row.hit, miss: row.miss, out: row.out };
  return out;
}

console.log('【价目表】');
eq('PRICES', priceMap(host), priceMap(client));

console.log('【峰时窗口】');
eq('PEAK_WINDOWS / PEAKS',
  grabArray(host, 'PEAK_WINDOWS'),
  grabArray(client, 'PEAKS'));

console.log('【法定节假日】');
const hostHolidays = grabArray(host, 'HOLIDAY_RANGES').map((r) => [r[0], r[1]]);
const clientHolidays = grabArray(client, 'HOLIDAY_RANGES').map((r) => [r[0], r[1]]);
eq('HOLIDAY_RANGES', hostHolidays, clientHolidays);

/* v4 起**没有档位表**了：认充值只假设「整数元」（见 计费算法说明.md §4.1）。
   这里原先还比对 TOPUP_TIERS，那已经随 v3 一起删除 —— 继续抓它只会永远抛错。
   「这些 v3 概念不许在代码里复活」由 v4-drift.test.mjs ⑤ 负责盯。 */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
