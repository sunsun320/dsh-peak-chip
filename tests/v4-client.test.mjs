/**
 * 客户端半边（lib/client.js）的冒烟测试。
 *
 * 浏览器代码没法在这台设备上跑真 DOM，所以用一套极小的假 DOM 把整条路径走通：
 *   load 工厂 → apply(ctx) → 点指示灯开面板 → 面板只应有 2 个数字
 *   → 点「本日消耗」开详单 → 详单 5 行 → 点「充值额度」变输入框
 *   → 提交 → 检查写回 settings 的是 manualTopUp
 *
 * 目的很具体：客户端半边一挂是**整批客户端插件一起挂**，不能在用户重启后才发现。
 *
 * 用法：node v4-client.test.mjs
 */
import { readFileSync } from 'node:fs';

/* ── 极小的假 DOM ──────────────────────────────────────── */
let idSeq = 0;
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.nodeId = ++idSeq;
    this.children = [];
    this.parentNode = null;
    this.style = new Proxy({}, { set: (o, k, v) => { o[k] = v; return true; }, get: (o, k) => o[k] });
    this.className = '';
    this.id = '';
    this._text = '';
    this._attrs = {};
    this._handlers = {};
    this.title = '';
    this.value = '';
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  replaceChild(fresh, old) {
    const i = this.children.indexOf(old);
    if (i >= 0) { this.children[i] = fresh; fresh.parentNode = this; old.parentNode = null; }
    return old;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k]; }
  addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); }
  removeEventListener() {}
  contains(n) { return n === this || this.children.some((c) => c.contains && c.contains(n)); }
  closest(sel) {
    const attr = sel.replace(/^\[|\]$/g, '');
    let n = this;
    while (n) { if (n._attrs && attr in n._attrs) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) {
    const want = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (sel.startsWith('.') && String(c.className).split(/\s+/).includes(want)) return c;
      if (sel.startsWith('[') && sel.replace(/^\[|\]$/g, '') in c._attrs) return c;
      if (c.tagName === sel.toUpperCase()) return c;
      const deep = c.querySelector && c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  /* 真实几何：主面板靠右 left=199 width=180 → 右边缘 379，屏宽 400。
     之前 right=260 的假数据测不出「详单右边跑到屏幕外」那个 bug。 */
  getBoundingClientRect() { return { left: 199, top: 200, right: 379, bottom: 232, width: 180, height: 32 }; }
  focus() { this._focused = true; }
  select() {}
  /** 测试用：触发注册过的事件 */
  fire(type, ev) {
    const list = this._handlers[type] || [];
    for (const fn of list) fn(ev || { stopPropagation() {}, target: this });
    return list.length;
  }
  /** 测试用：深度优先找第一个满足条件的节点 */
  find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const deep = c.find && c.find(pred);
      if (deep) return deep;
    }
    return null;
  }
  findAll(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll && c.findAll(pred, out);
    }
    return out;
  }
}

const doc = {
  head: new FakeNode('head'),
  body: new FakeNode('body'),
  documentElement: new FakeNode('html'),
  createElement: (t) => new FakeNode(t),
  getElementById: (id) => doc.body.find((n) => n.id === id) || doc.head.find((n) => n.id === id),
  /* 输入框（composer）默认不存在；维修测试会临时装上假的 */
  composer: null,
  querySelector(sel) {
    if (doc.composer !== null
      && (sel === '[data-composer-input]' || sel === '[contenteditable="true"][role="textbox"]')) return doc.composer;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

/* 与 lib/client.js 里的 C_PEAK 对齐（大红按钮的底色） */
const NS_RED = '#e5484d';

/* ── 装载 bundle ───────────────────────────────────────── */
let factory = null;
const win = {
  __ModuleLoader__: { load: (reg) => { factory = reg.factory; } },
  innerWidth: 400, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
  open() {},
  document: doc,
};
globalThis.window = win;
globalThis.document = doc;

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
new Function('window', 'document', src)(win, doc);
if (typeof factory !== 'function') throw new Error('bundle 没有注册 factory');

const exports_ = factory(() => { throw new Error('不该 require 外部模块'); });

/* ── 假宿主 / settings ─────────────────────────────────── */
const state = {
  refreshMinutes: 5,
  balance: 22.52,
  currency: 'CNY',
  todaySpent: 7.15,
  dayKey: '2026-09-20',
  at: Date.now(),
  error: '',
  dayFirstBalance: 18.67,
  localToday: 7.21,
  balanceDelta: -3.85,
  autoTopUp: 11,
  topUpTotal: 11,
  residual: 0.06,
  alertLevel: 'none',
  autoTopUp: 11,
  manualTopUp: -1,
  /* v4.1.7：维修手册的绝对路径由**宿主**给（各实例的 DSH_HOME 不同，客户端不许推算/写死） */
  manualPath: '/tmp/某台机器的DSH/plugin-src/dsh-peak-chip/维修手册.md',
  /* v4.0.7：O（面板上叫「无法审计」），客户端缺这个字段会显式报「缺 otherSpent」 */
  otherSpent: 0.0,
  manualTopUp: -1,
  dbgLog: '[]',
};
const writes = [];
const mutateCalls = [];      /* 每次 mutate 的原始 ops —— 用来验"一次提交两个键" */
const scope = {
  getSnapshot: () => ({ value: { ...state }, revision: 1 }),
  set: (k, v) => { writes.push({ [k]: v }); return Promise.resolve(); },
  mutate: (ops) => {
    mutateCalls.push(ops);
    for (const op of ops) writes.push({ [op.path[0]]: op.value });
    return Promise.resolve();
  },
};
let effectCleanup = null;
const ctx = {
  get: (n) => (n === 'settingsScope' ? { bind: () => scope } : undefined),
  effect: (fn) => { effectCleanup = fn(); },
  on: () => {},
};

/* ── 跑起来 ────────────────────────────────────────────── */
const problems = [];
const check = (label, ok) => { if (!ok) problems.push(label); };

exports_.apply(ctx);

/* tick 每秒一次，这里手动触发一轮 */
const chip = doc.body.find((n) => n.getAttribute && n.getAttribute('data-dsh-peak-chip') === '1');
check('指示灯创建成功', chip !== null);
if (chip) chip.fire('click');

const panel = doc.body.find((n) => n.id === 'dsh-peak-chip-panel');
check('面板打开', panel !== null);

if (panel) {
  /* 面板 = 峰谷状态 + 价格 + 「还有 X 分」 + 两个账数字。账数字只该有这两个，
     旧的对账块（本地 / 余额变化 / 累计 / 充值 / 最近）必须已经搬进详单。 */
  const labels = panel.findAll((n) => String(n.className).includes('-k')).map((n) => n.textContent);
  for (const gone of ['本地', '余额变化', '累计', '充值', '最近']) {
    check(`面板不该再有「${gone}」行`, !labels.includes(gone));
  }
  check(`面板含「本日消耗」，实际 ${JSON.stringify(labels)}`, labels.includes('本日消耗'));
  check('面板含「余额」', labels.includes('余额'));

  const spentRow = panel.find((n) => String(n.className).includes('-click'));
  check('「本日消耗」整行可点', spentRow !== null);
  if (spentRow) spentRow.fire('click');
}

const detailView = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
check('详单打开', detailView !== null);

/* 本轮真正的 bug：详单右边缘跑到屏幕外，右对齐的数值整列看不见。
   这条断言就是防它回来的。 */
if (detailView) {
  const dLeft = parseFloat(detailView.style.left);
  const dW = parseFloat(detailView.style.width);
  check(`详单必须完整在屏幕内（left=${dLeft} + width=${dW} ≤ ${win.innerWidth - 8}）`,
    Number.isFinite(dLeft) && Number.isFinite(dW) && dLeft + dW <= win.innerWidth - 8);
  check(`详单与主面板右边缘对齐（${dLeft + dW} ≈ 379）`, Math.abs((dLeft + dW) - 379) < 0.5);
}

if (detailView) {
  const rows = detailView.findAll((n) => String(n.className).includes('-row'));
  check(`详单应有 6 行，实际 ${rows.length}`, rows.length === 6);
  for (const k of ['本地审计', '本日首次观测余额', '当前余额', '今日充值', '无法审计', '误差']) {
    check(`详单含「${k}」`, detailView.find((n) => n.textContent === k) !== null);
  }
  /* 四行都必须有值 —— 这是本轮线上故障的回归断言：
     之前注释行更新了、三个值行却是空的，且完全静默。 */
  const byLabel = {};
  for (const r of rows) {
    const v = r.find((n) => String(n.className).includes('-v'));
    byLabel[r.children[0].textContent] = v ? v.textContent : '';
  }
  check(`本地审计 = 7.21，实际 ${JSON.stringify(byLabel)}`, byLabel['本地审计'] === '7.21');
  /* 4.1.1：余额那行拆成两个端点（不再显示带方向的差值 V） */
  check(`本日首次观测余额 = ¥18.67，实际 ${JSON.stringify(byLabel['本日首次观测余额'])}`,
    byLabel['本日首次观测余额'] === '¥18.67');
  check(`当前余额 = ¥22.52，实际 ${JSON.stringify(byLabel['当前余额'])}`,
    byLabel['当前余额'] === '¥22.52');
  check(`今日充值 = 整数 11，实际 ${JSON.stringify(byLabel['今日充值'])}`, byLabel['今日充值'] === '11');
  check(`误差 < 2 显示「正常」，实际 ${JSON.stringify(byLabel['误差'])}`, byLabel['误差'] === '正常');
  check('五行一个都不能是空串或 ?', Object.values(byLabel).every((v) => v !== '' && v !== '?'));
  check(`无法审计 = 0.00，实际 ${JSON.stringify(byLabel['无法审计'])}`, byLabel['无法审计'] === '0.00');

  /* 点「充值额度」→ 变输入框 → 提交 20。
     点击是委托在 body 上的，所以要带着 target 触发。 */
  const tRow = detailView.find((n) => String(n.className).includes('-topup'));
  check('充值额度行可点', tRow !== null);
  const dbody = detailView.find((n) => String(n.className).includes('-dbody'));
  check('详单有内容容器（委托挂点）', dbody !== null);
  if (tRow && dbody) {
    dbody.fire('click', { target: tRow, stopPropagation() {} });
    const input = detailView.find((n) => n.tagName === 'INPUT');
    check('点开后出现输入框', input !== null);
    if (input) {
      input.value = '20';
      input.fire('blur');
      const wrote = writes.filter((w) => 'manualTopUp' in w).map((w) => w.manualTopUp);
      check(`提交 20 写回 manualTopUp=20，实际 ${JSON.stringify(wrote)}`, wrote.includes(20));
      /* v4.1.4（A′ 方案）：同一次提交里必须带上「立刻取一次余额做预览」的请求，
         否则手动值要等最长 refreshMinutes 才顶替显示（用户报障：生效延迟极大）。
         并且要和 manualTopUp **同一次 mutate** —— 分两次写会撞 revision。 */
      const lastOps = mutateCalls[mutateCalls.length - 1] || [];
      const keys = lastOps.map((op) => op.path[0]);
      check(`一次 mutate 同时写 manualTopUp 与 previewNow（实际 ${JSON.stringify(keys)}）`,
        keys.includes('manualTopUp') && keys.includes('previewNow'));
      const stamp = (lastOps.find((op) => op.path[0] === 'previewNow') || {}).value;
      check(`previewNow 是递增时间戳（实际 ${JSON.stringify(stamp)}）`,
        Number.isFinite(stamp) && stamp > 0);

      /* ── v4.1.5 回归断言（用户报的 bug）────────────────────────
         点确认后**第一帧**就必须显示刚填的数。之前这里会先回退成宿主旧值
         （那一刻 previewAt 还是 0，客户端拿的是没更新的快照），约 1 秒后才跳上来 ——
         用户原话：「谁家手动填值是这样来回跳的」。 */
      const rowOf = (dv, label) => dv.findAll((n) => String(n.className).includes('-row'))
        .find((r) => r.children[0] && r.children[0].textContent === label);
      const valOf = (row) => { const v = row && row.find((n) => String(n.className).includes('-v')); return v ? v.textContent : ''; };
      {
        const dv1 = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
        const t1 = rowOf(dv1, '今日充值');
        check(`确认后第一帧就显示 20*（实际 ${JSON.stringify(valOf(t1))}）`, valOf(t1) === '20*');
        check(`第一帧标注「正在确认」（实际 ${JSON.stringify(t1.title)}）`,
          String(t1.title).includes('正在确认'));
      }
      /* 宿主确认（应用了手填值）→ 回声撤掉、星号消失、数字不动 */
      state.appliedManual = 20;
      state.manualTopUp = 20;
      state.topUpTotal = 20;
      await new Promise((r) => setTimeout(r, 1200));
      {
        const dv1 = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
        const t1 = rowOf(dv1, '今日充值');
        check(`宿主确认后仍是 20、且不再带星号（实际 ${JSON.stringify(valOf(t1))}）`, valOf(t1) === '20');
        check('宿主确认后不再显示「正在确认」', !String(t1.title).includes('正在确认'));
      }
      /* 另一条确认路径：宿主的预览送回了同一个数 → 回声立刻让位（显示宿主预览值） */
      state.previewAt = Date.now();
      state.previewSampleAt = Date.now();
      state.previewTopUp = 20;
      await new Promise((r) => setTimeout(r, 1200));
      {
        const dv1 = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
        const t1 = rowOf(dv1, '今日充值');
        check(`预览送回同值后显示 20*（实际 ${JSON.stringify(valOf(t1))}）`, valOf(t1) === '20*');
        check('此时标注改成「等下一窗确认」', String(t1.title).includes('等下一窗确认'));
      }
      state.previewAt = 0;
      state.previewSampleAt = 0;
      state.previewTopUp = -1;
      await new Promise((r) => setTimeout(r, 1200));
      /* 提交后输入框必须消失（否则 T 行会被守卫永久跳过） */
      check('提交后输入框消失', detailView.find((n) => n.tagName === 'INPUT') === null);
    }
  }
}

/* 锁存为失效时显示「失效」。refreshDetail 由每秒的 tick 驱动，
   所以改完宿主状态要等一拍让它重画。 */
state.alertLevel = 'red';
/* 让误差真的有方向可给：本地 5.00 < 账面 8.20 → 本地偏低 → 充值偏大 → 该减 */
state.residual = 3.2;
state.otherSpent = 3.5;      /* v4.0.7：两个量分开后，提示各说各的 */
state.localToday = 5.0;
state.todaySpent = 8.2;
await new Promise((r) => setTimeout(r, 1200));
{
  const dv = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
  /* 按「标签是第一列」找行 —— 直接 find(textContent==='误差') 会命中标签 span 本身 */
  const errRow = dv && dv.findAll((n) => String(n.className).includes('-row'))
    .find((r) => r.children[0] && r.children[0].textContent === '误差');
  const v = errRow && errRow.find((n) => String(n.className).includes('-v'));
  check(`errorLatched=1 时显示「失效」，实际 ${JSON.stringify(v && v.textContent)}`,
    v !== null && v !== undefined && v.textContent === '失效');
  {
    const note = dv.find((n) => String(n.className).includes('-sub'));
    check('底部解释是固定两句',
      note.textContent === '今日充值依据余额变动猜测。出现误差请手动调整。');
    check('红的原因与两条提示都在长按提示里',
      String(note.title).includes('红色·失效')
      && String(note.title).includes('无法审计')
      && String(note.title).includes('本地审计比账号推算高'));
    /* v4.0.7 的回归断言：别再拿 |S−L| 的方向叫人去改充值 —— 
       在"别的客户端也在花同一个账号"时那是错的建议。 */
    check('不再教用户改充值去配平', !String(note.title).includes('手动改今日充值时相应'));
  }
}

/* ── v4.1.4 提交预览：手填值刚写下去时，用宿主**单独采样**算出来的值顶替显示 ──
   断言的重点是"只顶替显示"：数字带星号、底部小字说明、宿主清掉后立刻回到正式值。 */
Object.assign(state, {
  previewAt: Date.now(),
  previewSampleAt: Date.now(),
  previewTopUp: 130,
  previewBalance: 5.2,
  previewDayFirst: 18.67,
  previewTodaySpent: 113.47,
  previewOtherSpent: 106.26,
});
await new Promise((r) => setTimeout(r, 1200));
{
  const dv = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
  const rows = dv === null ? [] : dv.findAll((n) => String(n.className).includes('-row'));
  const byLabel = {};
  for (const r of rows) {
    const v = r.find((n) => String(n.className).includes('-v'));
    byLabel[r.children[0].textContent] = v ? v.textContent : '';
  }
  check(`预览：今日充值顶替成 130*（实际 ${JSON.stringify(byLabel['今日充值'])}）`,
    byLabel['今日充值'] === '130*');
  check(`预览：当前余额顶替成 ¥5.20*（实际 ${JSON.stringify(byLabel['当前余额'])}）`,
    byLabel['当前余额'] === '¥5.20*');
  check(`预览：本日首次观测余额仍是锚点 ¥18.67*（实际 ${JSON.stringify(byLabel['本日首次观测余额'])}）`,
    byLabel['本日首次观测余额'] === '¥18.67*');
  check(`预览：无法审计顶替成 106.26*（实际 ${JSON.stringify(byLabel['无法审计'])}）`,
    byLabel['无法审计'] === '106.26*');
  check(`预览：本地审计不参与预览、保持宿主值（实际 ${JSON.stringify(byLabel['本地审计'])}）`,
    byLabel['本地审计'] === '5.00');
  const note = dv.find((n) => String(n.className).includes('-sub'));
  check('预览时底部小字说明星号含义', String(note.textContent).startsWith('* 预览：'));
  check('预览时星号含义也在长按提示里', String(note.title).includes('预览值'));
  const pn = doc.body.find((n) => n.id === 'dsh-peak-chip-panel');
  const spent = pn.find((n) => String(n.className).includes('-v'));
  check(`预览：主面板本日消耗顶替成 ¥113.47*（实际 ${JSON.stringify(spent.textContent)}）`,
    spent.textContent === '¥113.47*');
}

/* 下一窗正式算账后宿主清掉预览 → 立刻回到正式值，星号消失。 */
Object.assign(state, {
  previewAt: 0, previewSampleAt: 0, previewTopUp: -1, previewBalance: -1,
  previewDayFirst: -1, previewTodaySpent: -1, previewOtherSpent: -1,
  todaySpent: 8.2, balance: 22.52,
});
await new Promise((r) => setTimeout(r, 1200));
{
  const dv = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
  const tRow = dv.findAll((n) => String(n.className).includes('-row'))
    .find((r) => r.children[0] && r.children[0].textContent === '今日充值');
  /* 取 -v 那个 span（可点行外面还包了一层，假 DOM 的 textContent 语义跟真 DOM 不同） */
  const tVal = tRow.find((n) => String(n.className).includes('-v'));
  check(`预览清掉后今日充值回到正式值 20（实际 ${JSON.stringify(tVal && tVal.textContent)}）`,
    tVal !== null && tVal.textContent === '20');
  const pn = doc.body.find((n) => n.id === 'dsh-peak-chip-panel');
  const spent = pn.find((n) => String(n.className).includes('-v'));
  check(`预览清掉后主面板回到正式值 ¥8.20（实际 ${JSON.stringify(spent.textContent)}）`,
    spent.textContent === '¥8.20');
}

/* ── v4.1.6 维修大红按钮：点一下把指路消息写进当前会话的输入框（只填不发送）──
   三条写入通道按可靠性降级，这里逐条验证；断言里也钉住"按钮必须又大又红"。 */
{
  const dv = doc.body.find((n) => n.id === 'dsh-peak-chip-detail');
  const btn = dv.find((n) => String(n.className).includes('-repair'));
  check('详单里有维修按钮', btn !== null && btn.tagName.toLowerCase() === 'button');
  const css = btn === null ? '' : String(btn.style.cssText);
  check(`按钮是红的（背景 ${NS_RED}）`, css.includes(NS_RED));
  check('按钮又大：整宽 + 触控高度 ≥44px', css.includes('width:100%') && /min-height:4[4-9]px/.test(css));
  check('按钮文字就是「一键维修」', btn !== null && String(btn.textContent).trim() === '一键维修');
  /* 位置：最底下 —— 在误差那行的解释（-sub）下面 */
  {
    const kids = dv.children.map((k) => String(k.className));
    const iNote = kids.findIndex((c) => c.includes('-sub'));
    const iBtn = kids.findIndex((c) => c.includes('-repair'));
    check(`按钮在误差解释行下面（-sub 序号 ${iNote} < -repair 序号 ${iBtn}）`,
      iNote >= 0 && iBtn > iNote);
  }

  if (btn !== null) {
  /* ① 编辑器通道（真实环境：Lexical 实例在 __lexicalEditor 上） */
  const composer = new FakeNode('div');
  let parsedJson = null;
  let setCalls = 0;
  composer.__lexicalEditor = {
    parseEditorState: (json) => { parsedJson = json; return { fake: 'state' }; },
    setEditorState: () => { setCalls += 1; composer.textContent = '修一下 dsh-peak-chip 指示灯插件（我点了面板上的维修按钮）。'; },
  };
  doc.composer = composer;
  btn.fire('click', { stopPropagation() {}, preventDefault() {} });
  check(`走编辑器通道填入（setEditorState 调用 ${setCalls} 次）`, setCalls === 1);
  check('提示词指向维修手册，且先要求「问症状」、再「只诊断」（顺序不能反）',
    typeof parsedJson === 'string' && parsedJson.includes('维修手册.md')
      && parsedJson.includes('先问我「发生了什么」') && parsedJson.includes('再只诊断')
      && parsedJson.indexOf('先问我') < parsedJson.indexOf('再只诊断'));
  check('提示词明说别一上来就跑测试/翻代码',
    typeof parsedJson === 'string' && parsedJson.includes('别一上来就跑测试或翻代码'));
  check('提示词用的是宿主给的路径（不是写死的 /root/.dsh）',
    typeof parsedJson === 'string' && parsedJson.includes('/tmp/某台机器的DSH/plugin-src/dsh-peak-chip/维修手册.md')
      && !parsedJson.includes('/root/.dsh'));
  check('提示词带上当前面板状态（给 agent 现成证据）',
    typeof parsedJson === 'string' && parsedJson.includes('当前面板'));
  check('提示词要求修完按契约更新并重新封包',
    typeof parsedJson === 'string' && parsedJson.includes('维修契约') && parsedJson.includes('重新封包'));
  {
    const note = dv.find((n) => String(n.className).includes('-sub'));
    check(`回执说已填入输入框（实际 ${JSON.stringify(String(note.textContent).split('\n').pop())}）`,
      String(note.textContent).includes('已填入输入框'));
    check('长按能拿到将发给 agent 的原文', String(note.title).includes('将发给 agent 的原文'));
  }

  /* ② execCommand 通道（没有编辑器实例的环境） */
  const composer2 = new FakeNode('div');
  doc.composer = composer2;
  doc.execCommand = (cmd, ui, text) => { composer2.textContent = String(text); return true; };
  btn.fire('click', { stopPropagation() {}, preventDefault() {} });
  check('没有编辑器实例时退到 execCommand 通道', composer2.textContent.includes('维修手册.md'));

  /* ③ 连 execCommand 都没有 → 明确报"没找到输入框"，并把提示词留在面板长按里 */
  doc.composer = null;
  delete doc.execCommand;
  btn.fire('click', { stopPropagation() {}, preventDefault() {} });
  {
    const note = dv.find((n) => String(n.className).includes('-sub'));
    check(`找不到输入框时明确报出来（实际 ${JSON.stringify(String(note.textContent).split('\n').pop())}）`,
      String(note.textContent).includes('没找到输入框'));
    check('找不到输入框时提示词仍在长按提示里（能手动复制）',
      String(note.title).includes('维修手册.md'));
  }
  }
}

/* 清理路径不能抛 */
try { if (effectCleanup) effectCleanup(); } catch (e) { problems.push('清理抛异常: ' + e.message); }
check('清理后面板已移除', doc.body.find((n) => n.id === 'dsh-peak-chip-panel') === undefined
  || doc.body.find((n) => n.id === 'dsh-peak-chip-panel') === null);

console.log('=== 客户端冒烟测试 ===');
if (problems.length === 0) console.log('✓ 全部通过');
else {
  console.log('✗ 失败：');
  for (const p of problems) console.log('   · ' + p);
  process.exitCode = 1;
}
