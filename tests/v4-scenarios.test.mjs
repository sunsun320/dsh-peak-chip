/**
 * v4 记账口径的**边缘情景**测试（纯合成数据，不依赖真实账本）。
 *
 * 由已归档的 v3 真实账本回放测试拆出来的：那边靠 2026-09-20 的真实账本当输入，
 * 而账本自 v4.0.9 起**只留一天**，那份输入按设计已经不存在了。
 * 这里保住的是与真实数据无关、永远该跑通的那些情景：
 *   手动修正 / 其它端消费 / 负基线 / 「T 写成 round(R) 会吃掉误差」/ 充值到账那窗不误报
 *
 * 用法：node v4-scenarios.test.mjs
 */
import { accountDay } from '../lib/index.js';

const DAY = '2026-09-20';

const freshState = {
  dayKey: '',
  dayFirstBalance: -1,
  localToday: 0,
  autoTopUp: 0,
  rHistory: '[]',
  rBaseline: 0,
  hasBaseline: 0,
  stepStreak: 0,
  manualTopUp: -1,
  appliedManual: -1,
  autoAtManual: 0,
  /* v4.0.7：和 settings schema 对齐 —— 缺字段会让 streak 算成 NaN，
     真实运行时有默认值兜着，测试夹具也必须给全。 */
  otherSpent: 0,
  /* v4.0.8 三档告警状态 */
  alertLevel: 'none',
  yellowStreak: 0,
  redStreak: 0,
  redDayStreak: 0,
  lastRedDayKey: '',
  grayAt: 0,
  todayHadRed: 0,
};

/* ── 情景测试 ─────────────────────────────────────────── */
console.log('\n=== 情景测试 ===');
const scenarios = [];

/* ① 手动修正：直接覆盖，之后的自动识别在这个基础上叠 */
const seeded = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 50, rHistory: '[0]', rBaseline: 0, hasBaseline: 1, autoTopUp: 10 };
let s1 = { ...seeded, manualTopUp: -1 };
s1 = { ...s1, ...accountDay(s1, 40, 0.2, DAY) };
s1 = { ...s1, manualTopUp: 10 };                                   /* 用户填 10（覆盖） */
s1 = { ...s1, ...accountDay(s1, 40, 0.2, DAY) };
scenarios.push(['手动填 10 → T = 10', s1.topUpTotal === 10]);

/* ② 之后又真充 5：应在手动值上叠成 15（台阶要穿过 3 窗滤波 + 连续 2 窗） */
let s2 = { ...s1 };
for (let k = 0; k < 4; k++) s2 = { ...s2, ...accountDay(s2, 45, 0.05, DAY) };
scenarios.push([`手动 10 + 自动再认 5 → T = ${s2.topUpTotal}`, s2.topUpTotal === 15]);

/* ③ 其它端消费 2 元：不该被当成充值，应当进误差 */
let s3 = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 8, rHistory: '[]' };
s3 = { ...s3, ...accountDay(s3, 94, 2, DAY) };                     /* 建立基线 */
for (let k = 0; k < 3; k++) s3 = { ...s3, ...accountDay(s3, 92, 0, DAY) };
scenarios.push([`其它端消费不漏成充值（T = ${s3.autoTopUp}）`, s3.autoTopUp === 0]);
scenarios.push([`其它端消费进了误差（E = ${s3.residual}）`, s3.residual > 1.5]);

/* ④ 负基线：R 一路向下时基线必须变成负数且仍被承认
      （旧实现拿 -1 当「没有基线」的哨兵，会把负基线误判成未初始化 —— 回放测试抓到过） */
let s4 = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 0, rHistory: '[]' };
s4 = { ...s4, ...accountDay(s4, 100, 0, DAY) };                    /* R = 0，建立基线 */
for (let k = 0; k < 3; k++) s4 = { ...s4, ...accountDay(s4, 92, 0, DAY) };   /* R 一路掉到 -8 */
scenarios.push([`基线可以是负数（${s4.rBaseline}）`, s4.hasBaseline === 1 && s4.rBaseline < 0]);
scenarios.push([`负基线下不误判充值（T = ${s4.autoTopUp}）`, s4.autoTopUp === 0]);

/* ⑤ 对照：若 T 写成 round(R)，误差恒 ≤ 0.5，「其它端消费」就被静默吃掉 */
const eIfRound = Math.abs(Math.round(s3.R) - s3.R);
scenarios.push([`round(R) 会让误差只剩 ${Math.round(eIfRound * 100) / 100}（≤0.5）`, eIfRound <= 0.5]);

/* ⑥ 跨日重锚：dayKey 一变就必须重打基准（哪怕中间有查询失败 —— 失败分支不写 dayKey） */
let s5 = { ...freshState, dayKey: '2026-09-20', dayFirstBalance: 100, localToday: 12, rHistory: '[0]', hasBaseline: 1 };
s5 = { ...s5, ...accountDay(s5, 88, 0.1, '2026-09-21') };        /* 跨到第二天 */
scenarios.push([`跨日重打基准（B_首 = ${s5.dayFirstBalance}）`, s5.dayFirstBalance === 88]);
scenarios.push([`跨日清空当日账（L = ${s5.localToday}, T = ${s5.autoTopUp}）`, s5.localToday === 0 && s5.autoTopUp === 0]);
scenarios.push([`跨日后基线重建为 R=0（base=${s5.rBaseline}）`, s5.hasBaseline === 1 && s5.rBaseline === 0]);
scenarios.push([`跨日 dayKey 跟着走（${s5.dayKey}）`, s5.dayKey === '2026-09-21']);

/* ⑦ v4.0.7 口径拆分（今天线上故障的回归断言）
     旧口径：E = |S − L|，于是"别的客户端也在花同一个账号"被判成误差
             → 余额每掉 2 元就攒一格，3 窗后锁死（实测连续 18 窗）。
     新口径：S > L 的差额是**其它端消费 O**（正常）；只有 L > S 才是误差 E。 */
let s7 = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 0, rHistory: '[]' };
s7 = { ...s7, ...accountDay(s7, 100, 0, DAY) };
scenarios.push([`建基线（O=${s7.otherSpent} E=${s7.residual}）`, s7.otherSpent === 0 && s7.residual === 0]);

s7 = { ...s7, ...accountDay(s7, 98, 0, DAY) };                      /* 余额掉 2，本端零消费 = 电脑端在花 */
scenarios.push([`余额掉而本端没花 → 记成其它端消费 O=${s7.otherSpent}`,
  s7.otherSpent === 2 && s7.residual === 0 && s7.redStreak === 0 && s7.alertLevel === 'none']);
s7 = { ...s7, ...accountDay(s7, 96, 0, DAY) };
s7 = { ...s7, ...accountDay(s7, 94, 0, DAY) };
scenarios.push([`连掉三窗也只是 O=${s7.otherSpent}，**不锁存失效**`,
  s7.otherSpent === 6 && s7.alertLevel === 'none' && s7.redStreak === 0]);

/* ⑦b 机制仍在：本机估算**高于**账号推算（不可能，除非本机多算）→ 3 窗锁存；
      中间落回线下要重新计数；跨日复位。
      构造：余额不动（账号没花钱）而本机已累计估算 10 元。 */
let s7b = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 10, rHistory: '[]' };
s7b = { ...s7b, ...accountDay(s7b, 100, 0.1, DAY) };
scenarios.push([`本机多算第 1 窗（E=${s7b.residual}）不锁存`, s7b.redStreak === 1 && s7b.alertLevel !== 'red']);
s7b = { ...s7b, ...accountDay(s7b, 100, 0.1, DAY) };
scenarios.push([`第 2 窗仍不锁存（redStreak=${s7b.redStreak}）`, s7b.redStreak === 2 && s7b.alertLevel !== 'red']);
s7b = { ...s7b, ...accountDay(s7b, 100, 0.1, DAY) };
scenarios.push([`第 3 窗才判红（E=${s7b.residual}）`, s7b.alertLevel === 'red']);
s7b = { ...s7b, ...accountDay(s7b, 100, 0.1, DAY) };
scenarios.push(['红是当日锁存，不回退', s7b.alertLevel === 'red']);
s7b = { ...s7b, ...accountDay(s7b, 100, 0.1, '2026-09-21') };
scenarios.push([`跨日复位（级别=${s7b.alertLevel} redStreak=${s7b.redStreak} 红日=${s7b.redDayStreak}）`,
  s7b.alertLevel === 'none' && s7b.redStreak === 0 && s7b.otherSpent === 0
  && s7b.redDayStreak === 1 && s7b.lastRedDayKey === DAY]);

/* ⑦c 落回线下即重新计数：E 回到 0 一窗，streak 归零 */
let s7c = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 10, rHistory: '[]' };
s7c = { ...s7c, ...accountDay(s7c, 100, 0.1, DAY) };                 /* streak 1 */
scenarios.push([`越线一窗（E=${s7c.residual} redStreak=${s7c.redStreak}）`, s7c.redStreak === 1]);
s7c = { ...s7c, ...accountDay(s7c, 90, 0, DAY) };                    /* 账号花掉 10 → S≈10 ≥ L → E 落回 0 */
scenarios.push([`落回线下即重置（E=${s7c.residual} redStreak=${s7c.redStreak}）`,
  s7c.redStreak === 0 && s7c.alertLevel !== 'red']);

/* ⑧ ★ 充值不能让误差飙高（v4.0.3 的缺陷回归）
      台阶要两窗才确认，而余额在**到账那一窗**就变了。缺了 pending，
      那一窗 S = max(0, V + T) 里的 V+T 变成很负 → 被下限钳到 0
      → E = |0 − L| = **当天累计本地消费 L**。
      也就是说：**只要当天本地消费过了 2 元，每次充值都会把当天锁存成失效。**
      真实量级：每窗消费 0.5 元，充 10 元在第 6 窗到账。 */
const r4 = (v) => Math.round(v * 1e4) / 1e4;
let s8 = { ...freshState, dayKey: DAY, dayFirstBalance: 100, localToday: 0, rHistory: '[]' };
const trace = [];
const push = (label, total, L) => {
  s8 = { ...s8, ...accountDay(s8, total, L, DAY) };
  trace.push({ label, E: s8.residual, T: s8.topUpTotal, auto: s8.autoTopUp, pend: s8.pendingTopUp,
    latch: s8.alertLevel === 'red' ? 1 : 0 });
};
let bal = 100;
for (let k = 1; k <= 5; k++) { bal = r4(bal - 0.5); push(`W${k} 消费0.5`, bal, 0.5); }
bal = r4(bal + 10 - 0.5);                     /* ★ 第 6 窗：充 10 到账，同窗又花 0.5 */
push('W6 ★充值到账', bal, 0.5);
bal = r4(bal - 0.5); push('W7', bal, 0.5);
bal = r4(bal - 0.5); push('W8 确认', bal, 0.5);

console.log('\n  充值前后逐窗：');
for (const t of trace) {
  const pad = (v, n) => String(v).padEnd(n);
  console.log('    ' + pad(t.label, 16) + ' E=' + pad(t.E, 6) + ' T=' + pad(t.T, 5) +
    ' 已确认=' + pad(t.auto, 4) + ' 待确认=' + pad(t.pend, 3) + ' 锁存=' + t.latch);
}

/* 对照：v4.0.3 在充值那窗会是多少（T 仍是 0，S 被钳到 0 → E = L） */
const L_at_w6 = r4(0.5 * 6);
const V_at_w6 = r4(100 - trace[5] && r4(bal0_of(trace)));
function bal0_of() { return 0; }
const eOld = r4(L_at_w6);   /* S 被钳到 0，所以 E = L */
console.log(`    （对照）v4.0.3 在 W6：T 还是 0 → S 被钳到 0 → E = 当天累计 L = ${eOld} → 必然锁存失效`);

scenarios.push([`充值到账那一窗 E 不飙高（E=${trace[5].E}）`, trace[5].E < 2]);
scenarios.push([`到账那窗 T 就已含 pending（T=${trace[5].T}）`, trace[5].T === 10]);
scenarios.push(['充值全程不触发锁存失效', trace.every((t) => t.latch === 0)]);
scenarios.push([`全程 E 都 < 2（最大 ${Math.max(...trace.map((t) => t.E))}）`, trace.every((t) => t.E < 2)]);
scenarios.push([`确认后 pending 归零且不重复计（T=${trace[7].T}）`, trace[7].pend === 0 && trace[7].T === 10]);
scenarios.push([`对照：旧逻辑 W6 的 E=${eOld} ≥ 2`, eOld >= 2]);

for (const [label, ok] of scenarios) console.log((ok ? '  ✓ ' : '  ✗ ') + label);
if (scenarios.some(([, ok]) => !ok)) process.exitCode = 1;
