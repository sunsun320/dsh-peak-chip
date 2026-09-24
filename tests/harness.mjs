/* dsh-peak-chip 客户端测试台：最小 DOM + 假 ctx，真跑 lib/client.js。
   验证峰谷判定、价格行，以及底部「今日消耗 / 余额」两行。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/* ── 最小 DOM ─────────────────────────────────────────────── */
class N {
  constructor(tag) {
    this.tagName = tag; this.childNodes = []; this.style = {};
    this.attrs = {}; this._own = undefined; this._ev = {}; this.parentNode = null;
    this.nodeType = 1;
  }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() {
    if (this._own !== undefined) return this._own;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._own = String(v); this.childNodes = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) { this.childNodes[i] = n; n.parentNode = this; o.parentNode = null; } return o; }
  getBoundingClientRect() { return { right: 360, bottom: 120, left: 160, top: 90, width: 200, height: 28 }; }
  closest() { return null; }
  contains() { return false; }
  addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); }
  removeEventListener() {}
  fire(t) { (this._ev[t] || []).forEach((fn) => fn({ stopPropagation() {}, target: this })); }
}

const tabRow = new N('div');
tabRow.setAttribute('role', 'tablist');
tabRow.textContent = '对话轨迹';
const head = new N('head');
const body = new N('body');

function allNodes(root, out = []) {
  for (const c of root.childNodes) { out.push(c); allNodes(c, out); }
  return out;
}

const document = {
  head, body, documentElement: head,
  createElement: (t) => new N(t),
  getElementById: (id) => allNodes(body).concat(allNodes(head)).find((n) => n.id === id) || null,
  querySelector: () => null,
  querySelectorAll: (sel) => {
    if (sel === '[role="tablist"]') return [tabRow];
    if (sel[0] === '#') {
      return allNodes(body).concat(allNodes(head)).filter((n) => n.id === sel.slice(1));
    }
    if (sel === '[data-dsh-peak-chip]') {
      return allNodes(body).concat(allNodes(tabRow))
        .filter((n) => n.getAttribute('data-dsh-peak-chip') !== null);
    }
    return [];
  },
  addEventListener() {}, removeEventListener() {}
};

let nowMs = 0;
let flash = null;

/**
 * @param host - 宿主那份 status 对象；null 表示 settingsScope 服务不存在。
 */
function load({ host, model = 'deepseek-flash' }) {
  const face = (key) => ({
    getSnapshot: () => (key === 'tokenUsage'
      ? { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      : { lastUsed: { provider: 'deepseek-official', model }, next: null })
  });
  const sessions = {
    list: { getSnapshot: () => ({ current: 's1' }) },
    binding: () => ({ session: { projections: { faceOf: face } } })
  };
  const writes = [];
  const settingsScope = host === null ? undefined : {
    bind: () => ({
      getSnapshot: () => ({ status: 'ready', value: host, revision: 7 }),
      mutate: (ops, rev) => { writes.push({ ops, rev }); return Promise.resolve(true); },
      set: (k, v) => { writes.push({ ops: [{ op: 'set', path: [k], value: v }] }); return Promise.resolve(true); }
    })
  };
  let timerFn = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { flash = def; } }, localStorage: {}, innerWidth: 400, innerHeight: 800 },
    document, Intl, Date, Math, JSON, Object, Array, String, Number, Boolean, isFinite,
    setInterval: (fn) => { timerFn = fn; return 1; },
    clearInterval: () => {},
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'client.js' });

  const mod = flash.factory(() => { throw new Error('no require'); });
  let disposed = null;
  const ctx = {
    get: (n) => (n === 'sessions' ? sessions : (n === 'settingsScope' ? settingsScope : undefined)),
    effect: (fn) => { disposed = fn(); }
  };
  const realNow = Date.now;
  Date.now = () => nowMs;
  mod.apply(ctx);
  return {
    writes: writes,
    tick: () => timerFn(),
    panel: () => body.lastChild,
    chip: () => tabRow.lastChild,
    restore: () => { Date.now = realNow; },
    setNow: (t) => { nowMs = t; },
    dispose: () => { disposed && disposed(); }
  };
}

const BJ = (d, hm) => Date.parse(d + 'T' + hm + ':00+08:00');
const lines = (p) => p.childNodes.map((c) => c.textContent);
let pass = 0, fail = 0;
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('  ✅ ' + label + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + label + '\n      得到 ' + JSON.stringify(got) + '\n      期望 ' + JSON.stringify(want)); }
}

const HOST_OK = {
  refreshMinutes: 5, balance: 17.25, currency: 'CNY', todaySpent: 3.21,
  dayKey: '2026-09-19', at: 1789803506900, error: ''
};

/* ═══ 1. 谷时段 + 宿主有数据 ═══ */
console.log('\n【1】2026-09-19(六) 22:00 北京 · 谷 · 宿主数据正常');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: HOST_OK });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const L = lines(h.panel());
  console.log('    面板：');
  L.forEach((t) => console.log('      │ ' + t));
  eq('标题是谷/周末', L[0].includes('梁文谷') && L[0].includes('周末'), true);
  eq('今日消耗行', L.includes('今日消耗¥3.21'), true);
  eq('余额行', L.includes('余额¥17.25'), true);
  eq('只有两行计费', L.filter((t) => t.includes('今日消耗') || t.includes('余额')).length, 2);
  eq('指示灯只有一个圆点', h.chip().childNodes.length, 1);
  eq('圆点是空的（没有文字）', h.chip().textContent, '');
  eq('圆点颜色 = 谷绿', h.chip().childNodes[0].style.background, '#2f9e6e');
  h.restore();
}

/* ═══ 2. 宿主服务不存在 → 两行都 — ═══ */
console.log('\n【2】没有 settingsScope 服务');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: null });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const L = lines(h.panel());
  eq('今日消耗 —', L.includes('今日消耗—'), true);
  eq('余额 —', L.includes('余额—'), true);
  eq('插件仍然渲染（指示灯在）', h.chip() !== null, true);
  h.restore();
}

/* ═══ 3. 宿主查询失败 → 数字保留，提示里有原因 ═══ */
console.log('\n【3】宿主上一次查询失败');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: { ...HOST_OK, error: '网络不可达' } });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const p = h.panel();
  eq('数字仍在', lines(p).includes('今日消耗¥3.21'), true);
  const spentRow = p.childNodes.find((c) => c.textContent.startsWith('今日消耗'));
  eq('提示写明原因', spentRow.title.includes('网络不可达'), true);
  h.restore();
}

/* ═══ 4. 峰谷切换回归 ═══ */
console.log('\n【4】峰谷判定回归');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: HOST_OK });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  eq('周六晚 = 谷', lines(h.panel())[0].includes('梁文谷'), true);
  h.setNow(BJ('2026-09-21', '10:00')); h.tick();       // 周一上午
  eq('周一上午 = 峰', lines(h.panel())[0].includes('梁文峰'), true);
  h.setNow(BJ('2026-09-20', '10:00')); h.tick();       // 调休周日
  eq('调休周日(9/20) = 谷', lines(h.panel())[0].includes('梁文谷'), true);
  h.setNow(BJ('2026-10-01', '10:00')); h.tick();       // 国庆
  eq('国庆(10/1) = 谷', lines(h.panel())[0].includes('梁文谷'), true);
  h.restore();
}

/* ═══ 5.5 峰时圆点变红 ═══ */
console.log('\n【5.5】峰时段圆点颜色');
{
  nowMs = BJ('2026-09-21', '10:00');
  const h = load({ host: HOST_OK });
  h.setNow(nowMs); h.tick();
  eq('周一上午圆点 = 峰红', h.chip().childNodes[0].style.background, '#e5484d');
  eq('仍然只有一个圆点', h.chip().childNodes.length, 1);
  h.restore();
}

/* ═══ 6. 小额消耗走 4 位小数 ═══ */
console.log('\n【6】两位小数（含小额与 0）');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: { ...HOST_OK, todaySpent: 0.0234 } });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  eq('小额也两位小数', lines(h.panel()).includes('今日消耗¥0.02'), true);
  h.restore();

  const g = load({ host: { ...HOST_OK, todaySpent: 0 } });
  g.setNow(nowMs); g.tick();
  g.chip().fire('click'); g.tick();
  eq('0 显示 ¥0.00', lines(g.panel()).includes('今日消耗¥0.00'), true);
  eq('没有四位小数残留', lines(g.panel()).some((t) => t.includes('.0000')), false);
  g.restore();
}

/* ═══ 5. 未知模型 → 两行价目都列，且不崩 ═══ */
console.log('\n【5】未知模型');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: HOST_OK, model: 'gpt-5-unknown' });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const L = lines(h.panel());
  eq('列了 DS-Flash', L.some((t) => t.includes('0.02/1/4')), true);
  eq('列了 DS-Pro', L.some((t) => t.includes('0.15/4.5/13.5')), true);
  eq('计费两行仍在', L.includes('今日消耗¥3.21') && L.includes('余额¥17.25'), true);
  h.restore();
}

/* ═══ 7. 充值按钮 ═══ */
console.log('\n【7】充值按钮');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: HOST_OK });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const p = h.panel();
  const btn = p.childNodes.find((c) => c.className === 'dsh-peak-chip-btn');
  eq('底部有充值按钮', btn !== undefined, true);
  eq('按钮文案就两个字', btn.textContent, '充值');
  const balRow = p.childNodes.find((c) => c.textContent.startsWith('余额'));
  eq('按钮紧跟在余额后面', p.childNodes[p.childNodes.indexOf(balRow) + 1] === btn, true);
  h.writes.length = 0;                 // 诊断会先写一条，这里只关心点击
  btn.fire('click');
  eq('点了之后写了一次', h.writes.length, 1);
  eq('写的是 openTopUp', h.writes[0].ops[0].path[0], 'openTopUp');
  eq('值是时间戳', typeof h.writes[0].ops[0].value, 'number');
  eq('带了 revision', h.writes[0].rev, 7);
  h.restore();
}

/* ═══ 8. 没有宿主通道时不报错（退回 window.open） ═══ */
console.log('\n【8】没有宿主通道时点充值');
{
  nowMs = BJ('2026-09-19', '22:00');
  const h = load({ host: null });
  let opened = null;
  globalThis.window = { open: (u) => { opened = u; } };   // 客户端代码里的 window 在沙箱里
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const btn = h.panel().childNodes.find((c) => c.className === 'dsh-peak-chip-btn');
  btn.fire('click');
  eq('写到宿主的路走不通时不抛异常', true, true);
  h.restore();
}

/* ═══ 9. 同一页面跑两个实例 → 只能有一个圆点 ═══ */
console.log('\n【9】模块被加载两次（截图里那个「两个绿点」）');
{
  nowMs = BJ('2026-09-19', '22:00');
  tabRow.childNodes.length = 0;                       // 清干净，只看这一轮
  const face = (key) => ({
    getSnapshot: () => (key === 'tokenUsage' ? {}
      : { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, next: null })
  });
  const sessions = {
    list: { getSnapshot: () => ({ current: 's1' }) },
    binding: () => ({ session: { projections: { faceOf: face } } })
  };
  const settingsScope = {
    bind: () => ({
      getSnapshot: () => ({ status: 'ready', value: HOST_OK, revision: 1 }),
      mutate: () => Promise.resolve(true)
    })
  };
  const timers = [];
  const factories = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => factories.push(def) }, localStorage: {}, innerWidth: 400, innerHeight: 800 },
    document, Intl, Date, Math, JSON, Object, Array, String, Number, Boolean, isFinite,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: () => {},
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'client-a.js' });
  vm.runInContext(SRC, sandbox, { filename: 'client-b.js' });
  eq('加载出两个实例', factories.length, 2);

  const realNow = Date.now;
  Date.now = () => nowMs;
  const disposers = [];
  const mkCtx = () => ({
    get: (n) => (n === 'sessions' ? sessions : (n === 'settingsScope' ? settingsScope : undefined)),
    effect: (fn) => { disposers.push(fn()); }
  });
  const mods = factories.map((f) => f.factory(() => { throw new Error('no require'); }));
  mods[0].apply(mkCtx());
  const afterFirst = tabRow.childNodes.length;
  mods[1].apply(mkCtx());
  Date.now = realNow;

  eq('第一个实例插了一个', afterFirst, 1);
  eq('第二个实例接管后仍只有一个', tabRow.childNodes.length, 1);
  eq('所有权标记是个字符串', typeof sandbox.window.__dshPeakChipOwner, 'string');

  /* 两个实例的 tick 都跑一遍，看会不会又变两个 */
  timers.forEach((fn) => fn());
  eq('两个 tick 跑完还是只有一个', tabRow.childNodes.length, 1);
  eq('旧实例已让位（tick 里直接返回）', tabRow.childNodes[0].childNodes.length, 1);

  /* 接管者被卸载 → 让位的那个必须把指示灯接回来，否则一个点都不剩 */
  disposers[1]();
  eq('接管者卸载后暂时没有点', tabRow.childNodes.length, 0);
  timers[0]();
  eq('幸存实例自动接管，点回来了', tabRow.childNodes.length, 1);
  timers.forEach((fn) => fn());
  eq('接回来之后还是只有一个', tabRow.childNodes.length, 1);
}

/* ═══ 11. 对账块：三个数据都显示 ═══ */
console.log('\n【11】面板上的对账块');
{
  nowMs = BJ('2026-09-19', '22:00');
  const dbgLog = JSON.stringify([
    { t: 1, local: 0.5, low: 0.25, high: 1, delta: -0.5, implied: 0.5, topUp: 0, hidden: 0 },
    { t: 2, local: 5, low: 2.5, high: 5, delta: 0, implied: 10, topUp: 10, hidden: 1 },
    { t: 3, local: 0.2, low: 0.1, high: 0.4, delta: 19, implied: 1, topUp: 20, hidden: 0 }
  ]);
  const h = load({ host: { ...HOST_OK, dbgLog: dbgLog } });
  h.setNow(nowMs); h.tick();
  h.chip().fire('click'); h.tick();
  const L = lines(h.panel());
  console.log('    面板：');
  L.forEach((t) => console.log('      │ ' + t));
  eq('本地：点估计 + 最低/最高估测', L.includes('本地0.20 (0.10~0.40)'), true);
  eq('余额变化带方向（升 = 充值到账）', L.includes('余额变化↑19.00'), true);
  eq('累计：两套方案 + 余额侧', L.includes('累计低2.85 高6.40 余0.50'), true);
  eq('档位猜测', L.includes('充值20.00'), true);
  eq('最近几次充值猜测', L.includes('最近20 / 10'), true);
  eq('充值按钮仍在最后一行',
    h.panel().childNodes[h.panel().childNodes.length - 1].className, 'dsh-peak-chip-btn');
  h.restore();
}

/* ═══ 12. 余额变化的方向显示 ═══ */
console.log('\n【12】余额变化：负数是「花掉了」，不是错误值');
{
  nowMs = BJ('2026-09-19', '22:00');
  const mk = (delta) => JSON.stringify([
    { t: 1, local: 0.1, low: 0.05, high: 0.2, delta: delta, implied: 0, topUp: 0, hidden: 0 }
  ]);
  let h = load({ host: { ...HOST_OK, dbgLog: mk(-0.08) } });
  h.setNow(nowMs); h.tick(); h.chip().fire('click'); h.tick();
  eq('下降显示 ↓', lines(h.panel()).includes('余额变化↓0.08'), true);
  h.restore();

  h = load({ host: { ...HOST_OK, dbgLog: mk(20) } });
  h.setNow(nowMs); h.tick(); h.chip().fire('click'); h.tick();
  eq('上升显示 ↑', lines(h.panel()).includes('余额变化↑20.00'), true);
  h.restore();

  h = load({ host: { ...HOST_OK, dbgLog: mk(0) } });
  h.setNow(nowMs); h.tick(); h.chip().fire('click'); h.tick();
  eq('没动显示 ·', lines(h.panel()).includes('余额变化·0.00'), true);
  h.restore();
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
