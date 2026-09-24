/* dsh-peak-chip v4.0.8：三档告警 + 认充值加"余额必须上升" + 手填值跨日归零。
 *
 * 这些都是**新语义**，必须有独立断言 —— 旧的锁存断言（errorLatched）已经作废。
 * 构造手法：把 balance 按住不动（V=0）并让本地估算堆高，E = max(0, Λ − S) 就等于堆高的那部分，
 * 于是可以精确地把 E 放到黄区、红区，或验证"余额没上升就不认充值"。
 */
/* 相对自身定位：油纸包可能被还原到别的 DSH_HOME 下，写死路径会当场崩 */
const { accountDay } = await import('../lib/index.js');

let pass = 0, fail = 0;
const ok = (l, c, e) => { if (c) { pass++; console.log(`  ✅ ${l}${e ? ' → ' + e : ''}`); } else { fail++; console.log(`  ❌ ${l}${e ? ' → ' + e : ''}`); } };

const FRESH = {
  dayKey: '', dayFirstBalance: -1, localToday: 0, autoTopUp: 0, rHistory: '[]', rBaseline: 0,
  hasBaseline: 0, stepStreak: 0, manualTopUp: -1, appliedManual: -1, autoAtManual: 0,
  otherSpent: 0, alertLevel: 'none', yellowStreak: 0, redStreak: 0, redDayStreak: 0,
  lastRedDayKey: '', grayAt: 0, todayHadRed: 0, ruleVersion: 408,
};
const DAY = '2026-09-20';
/** 造一个"当日锚点已建、本地估算已堆到 local"的状态，余额按住 100 不动。 */
const seeded = (local, day = DAY, extra = {}) => ({
  ...FRESH, ...extra, dayKey: day, dayFirstBalance: 100, localToday: local,
  hasBaseline: 1, rBaseline: local, rHistory: JSON.stringify([local]),
});
/** 喂 n 个"余额不动、本地不涨"的窗（E 保持不变）。 */
const hold = (st, n, day = DAY, opts) => {
  let s = st;
  for (let i = 0; i < n; i += 1) s = { ...s, ...accountDay(s, 100, 0, day, opts) };
  return s;
};

console.log('\n【1】黄色·存疑（E ∈ [0.6, 1.2]，连续 3 窗，可恢复）');
let s = seeded(0.7);
s = { ...s, ...accountDay(s, 100, 0, DAY) };
ok('第 1 窗：yellowStreak=1，级别还不是黄', s.yellowStreak === 1 && s.alertLevel === 'none', `level=${s.alertLevel}`);
s = hold(s, 2);
ok('第 3 窗：判黄', s.alertLevel === 'yellow' && s.yellowStreak === 3, `level=${s.alertLevel}`);
ok('黄不改写 E 本身', Math.abs(Number(s.residual) - 0.7) < 0.01, `E=${s.residual}`);

console.log('\n【2】黄的滞回带：0.4–0.6 之间保持，不重置也不升级');
s = { ...s, ...accountDay(s, 100, 0, DAY, undefined) };
s.localToday = 0.5;                       /* 手动把 L 调回 0.5 → E=0.5，落在滞回带 */
let t = { ...s, dayFirstBalance: s.dayFirstBalance, rBaseline: s.rBaseline };
t = { ...t, ...accountDay(t, 100, 0, DAY) };
ok('E=0.5（带内）不重置 yellowStreak', t.yellowStreak === 3, `streak=${t.yellowStreak}`);
ok('级别仍是黄', t.alertLevel === 'yellow', `level=${t.alertLevel}`);

console.log('\n【3】黄可恢复：E < 0.4 连续 3 窗 → 回正常');
t.localToday = 0.2;
t.rBaseline = 0.2; t.rHistory = JSON.stringify([0.2]);
t = hold(t, 3);
ok('回落到 0.2 后连续 3 窗 → 解除黄', t.alertLevel === 'none' && t.yellowStreak === 0, `level=${t.alertLevel} streak=${t.yellowStreak}`);

console.log('\n【4】红色·失效（E > 1.2，当日锁存不回退）');
let r = seeded(1.5);
r = hold(r, 3);
ok('连续 3 窗 E=1.5 → 判红', r.alertLevel === 'red' && r.redStreak === 3, `level=${r.alertLevel}`);
r = hold({ ...r, localToday: 0, rBaseline: 0, rHistory: '[]' }, 3);   /* E 归零 */
ok('红锁存：E 归零也不回退', r.alertLevel === 'red', `level=${r.alertLevel}`);
ok('当天红过 → todayHadRed=1', Number(r.todayHadRed) === 1);

console.log('\n【5】灰色·故障（连续 3 个自然日都红 → 永久）');
let g = seeded(1.5);
g = hold(g, 3);                                        /* 第 1 天红 */
ok('第 1 天：红，还没灰', g.alertLevel === 'red' && Number(g.grayAt) === 0, `level=${g.alertLevel}`);
for (const [day, want] of [['2026-09-21', 1], ['2026-09-22', 2], ['2026-09-23', 3]]) {
  g = { ...g, ...accountDay(g, 100, 0, day) };   /* 跨日：把昨天的红累加进红日计数 */
  g = seeded(1.5, day, g);                       /* 新的一天重新把 L 堆高（保留红日计数） */
  g = hold(g, 3, day);                           /* 连续 3 窗 → 今天也红 */
  ok(`${day}：红日计数=${g.redDayStreak}`, Number(g.redDayStreak) === want, `level=${g.alertLevel}`);
}
ok('连续三天红 → 灰', g.alertLevel === 'gray' && Number(g.grayAt) > 0, `level=${g.alertLevel} grayAt=${g.grayAt}`);
g = { ...g, ...accountDay(g, 100, 0, '2026-09-24') };
ok('灰跨日不消失', g.alertLevel === 'gray', `level=${g.alertLevel}`);

console.log('\n【6】灰的唯一出口：口径升版（ruleVersion 变）');
const bumped = accountDay({ ...g, ruleVersion: 407 }, 100, 0, '2026-09-24');
ok('旧版本的灰被迁移清掉', bumped.alertLevel === 'none' && Number(bumped.grayAt) === 0, `level=${bumped.alertLevel}`);
ok('红日计数一起清零', Number(bumped.redDayStreak) === 0);

console.log('\n【7】认充值加"该窗余额必须上升"');
/* 本地估算往上爬 → R 上升；余额却**在下降**（有正常消费）→ 不允许认成充值 */
let w = seeded(0.0);
w = { ...w, ...accountDay(w, 100, 0, DAY, { balanceRose: true }) };      /* 建基线 */
const beforeT = Number(w.topUpTotal);
w = { ...w, ...accountDay(w, 101.0, 0.2, DAY, { balanceRose: true }) };  /* 余额升 1（充值到账） */
w = { ...w, ...accountDay(w, 101.0, 0.2, DAY, { balanceRose: true }) };
w = { ...w, ...accountDay(w, 101.0, 0.2, DAY, { balanceRose: true }) };
ok('余额上升时正常认充值', Number(w.topUpTotal) > beforeT, `T=${w.topUpTotal}`);

/* 同样的"缺口在涨"，但余额**没上升**（持平）→ 不许认成充值，那部分要留在 E 里示人 */
let v = seeded(0.0);
v = { ...v, ...accountDay(v, 100, 0, DAY, { balanceRose: false }) };
const t0 = Number(v.topUpTotal);
v = { ...v, ...accountDay(v, 100, 0.5, DAY, { balanceRose: false }) };
v = { ...v, ...accountDay(v, 100, 0.5, DAY, { balanceRose: false }) };
v = { ...v, ...accountDay(v, 100, 0.5, DAY, { balanceRose: false }) };
ok('余额没上升时不认充值（新判据生效）', Number(v.topUpTotal) === t0, `T=${v.topUpTotal}`);
ok('那部分留在 E 里（不再被静默吸收）', Number(v.residual) > 1, `E=${v.residual}`);
/* 默认（不传 opts）保持兼容：不该因为新判据而拒绝 */
let u = seeded(0.7);
u = hold(u, 3);
ok('不传 opts 时行为与旧版一致（可单测/可回放）', u.alertLevel === 'yellow', `level=${u.alertLevel}`);

console.log('\n【8】手填值跨日归零（零携带）');
let m = seeded(0.2, DAY, { manualTopUp: 16, appliedManual: 16, autoTopUp: 16, autoAtManual: 16 });
m = { ...m, ...accountDay(m, 100, 0, DAY) };
ok('当天：手填值生效', Number(m.topUpTotal) === 16, `T=${m.topUpTotal}`);
const m2 = { ...m, ...accountDay(m, 100, 0, '2026-09-21') };
ok('跨日：手填值归零', Number(m2.manualTopUp) === 0, `manual=${m2.manualTopUp}`);
ok('跨日后 T 从自动累计重新起算', Number(m2.topUpTotal) === 0, `T=${m2.topUpTotal}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
