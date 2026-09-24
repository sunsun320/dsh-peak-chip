/* dsh-peak-chip v4.1.4（A′ 方案）：手动充值提交后的**提交预览**。
 *
 * 设计（用户定）：手填值写下去的那一瞬间，宿主**单独取一次余额**，用它算出一组
 * **只用于显示**的数字（preview* 字段），手填值先顶替显示；下一窗正常算账成功后清掉。
 * 关键约束：这组数字**不参与记账** —— 不进 accountDay、不动台阶检测与中位数滤波、
 * 不动告警锁存。所以这个测试盯的不是"函数返回什么"，而是：
 *   ① 预览确实立刻写出来了（不等 5 分钟）；
 *   ② 记账状态一个字节都没被碰（这是这次改动的真正风险）；
 *   ③ 下一窗正常算账会把预览清掉；
 *   ④ 预览与正常窗**共用同一份算术**（不会长出第二份口径）。
 *
 * 手法：假 settings 服务 + 假凭据 + 假 fetch + 可手动点火的定时器，驱动真实的 apply()。
 */
const mod = await import('../lib/index.js');

let pass = 0, fail = 0;
function check(label, ok, extra) {
  if (ok) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra === undefined ? '' : '\n       ' + extra)); }
}

/* ── 可手动点火的定时器（正常窗不会自己跑，全由测试决定）── */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let queue = [];
let nextId = 1;
globalThis.setTimeout = (fn, delay) => {
  const id = nextId++;
  queue.push({ fn, delay: Number(delay) || 0, id });
  return id;
};
globalThis.clearTimeout = (id) => { queue = queue.filter((s) => s.id !== id); };
function fireNext() {
  const s = queue.shift();
  if (s === undefined) throw new Error('没有排队的定时器可点火');
  return s.fn();
}
const delays = () => queue.map((s) => s.delay);
const settle = () => new Promise((r) => realSetTimeout(r, 20));

/* 请求时间戳：严格递增（和客户端 nextStamp() 一样；真实世界里同一毫秒撞车
   就等于这次请求丢了，所以测试也不该靠 Date.now() 去撞运气）。 */
let reqStamp = 0;
const nextStamp = () => ++reqStamp;

/* ── 假 fetch ───────────────────────────────────────────── */
let balance = 100;
let fetches = 0;
let gate = null;                 /* 非 null 时 fetch 会等它放行 */
let fetchFails = false;
let credsReady = true;
globalThis.fetch = async () => {
  fetches++;
  const wait = gate;
  if (wait !== null) await wait;
  if (fetchFails) throw new Error('网络炸了');
  return {
    ok: true, status: 200,
    async json() { return { balance_infos: [{ total_balance: balance.toFixed(2), currency: 'CNY' }] }; },
  };
};

/* ── 假 settings 服务 ──────────────────────────────────── */
const warnings = [];
let scope = null;
function makeScope(initial) {
  let value = { ...initial };
  const watchers = [];
  return {
    get: () => value,
    watch: (fn) => { watchers.push(fn); return () => { const i = watchers.indexOf(fn); if (i >= 0) watchers.splice(i, 1); }; },
    apply: (patch) => { value = { ...value, ...patch }; watchers.forEach((fn) => fn()); },
    /* 客户端 mutate：一次写多个键，只通知一次 */
    writeMany: (patch) => { value = { ...value, ...patch }; watchers.forEach((fn) => fn()); },
  };
}
const settingsService = {
  register: (ns, schema, opts) => {
    /* 用插件**真的** schema 默认值（Config 为可测而导出），不手抄假默认值 */
    scope = makeScope({ ...mod.Config({}), ...((opts && opts.base) || {}) });
    return scope;
  },
  update: async (ns, patch) => { scope.apply(patch); },
};

const disposers = [];
const ctx = {
  logger: { info() {}, warn(...a) { warnings.push(String(a[0])); } },
  /* 收集 disposer 而不是立刻调用 —— 立刻调用等于当场卸载插件 */
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  on: () => () => {},
  get: (name) => {
    if (name === 'settings') return settingsService;
    if (name === 'credentials') {
      return credsReady ? { resolve: async () => ({ value: 'sk-test' }) } : undefined;
    }
    return undefined;
  },
  inject: (deps, cb) => cb({ settings: settingsService, effect: ctx.effect }),
};

mod.apply(ctx);
check('apply() 挂上了 settings 命名空间', scope !== null);

/* 第一窗（apply 里直接调的 void tick()） */
await settle();
check(`首窗查了一次余额（实际 ${fetches}）`, fetches === 1);
check(`首窗后按 refreshMinutes 排下一轮（实际 ${JSON.stringify(delays())}）`,
  delays().length === 1 && delays()[0] === 5 * 60 * 1000);

/* 记下"记账状态"，稍后要逐项核对预览没有碰它 */
const before = scope.get();
const ACCOUNTING = ['at', 'dayKey', 'topUpTotal', 'localToday', 'balanceDelta', 'todaySpent',
  'otherSpent', 'residual', 'appliedManual', 'autoTopUp', 'autoAtManual', 'alertLevel',
  'dbgLog', 'windowSpend', 'rHistory', 'rBaseline', 'stepStreak'];
const snapshotAccounting = () => JSON.stringify(ACCOUNTING.map((k) => [k, before[k]]));
const accountingBefore = snapshotAccounting();
const fetchesBefore = fetches;

/* ── 客户端提交手填值：一次 mutate 写两个键（manualTopUp + previewNow）── */
balance = 5.2;                    /* 提交后"单独取到"的余额 */
await scope.writeMany({ manualTopUp: 130, previewNow: nextStamp() });
await settle();

check(`预览多查了一次余额（${fetchesBefore} → ${fetches}）`, fetches === fetchesBefore + 1);
check(`预览立刻写出来了（previewAt = ${scope.get().previewAt}）`,
  Number(scope.get().previewAt) > 0);
check(`手填值立刻顶上去（previewTopUp = ${scope.get().previewTopUp}）`,
  Number(scope.get().previewTopUp) === 130);
check(`预览采样时间也写上了（previewSampleAt = ${scope.get().previewSampleAt}）`,
  Number(scope.get().previewSampleAt) > 0);
check(`预览用的是刚采到的余额（previewBalance = ${scope.get().previewBalance}）`,
  Number(scope.get().previewBalance) === 5.2);
/* 期望值按口径算：V = 首余额 − 当前余额 = 100 − 5.2 = 94.8；S = max(0, V + 130) = 224.8 */
check(`预览 S = max(0, V + T) = 224.8（实际 ${scope.get().previewTodaySpent}）`,
  Math.abs(Number(scope.get().previewTodaySpent) - 224.8) < 1e-9,
  `V=${Number(scope.get().previewDayFirst) - Number(scope.get().previewBalance)}`);
check(`预览 O = max(0, S − L) = 224.8（L = 0）（实际 ${scope.get().previewOtherSpent}）`,
  Math.abs(Number(scope.get().previewOtherSpent) - 224.8) < 1e-9);

/* 真正的风险点：预览绝不能碰记账状态 */
check('★ 预览没有碰任何记账状态（at/topUpTotal/localToday/告警/dbgLog…）',
  snapshotAccounting() === accountingBefore,
  '差异：' + ACCOUNTING.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(scope.get()[k]))
    .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(scope.get()[k])}`).join('，'));
check(`★ 预览没有跑正常窗（下一轮仍是 ${JSON.stringify(delays())}）`,
  delays().length === 1 && delays()[0] === 5 * 60 * 1000);

/* ── 下一窗正常算账：合法值就位 + 预览清掉 ─────────────── */
await fireNext();                 /* 点火那一轮正常窗 */
await settle();
check(`正常窗把预览清掉了（previewAt = ${scope.get().previewAt}）`,
  Number(scope.get().previewAt) === 0);
check(`正常窗里手填值被正式认领（appliedManual = ${scope.get().appliedManual}）`,
  Number(scope.get().appliedManual) === 130);
check(`正常窗里今日充值 = 130（实际 ${scope.get().topUpTotal}）`,
  Number(scope.get().topUpTotal) === 130);
check('正常窗照常排下一轮', delays().length === 1 && delays()[0] === 5 * 60 * 1000);
check(`正常窗也会重新查余额（fetches = ${fetches}）`, fetches === fetchesBefore + 2);

/* ── 取不到余额：手填值仍然顶上去，S 等下一窗 ──────────── */
fetchFails = true;
await scope.writeMany({ manualTopUp: 200, previewNow: nextStamp() });
await settle();
check(`采样失败仍写下 previewTopUp = 200（实际 ${scope.get().previewTopUp}）`,
  Number(scope.get().previewTopUp) === 200);
check(`采样失败时 previewSampleAt 保持 0（实际 ${scope.get().previewSampleAt}）`,
  Number(scope.get().previewSampleAt) === 0);
check('采样失败不给用户显示假余额（previewBalance = -1）',
  Number(scope.get().previewBalance) === -1);
check('采样失败会留日志（不静默吞）', warnings.some((w) => w.includes('提交预览取余额失败')),
  JSON.stringify(warnings.slice(-2)));
fetchFails = false;

/* ── 连点两次：不叠采样，最后一次的值赢 ───────────────── */
let release;
gate = new Promise((r) => { release = r; });
const f0 = fetches;
await scope.writeMany({ manualTopUp: 300, previewNow: nextStamp() });   /* 会卡在采样上 */
await scope.writeMany({ manualTopUp: 400, previewNow: nextStamp() });   /* 跑的过程中又来一次 */
await settle();                   /* 让微任务跑完 —— 第一个采样卡在门上，不会完成 */
check(`跑的过程中不会叠出第二个采样（fetches = ${fetches}，应为 ${f0 + 1}）`,
  fetches === f0 + 1);
gate = null;
release();
await settle();
check(`跑完补的一轮用的是最后一次的值（previewTopUp = ${scope.get().previewTopUp}）`,
  Number(scope.get().previewTopUp) === 400);
check(`合并后仍然只多查一次余额（fetches = ${fetches}，应为 ${f0 + 2}）`, fetches === f0 + 2);

/* ── 防漂移：预览与正常窗**同源**（不能长出第二份口径）── */
{
  const local = 5;
  const state = {
    ...mod.Config({}),
    dayKey: '2026-09-21',
    dayFirstBalance: 18.67,
    localToday: local,
    hasBaseline: 1,
    rBaseline: 0,
    manualTopUp: 130,
    appliedManual: 130,
    autoTopUp: 0,
    autoAtManual: 0,
  };
  const day = mod.accountDay(state, 5.2, 0, '2026-09-21', { balanceRose: false });
  const pv = mod.previewTotals({
    dayFirstBalance: 18.67, balance: 5.2, manualTopUp: 130, autoTopUp: 0, localToday: local,
  });
  check(`预览的 S 与正常窗同源（${pv.todaySpent} === ${day.todaySpent}）`,
    Math.abs(pv.todaySpent - day.todaySpent) < 1e-9);
  check(`预览的 O 与正常窗同源（${pv.otherSpent} === ${day.otherSpent}）`,
    Math.abs(pv.otherSpent - day.otherSpent) < 1e-9);
  check(`预览的 T 与正常窗同源（${pv.topUpTotal} === ${day.topUpTotal}）`,
    Math.abs(pv.topUpTotal - day.topUpTotal) < 1e-9);
  check(`accountTotals 就是 V/S 的唯一实现（S = ${mod.accountTotals(18.67, 5.2, 130).todaySpent}）`,
    Math.abs(mod.accountTotals(18.67, 5.2, 130).todaySpent - day.todaySpent) < 1e-9);
}

/* ── 卸载 ─────────────────────────────────────────────── */
disposers.forEach((d) => d());
check('卸载后不留定时器', queue.length === 0, JSON.stringify(delays()));

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
