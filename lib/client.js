/*!
 * dsh-peak-chip —— DeepSeek 峰谷指示灯（浏览器半边）
 *
 * 嵌在会话头部「对话 / 轨迹」那一行最右侧，不点击时只有一个小圆点
 * （绿 = 空闲、红 = 高峰），点开才是面板。
 *
 * 那一行是出货代码渲染的 [role="tablist"]，没有给外部留插槽，所以本插件用
 * 原生 DOM 把自绘的胶囊插进去（与 dsh-web-mobile 的 reparenting 同类做法）。
 * 刻意不使用 React：节点由 React 拥有时，把它搬走会在卸载时报 removeChild 错误。
 * 定位锚点：那一行所在容器的兄弟元素带稳定属性 data-conversation-header-corner。
 *
 * ── 面板与详单（v4）────────────────────────────────────────
 * 主面板只留两个数：**本日消耗** 和 **余额**。
 * 点「本日消耗」展开详单，数值行全部由宿主算好送过来（余额拆成首/现两行）：
 *     本地审计 L / 本日首次观测余额 + 当前余额 / 充值额度 T / 无法审计 O / 误差 E（三档告警）
 * 其中「充值额度」可点开手动改（就地变输入框），改完写回设置命名空间。
 * 详单**最底下**（误差那行的解释文字下面）有一个「一键维修」大红按钮：点它把一段
 * "指路消息"（去读插件目录里的 `维修手册.md`）填进当前会话的输入框，让 agent 按手册来修
 * —— 只填不发送，发不发由人决定。
 *
 * 客户端**不做任何口径推断** —— 口径只有一处：lib/index.js 的 accountDay()。
 * 这里只负责显示，外加把 manualTopUp 写回去。
 *
 * 计费规则（官方定价页脚注 2）：
 *   高峰 = 北京时间 周一至周五（不含中国法定节假日）09:00-12:00、14:00-18:00
 *   其余时段（含午休、夜间、周末、法定节假日全天）均为空闲，价格为高峰的一半
 * 价目表来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 节假日数据：国务院办公厅关于 2026 年部分节假日安排的通知（2025-11-04）
 *
 * ⚠️ 2027 年要更新 HOLIDAY_RANGES；官方调价要更新 PRICES（两张副本一起改，
 *    v4-drift.test.mjs 会比对）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-chip',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var NS = 'dsh-peak-chip';
    var CHIP_ATTR = 'data-dsh-peak-chip';
    var CORNER_SEL = '[data-conversation-header-corner]';

    /* ── 价目表：元 / 百万 tokens，[空闲, 高峰] ─────────────── */

    var PRICES = [
      { name: 'DS-Flash', match: 'flash', hit: [0.02, 0.04], miss: [1, 2],     out: [4, 8] },
      { name: 'DS-Pro',   match: 'pro',   hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] }
    ];

    /* 模型 id → 面板上的简写（deepseek-flash → DS-Flash） */
    function shortModel(id) {
      var s = String(id).toLowerCase();
      if (s.indexOf('pro') >= 0) return 'DS-Pro';
      if (s.indexOf('flash') >= 0) return 'DS-Flash';
      return String(id);
    }

    /* ── 规则 ───────────────────────────────────────────────── */

    var PEAKS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

    var HOLIDAY_RANGES = [
      ['2026-01-01', '2026-01-03', '元旦'],
      ['2026-02-15', '2026-02-23', '春节'],
      ['2026-04-04', '2026-04-06', '清明节'],
      ['2026-05-01', '2026-05-05', '劳动节'],
      ['2026-06-19', '2026-06-21', '端午节'],
      ['2026-09-25', '2026-09-27', '中秋节'],
      ['2026-10-01', '2026-10-07', '国庆节']
    ];

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function isoOf(y, mo, d) { return y + '-' + pad2(mo) + '-' + pad2(d); }

    function holidayNameOf(key) {
      for (var i = 0; i < HOLIDAY_RANGES.length; i++) {
        if (key >= HOLIDAY_RANGES[i][0] && key <= HOLIDAY_RANGES[i][1]) return HOLIDAY_RANGES[i][2];
      }
      return null;
    }

    /* 周末或法定节假日 → 全天空闲。调休上班的周末同样按空闲计费（官方口径）。 */
    function restDayOf(y, mo, d) {
      var dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      if (dow === 0 || dow === 6) return { rest: true, why: '周末' };
      var name = holidayNameOf(isoOf(y, mo, d));
      if (name) return { rest: true, why: name };
      return { rest: false, why: '工作日' };
    }

    function isPeakMinute(min) {
      for (var i = 0; i < PEAKS.length; i++) {
        if (min >= PEAKS[i][0] && min < PEAKS[i][1]) return true;
      }
      return false;
    }

    var FMT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    function bjParts(ms) {
      var p = FMT.formatToParts(new Date(ms)), o = {};
      for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
      return {
        y: +o.year, mo: +o.month, d: +o.day,
        h: (+o.hour) % 24, mi: +o.minute, s: +o.second
      };
    }

    function phaseOf(b) {
      var rd = restDayOf(b.y, b.mo, b.d);
      return { peak: !rd.rest && isPeakMinute(b.h * 60 + b.mi), rest: rd.rest, why: rd.why };
    }

    function nextSwitch(nowMs) {
      var b = bjParts(nowMs);
      var cur = phaseOf(b).peak;
      var y = b.y, mo = b.mo, d = b.d, h = b.h, mi = b.mi;
      var rest = restDayOf(y, mo, d).rest;
      for (var i = 1; i <= 5 * 24 * 60; i++) {
        mi += 1;
        if (mi === 60) { mi = 0; h += 1; }
        if (h === 24) {
          h = 0;
          var nd = new Date(Date.UTC(y, mo - 1, d) + 86400000);
          y = nd.getUTCFullYear(); mo = nd.getUTCMonth() + 1; d = nd.getUTCDate();
          rest = restDayOf(y, mo, d).rest;
        }
        var pk = !rest && isPeakMinute(h * 60 + mi);
        if (pk !== cur) {
          var atMs = Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600000;
          return { peak: pk, h: h, mi: mi, inMs: atMs - nowMs };
        }
      }
      return null;
    }

    function fmtDur(ms) {
      if (!(ms > 0)) return '0 秒';
      var t = Math.floor(ms / 1000);
      var hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
      if (hh > 0) return hh + ' 小时 ' + mm + ' 分';
      if (mm > 0) return mm + ' 分 ' + ss + ' 秒';
      return ss + ' 秒';
    }

    function yuan(v) { return (Math.round(v * 100) / 100) + ''; }

    /* ── 宿主给的数字：今日消耗 / 余额 ─────────────────────────
       这两行是账号口径，不是本地审计。宿主半边 lib/index.js 轮询官方接口
         GET https://api.deepseek.com/user/balance
       官方只给余额、不给消费明细，所以
         今日消耗 = 今日首次查到的余额 − 当前余额
       结果写在本插件自己的 settings 命名空间里，这里读快照。
       用 ctx.get 惰性取 settingsScope：拿不到也不影响插件激活，只是两行显示 —。 */

    var HOST_NS = 'dsh-peak-chip';

    /** 红色告警阈值，与宿主 index.js 的 `ALERT_RED` 同值 —— **只用于文案**。
        判定权在宿主：它要求连续 3 窗越线，客户端看到的是瞬时值，自己判会抢跑。
        黄 0.6 / 解除 0.4 / 红 1.2，三档都要求连续 3 窗（见 计费算法说明 §7.2）。 */
    var ALERT_RED_UI = 1.2;

    /** 官方充值页。按钮要跳的就是这里。 */
    var TOPUP_URL = 'https://platform.deepseek.com/top_up';

    var balScope = null;
    var scopeTried = false;

    function hostStatus() {
      if (!scopeTried) {
        scopeTried = true;
        try {
          var ss = (sctx === null) ? undefined : sctx.get('settingsScope');
          if (ss !== undefined && ss.bind !== undefined) balScope = ss.bind({ namespace: HOST_NS });
        } catch (e) { balScope = null; }
      }
      if (balScope === null) return null;
      try {
        var snap = balScope.getSnapshot();
        var v = (snap === null || snap === undefined) ? undefined : snap.value;
        return (v === undefined || v === null) ? null : v;
      } catch (e) { return null; }
    }

    function curSym(st) {
      var c = (st !== null && st.currency) ? String(st.currency).toUpperCase() : 'CNY';
      return c === 'USD' ? '$' : (c === 'EUR' ? '€' : '¥');
    }

    /* 钱一律两位小数——跟余额那行对齐，不再按金额大小换位数 */
    function money2(v) { return (Math.round(v * 100) / 100).toFixed(2); }

    /**
     * 提交预览（A′ 方案，v4.1.4）：手填值刚写下去、正常窗口还没跑时，宿主单独取了一次
     * 余额并算好的**显示用**数字（见 lib/index.js 的 previewTotals）。
     *
     * 这里只读不判：值全是宿主给的，客户端不重算任何口径，也不参与告警判定
     * （告警仍只认宿主给的 alertLevel）。下一窗正常算账成功后宿主会清掉 previewAt，
     * 这些字段自动作废。
     *
     * @returns null（没有预览）或 { topUp, balance, dayFirst, todaySpent, otherSpent, sampled, sampleAt }。
     */
    function previewOf(st) {
      if (st === null || st === undefined || !(Number(st.previewAt) > 0)) return null;
      return {
        /* 手填那个数**总是**有效（不需要网络就能顶替）；其余几项要等采样回来 */
        topUp: Number(st.previewTopUp),
        sampled: Number(st.previewSampleAt) > 0,
        sampleAt: Number(st.previewSampleAt),
        balance: Number(st.previewBalance),
        dayFirst: Number(st.previewDayFirst),
        todaySpent: Number(st.previewTodaySpent),
        otherSpent: Number(st.previewOtherSpent),
      };
    }

    /* 带 * 的数字 = 预览值（下一窗会被正式值覆盖），星号含义写在行的长按提示与底部小字里。 */
    var STAR = '*';

    function spentText(st) {
      var pv = previewOf(st);
      if (pv !== null && pv.sampled && pv.todaySpent >= 0) return curSym(st) + money2(pv.todaySpent) + STAR;
      if (st === null || !(st.todaySpent >= 0)) return '—';
      return curSym(st) + money2(st.todaySpent);
    }

    function balanceText(st) {
      var pv = previewOf(st);
      if (pv !== null && pv.sampled && pv.balance >= 0) return curSym(st) + money2(pv.balance) + STAR;
      if (st === null || !(st.balance >= 0)) return '—';
      return curSym(st) + money2(st.balance);
    }

    /* 长按提示：说清数字怎么来的、上次什么时候查的、失败原因 */
    function hostHint(st) {
      var pv = previewOf(st);
      var preview = pv === null ? '' : (pv.sampled
        ? STAR + ' 预览值：提交手填值后**单独查了一次余额**（'
          + (pv.sampleAt > 0 ? new Date(pv.sampleAt).toLocaleTimeString() : '—')
          + '）算出来的，只用于显示；下一轮正式记账会覆盖它。'
        : STAR + ' 预览值：手填值已提交，但这次没取到余额（下一轮正式记账会补上）。')
        + '\n';
      if (st === null) return '宿主还没把余额送过来（或本页还没连上）';
      if (st.error) return preview + '上一次查询失败：' + st.error;
      var when = st.at > 0 ? new Date(st.at).toLocaleTimeString() : '—';
      return preview + '官方余额接口，每 ' + (st.refreshMinutes || 5) + ' 分钟查一次；'
        + '今日消耗 = 今日首次余额 − 当前余额。上次查询 ' + when;
    }

    /* ── 详单的四个数（v4）─────────────────────────────────────
       主面板只留 本日消耗 / 余额 两个数，其余点开详单看。
       面板上的数全部由宿主算好送过来，客户端**不做任何口径推断** ——
       口径只有一处，在 lib/index.js 的 accountDay()：

         V 余额变动   = 当日首个余额 − 当前余额   正 = 钱变少；充了值就是负数
                        （面板不显示 V 这个差值本身，改成显示它的两个端点：
                          本日首次观测余额 / 当前余额）
         L 本地审计   = 全部计费事件（含 compaction）按真实峰谷档折的钱（旧名：本地估算消耗）
         T 充值额度   = 台阶检测出的整数，可手动修正
         S 本日消耗   = V + T                      主面板那个数（**账号口径**）
         O 无法审计   = max(0, S − L)              同一账号上别的客户端花的（旧名：其它端消费）
         E 误差       = max(0, L − S)              本地审计高出账号推算的部分（才可疑）

       记一个别踩的坑：E 在数学上等于 |T − R|（R 是宿主的累计观测量）。
       所以只要把 T 写成 round(R)，E 就恒 ≤ 0.5、永远显示不出东西 ——
       宿主那边靠「独立观测台阶」避开这一点，这里只负责显示。 */

    function num2(v) {
      var n = Number(v);
      return Number.isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : '—';
    }

    /**
     * 两条提示，别混。
     *
     * ⚠️ v4.0.7 修正：旧版这里拿 |S − L| 的方向叫人去加减手动充值 —— 在
     * 「别的客户端也在花同一个账号」时会给出完全错误的建议（把电脑端消费
     * 说成"本地偏低、充值偏大"）。现在两个量已经分开，各说各的：
     *   O > 0 → 别的客户端花的，正常，与充值无关，别去动 T
     *   E > 0 → 本机多算了，也是本机的问题，同样不该靠改 T 去"配平"
     */
    function sideNotes(st) {
      if (st === null) return [];
      var notes = [];
      var o = Number(st.otherSpent);
      var e = Number(st.residual);
      if (Number.isFinite(o) && o >= 0.5) {
        notes.push('无法审计 ' + (Math.round(o * 100) / 100).toFixed(2) + ' 元：同一账号上别的客户端花的，不需要处理');
      }
      if (Number.isFinite(e) && e >= 0.5) {
        notes.push('本地审计比账号推算高 ' + (Math.round(e * 100) / 100).toFixed(2) + ' 元：可能是本机重复计费，与充值无关');
      }
      return notes;
    }


    /* ── 维修大红按钮 ─────────────────────────────────────────
       为什么是"写进输入框"而不是"直接发一条消息"：本机没有那个官方接口 ——
       `commands` 明确不把输入送给模型，`subagents.sendMessage` 只能发给子会话。
       而且只填不发送，正好把"要不要动代码"的决定留在人手上（本机开工纪律）。 */

    /* 提示词写死在这里（不要挪进设置让用户改：它是维修契约的入口，改错了会绕过"先问症状/先诊断"）。
       ⚠️ 改这段之前先读 维修手册.md §〇 —— 它必须始终指向手册、并要求"先问发生了什么，再只诊断"。
       ⚠️ **路径不许写死**：路径因实例而异（Windows 那边不是 /root/.dsh，换安装位置也会变），
          所以由宿主算好放在 settings 的 `manualPath` 里（见 lib/index.js 的 SELF_DIR）。 */
    var REPAIR_FALLBACK_MANUAL = '本插件目录里的「维修手册.md」（插件包名 dsh-peak-chip，'
      + '通常在 `$DSH_HOME/plugin-src/dsh-peak-chip/` 下；不知道在哪就先 `dsha-plugin list` 确认它装了）';

    /** 手册在哪：宿主给了绝对路径就用它；没给就说清"怎么找到"，绝不写死。 */
    function manualRef(st) {
      var p = (st === null || st === undefined) ? '' : String(st.manualPath || '');
      return p.length > 0 ? p : REPAIR_FALLBACK_MANUAL;
    }

    function repairPrompt(st) {
      return [
        '修一下 dsh-peak-chip 指示灯插件（我点了面板上的「一键维修」按钮）。',
        '先读 ' + manualRef(st) + '，严格按它的流程做：',
        '① 先问我「发生了什么」——什么时候开始的、我在面板上看到什么、之前有没有充值/换模型/改设置；',
        '   别一上来就跑测试或翻代码；',
        '② 再只诊断，把证据、根因、拟改动摆给我，我点头再动手；',
        '③ 修完按手册 §〇 的维修契约更新文档与测试，并重新封包。',
      ].join('\n');
    }

    /** 找当前会话的输入框（Lexical 的 contenteditable）。 */
    function composerEl() {
      var el1 = document.querySelector('[data-composer-input]');
      if (el1 !== null && el1 !== undefined) return el1;
      return document.querySelector('[contenteditable="true"][role="textbox"]');
    }

    function composerText(el) {
      return String((el && (el.innerText || el.textContent)) || '');
    }

    /** Lexical 的序列化编辑器状态（纯数据，不需要它的节点工厂）。每行一个 paragraph。 */
    function lexicalState(text) {
      function para(line) {
        return {
          children: line === '' ? [] : [{ detail: 0, format: 0, mode: 'normal', style: '', text: line, type: 'text', version: 1 }],
          direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1, textFormat: 0,
        };
      }
      return {
        root: { children: String(text).split('\n').map(para), direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
      };
    }

    /**
     * 把文字写进输入框。返回用了哪条路（用于面板回执，也便于排障）。
     * @returns 'lexical' | 'insertText' | 'paste' | 'no-composer' | 'failed'
     */
    function writeToComposer(text) {
      var el = composerEl();
      if (el === null || el === undefined) return 'no-composer';
      try { el.focus(); } catch (e) { /* 焦点拿不到也要继续试 */ }
      var marker = text.slice(0, 12);

      /* ① 编辑器实例：输入框的真值在 Lexical 里，改 DOM 会被它冲掉 */
      var editor = el.__lexicalEditor;
      if (editor && typeof editor.setEditorState === 'function' && typeof editor.parseEditorState === 'function') {
        try {
          editor.setEditorState(editor.parseEditorState(JSON.stringify(lexicalState(text))));
          if (composerText(el).indexOf(marker) >= 0) return 'lexical';
        } catch (e) { /* 落到下一条 */ }
      }

      /* ② execCommand：contenteditable 的通用插入法，Lexical 会收到 beforeinput */
      try {
        if (typeof document.execCommand === 'function'
          && document.execCommand('insertText', false, text) !== false) {
          if (composerText(el).indexOf(marker) >= 0) return 'insertText';
        }
      } catch (e) { /* 落到下一条 */ }

      /* ③ 合成粘贴事件（有些环境 execCommand 被禁，但粘贴处理还在） */
      try {
        var dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        if (composerText(el).indexOf(marker) >= 0) return 'paste';
      } catch (e) { /* 落到下一条 */ }

      return 'failed';
    }

    /* ── 充值按钮 ─────────────────────────────────────────────
       浏览器这边拿不到 3090 桥的 token（只有宿主读得到），所以按钮不自己开页，
       而是往设置命名空间里写一个递增时间戳，宿主看到变大就去调 /app/open。 */

    /* ── 手填值的「本地回声」（v4.1.5）─────────────────────────
       点「确认」的那一刻，面板必须**立刻**显示用户刚填的数。
       为什么需要它：宿主处理这次提交要一次往返（写预览 → 单独取余额），而面板每秒才
       重画一次；没有回声的话，确认后那一次重画会拿**还没更新的快照**，于是先回跳成旧值、
       约 1 秒后才跳成新值 —— 用户原话：「谁家手动填值是这样来回跳的」。

       它不是第二份口径（不重算任何东西），只是"我刚填的那个数"：
       宿主一旦送上同值的预览（previewTopUp）或正式认领（appliedManual）就立刻撤销。
       兜底：超过 ECHO_TTL_MS 还没对上（例如写通道坏了）就不再装，回到宿主显示的值。 */
    var ECHO_TTL_MS = 6 * 60 * 1000;
    var topUpEcho = null;          /* { value, display, at }；value = 提交的原始值（-1 = 清除手动值） */

    function noteTopUpEcho(value, st) {
      var auto = (st === null || st === undefined) ? NaN : Number(st.autoTopUp);
      topUpEcho = {
        value: value,
        /* 清除手动值时它会变成"自动累计"，面板就显示那个数 */
        display: value >= 0 ? value : (Number.isFinite(auto) ? auto : 0),
        at: Date.now(),
      };
    }

    /** 回声还有效吗？（顺手处理"宿主已确认"与"超时"两种撤销） */
    function liveTopUpEcho(st) {
      if (topUpEcho === null) return null;
      var pv = previewOf(st);
      var applied = (st === null || st === undefined) ? NaN : Number(st.appliedManual);
      if ((pv !== null && Number(pv.topUp) === topUpEcho.display) || applied === topUpEcho.value) {
        topUpEcho = null;                       /* 宿主确认了，撤掉 */
        return null;
      }
      if (Date.now() - topUpEcho.at > ECHO_TTL_MS) {
        topUpEcho = null;                       /* 兜底：一直对不上就别装了 */
        return null;
      }
      return topUpEcho;
    }

    /* 请求时间戳必须**严格递增**：宿主只认「变大」，而 Date.now() 在极快连点
       （或同一次提交里写两个键）时会撞上同一个毫秒 —— 撞了这次请求就等于丢了。 */
    var lastStamp = 0;
    function nextStamp() {
      var t = Date.now();
      if (t <= lastStamp) t = lastStamp + 1;
      lastStamp = t;
      return t;
    }

    function requestTopUp() {
      var stamp = nextStamp();
      var sent = false;
      if (balScope !== null) {
        try {
          var pending;
          if (typeof balScope.mutate === 'function') {
            pending = balScope.mutate([{ op: 'set', path: ['openTopUp'], value: stamp }],
              balScope.getSnapshot().revision);
          } else if (typeof balScope.set === 'function') {
            pending = balScope.set('openTopUp', stamp);
          }
          if (pending && typeof pending.catch === 'function') pending.catch(function () {});
          sent = (typeof balScope.mutate === 'function' || typeof balScope.set === 'function');
        } catch (e) { sent = false; }
      }
      /* 通道不通才退回 WebView 自己处理：DSHA 没接管的话它就是个空操作，
         不会把界面导航走，所以这个兜底是安全的。 */
      if (!sent) {
        try { window.open(TOPUP_URL, '_blank'); } catch (e) { /* 什么都做不了就算了 */ }
      }
    }


    var C_PEAK = '#e5484d';        /* 红：失效 */
    var C_REST = '#2f9e6e';        /* 绿：正常 */
    var C_WARN = '#d99a1a';        /* 黄：存疑（可恢复） */
    var C_GRAY = '#8a8f98';        /* 灰：故障（永久） */

    /* 官方鲸鱼 logo：取自 DSH 自带前端素材 dsh-web-frontend/dist/favicon.svg 的 path。
       原文件里的 <style> 已去掉（内联会把 path 的样式泄漏到全页）。
       fill 固定为 DeepSeek 品牌蓝 #4D6BFE —— 鲸鱼是品牌标记，不随后面标题文字
       的档位颜色（峰红/谷绿）变化。13px 与 14px 标题字对齐。 */
    var DS_LOGO = '<svg viewBox="0 0 50 50" width="13" height="13" fill="#4D6BFE" aria-hidden="true" style="display:block"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"/></svg>';

    /* ── 单例守卫 ─────────────────────────────────────────────
       客户端模块有可能被加载两次（页面半热替换、或者行被挂了两遍），两个实例
       各插一个点，界面上就会并排出现两个指示灯。用一个所有权标记做交接：
       新实例上来就接管并清掉残留的 DOM，旧实例下一次 tick 发现自己不再是
       所有者，静默让位。 */
    var OWNER_KEY = '__dshPeakChipOwner';
    var ownerToken = NS + ':' + Date.now() + ':' + Math.random();

    function ownsIndicator() {
      try {
        var cur = window[OWNER_KEY];
        if (cur === ownerToken) return true;
        /* 所有权空着（上一个实例被卸载时释放了）→ 重新接管。
           少了这一步会出事：接管者 B 卸载后清掉自己的圆点并释放所有权，
           而让位的 A 仍在每个 tick 里早早 return —— 页面上就一个点都不剩了。 */
        if (cur === null || cur === undefined) {
          claimIndicator();
          return true;
        }
        return false;
      } catch (e) { return true; }
    }

    function claimIndicator() {
      try {
        window[OWNER_KEY] = ownerToken;
        var stale = document.querySelectorAll('[' + CHIP_ATTR + ']');
        for (var i = 0; i < stale.length; i++) {
          if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
        }
      } catch (e) { /* 拿不到 window：单实例场景本来也不需要这个 */ }
    }

    /* ── 样式 ───────────────────────────────────────────────── */

    function ensureStyles() {
      var css = [
        '[' + CHIP_ATTR + ']{display:inline-flex;align-items:center;gap:4px;',
        'height:22px;padding:0 9px;border-radius:11px;font-size:12px;line-height:1;',
        'white-space:nowrap;flex:none;cursor:pointer;background:transparent;font-family:inherit;}',
        '[' + CHIP_ATTR + '][data-in="tabs"]{margin-left:auto;align-self:center;',
        'justify-content:center;padding:0 8px;border:0;background:transparent;}',
        '[' + CHIP_ATTR + '][data-in="float"]{position:fixed;right:12px;bottom:84px;z-index:2147482000;',
        'background:rgba(24,28,48,.96);color:#e6ebff;box-shadow:0 4px 16px rgba(0,0,0,.45);}',
        '[' + CHIP_ATTR + '] .' + NS + '-dot{width:14px;height:14px;border-radius:50%;flex:none;display:inline-block;}',
        '.' + NS + '-card{position:fixed;z-index:2147483000;box-sizing:border-box;',
        'padding:10px 11px;border-radius:14px;background:#171a2e;color:#e6ebff;',
        'box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:12px;line-height:1.6;}',
        '.' + NS + '-card .' + NS + '-row{display:flex;justify-content:space-between;gap:10px;}',
        '.' + NS + '-card .' + NS + '-k{opacity:.6;flex:none;}',
        '.' + NS + '-card .' + NS + '-hr{border-top:1px solid rgba(255,255,255,.12);margin:9px 0 7px;}',
        '.' + NS + '-card .' + NS + '-price{display:flex;justify-content:space-between;gap:8px;',
        'font-variant-numeric:tabular-nums;padding-left:2px;}',
        '.' + NS + '-card .' + NS + '-m{opacity:.6;min-width:52px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.' + NS + '-card .' + NS + '-big{font-size:13px;font-weight:700;}',
        '.' + NS + '-card .' + NS + '-sub{opacity:.55;font-size:11.5px;}',
        '.' + NS + '-card .' + NS + '-btn{margin-top:9px;padding-top:8px;',
        'border-top:1px solid rgba(255,255,255,.12);text-align:center;font-weight:600;cursor:pointer;}',
        '.' + NS + '-card .' + NS + '-btn:active{opacity:.55;}',
        '.' + NS + '-card b{font-weight:600;}',
        /* 可点的那一行：虚线下划线 + 箭头，否则没人知道能点 */
        '.' + NS + '-card .' + NS + '-click{cursor:pointer;}',
        '.' + NS + '-card .' + NS + '-click .' + NS + '-k,',
        '.' + NS + '-card .' + NS + '-click .' + NS + '-v{text-decoration:underline dotted rgba(230,235,255,.45);',
        'text-underline-offset:3px;}',
        '.' + NS + '-card .' + NS + '-click:active{opacity:.6;}',
        '.' + NS + '-card .' + NS + '-caret{opacity:.5;flex:none;margin-left:4px;text-decoration:none;}',
        /* 手动改充值额度的输入框 */
        '.' + NS + '-card input[data-' + NS + '-input]{width:64px;box-sizing:border-box;',
        'padding:1px 5px;border-radius:6px;border:1px solid rgba(230,235,255,.4);',
        'background:rgba(255,255,255,.08);color:inherit;font:inherit;text-align:right;outline:none;}',
        '.' + NS + '-card .' + NS + '-edit{margin-top:6px;text-align:right;}',
        '.' + NS + '-card .' + NS + '-btn2{display:inline-block;padding:2px 9px;margin-left:6px;',
        'border-radius:8px;border:1px solid rgba(230,235,255,.35);cursor:pointer;font-weight:600;}',
        '.' + NS + '-card .' + NS + '-btn2:active{opacity:.55;}',
      ].join('');
      /* 按 id 复用，但内容不一样就就地改 —— 旧实例留下的旧 CSS 不能赖着不走 */
      var st = document.getElementById(NS + '-css');
      if (st !== null) {
        if (st.textContent !== css) st.textContent = css;
        return;
      }
      st = document.createElement('style');
      st.id = NS + '-css';
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    }

    /* ── 面板 ───────────────────────────────────────────────── */

    var panel = null;
    var refs = null;
    var lastPos = null;

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    function row(k, v, color) {
      var d = el('div', NS + '-row');
      d.style.gap = '6px';
      d.appendChild(el('span', NS + '-k', k));
      var b = el('span', null, v);
      b.style.textAlign = 'right';
      b.style.whiteSpace = 'nowrap';
      if (color) b.style.color = color;
      d.appendChild(b);
      return d;
    }

    function buildPanel(now) {
      var b = bjParts(now), ph = phaseOf(b), nx = nextSwitch(now);
      var color = ph.peak ? C_PEAK : C_REST;
      var idx = ph.peak ? 1 : 0;

      var root = el('div');
      root.id = NS + '-panel';
      root.className = NS + '-card';
      root.setAttribute('data-' + NS + '-panel', '1');

      /* 标题：官方 logo + 人格名 + 今天是什么日子。窄面板下不再挂右侧小标。 */
      var head = el('div');
      head.style.cssText = 'margin-bottom:6px;';
      var t1 = el('span');
      t1.style.cssText = 'display:inline-flex;align-items:center;gap:4px;'
        + 'font-size:14px;font-weight:600;color:' + color + ';white-space:nowrap;';
      t1.innerHTML = DS_LOGO;
      t1.appendChild(el('span', null, (ph.peak ? '梁文峰' : '梁文谷') + ' · ' + ph.why));
      head.appendChild(t1);
      root.appendChild(head);

      /* 实际价格（按当前会话正在用的模型）：命中 / 未命中 / 输出，元/百万 tokens。
         颜色即档位 —— 峰价红、谷价绿，所以不再另加一行文字说明。
         模型名用简写（DS-Flash），就能和价格并排放在一行。 */
      var pr = priceRows();
      for (var i = 0; i < pr.rows.length; i++) {
        var p = pr.rows[i];
        var line = el('div', NS + '-price');
        /* 说明挪进 title：手机上长按可见，屏幕上不再占行 */
        line.title = '元 / 百万 tokens：命中 / 未命中 / 输出';
        var nm = el('span', null,
          pr.model !== null && pr.rows.length === 1 ? shortModel(pr.model) : p.name);
        nm.style.cssText = 'opacity:.55;font-size:11.5px;white-space:nowrap;';
        var v = el('span', null, yuan(p.hit[idx]) + '/' + yuan(p.miss[idx]) + '/' + yuan(p.out[idx]));
        v.style.cssText = 'font-weight:600;color:' + color + ';font-variant-numeric:tabular-nums;white-space:nowrap;';
        line.appendChild(nm); line.appendChild(v);
        root.appendChild(line);
      }

      var hr = el('div', NS + '-hr');
      root.appendChild(hr);

      var rLeft = row('还有', '');
      root.appendChild(rLeft);

      var hr2 = el('div', NS + '-hr');
      root.appendChild(hr2);

      /* ── 计费区：主面板只留两个数 ──────────────────────────
         其余四个数点开详单看。不建对账块了 —— 面板越短越好。 */
      var st = hostStatus();
      var rSpent = el('div', NS + '-row ' + NS + '-click');
      rSpent.appendChild(el('span', NS + '-k', '本日消耗'));
      var spentWrap = el('span', null, '');
      spentWrap.style.cssText = 'text-align:right;white-space:nowrap;font-size:13px;font-weight:700;';
      var spentVal = el('span', NS + '-v', spentText(st));
      if (color) spentVal.style.color = color;
      spentWrap.appendChild(spentVal);
      spentWrap.appendChild(el('span', NS + '-caret', '›'));
      rSpent.appendChild(spentWrap);
      rSpent.title = hostHint(st) + '；点开看详单';
      rSpent.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (detail !== null) closeDetail(); else openDetail();
      });
      var rBal = row('余额', balanceText(st));
      rBal.title = hostHint(st);
      rBal.lastChild.className = NS + '-big';
      root.appendChild(rSpent); root.appendChild(rBal);

      /* 最后一行：充值。点了不在这里付钱，只是把官方充值页交给系统浏览器。 */
      var topBtn = el('div', NS + '-btn', '充值');
      topBtn.title = '在浏览器里打开官方充值页 ' + TOPUP_URL;
      topBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        requestTopUp();
      });
      root.appendChild(topBtn);

      root.style.border = '1px solid ' + color + '55';
      if (lastPos) {
        root.style.left = lastPos.left + 'px';
        root.style.top = lastPos.top + 'px';
        root.style.width = lastPos.width + 'px';
      }

      refs = {
        peak: ph.peak,
        left: rLeft.lastChild,
        spent: spentVal,
        spentRow: rSpent,
        bal: rBal.lastChild
      };
      return root;
    }

    /* 只更新会变的文字，不重建整块 DOM —— 否则点击可能落在被替换掉的节点上 */
    function refreshPanel(now) {
      if (!panel || !refs) return;
      var b = bjParts(now), ph = phaseOf(b), nx = nextSwitch(now);
      if (ph.peak !== refs.peak) {
        var fresh = buildPanel(now);
        panel.parentNode.replaceChild(fresh, panel);
        panel = fresh;
        return;
      }
      refs.left.textContent = nx ? fmtDur(nx.inMs) : '—';
      var st = hostStatus();
      refs.spent.textContent = spentText(st);
      refs.bal.textContent = balanceText(st);
      refs.spentRow.title = hostHint(st) + '；点开看详单';
      refs.bal.title = hostHint(st);
      refreshDetail(st);
    }

    /* ── 详单 ─────────────────────────────────────────────────
       点主面板的「本日消耗」展开。四个数全部来自宿主，这里只负责显示；
       唯一会写回去的是「充值额度」的手动修正。

       ⚠️ 这里刻意**每次刷新都重建四行**，而不是抓住四个 span 反复改文字。
       之前那版持有节点引用，实测出现过「注释行更新了、但三个值行还是空的」——
       引用和屏幕上显示的节点不是同一批，且完全静默。重建几行 DOM 的成本可以忽略，
       换来的是不可能再出现这种幽灵状态。
       编辑充值额度时用 editing 标志挡住重建，否则输入框会被冲掉。 */

    var detail = null;
    var drefs = null;

    /** 两位小数；拿不到数字给一个显眼的 ?（不是 — ，那个太容易被漏看）。 */
    function txt2(v) {
      return Number.isFinite(v) && v >= 0 ? (Math.round(v * 100) / 100).toFixed(2) : '?';
    }

    /** 充值额度是整数；拿不到给 ?。 */
    function txtInt(v) {
      return Number.isFinite(v) && v >= 0 ? String(Math.round(v)) : '?';
    }

    function detailRow(k, v, hint, clickable, color) {
      var d = el('div', NS + '-row');
      d.appendChild(el('span', NS + '-k', k));
      var val = el('span', NS + '-v', v);
      val.style.cssText = 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;'
        + (color ? 'color:' + color + ';font-weight:600;' : '');
      if (clickable) {
        /* 值 + 箭头包一层再放进去。直接当第三个子元素的话，
           `justify-content:space-between` 会把中间那个（也就是值）推到面板正中，
           而不是右对齐 —— v4.0.1 的「11」看着就是浮在中间。 */
        d.className += ' ' + NS + '-click ' + NS + '-topup';
        var wrap = el('span', null, '');
        wrap.style.cssText = 'text-align:right;white-space:nowrap;';
        wrap.appendChild(val);
        wrap.appendChild(el('span', NS + '-caret', '›'));
        d.appendChild(wrap);
      } else {
        d.appendChild(val);
      }
      if (hint) d.title = hint;
      return d;
    }

    var HINT_L = '本地审计：按本机上报的 token（含上下文压缩）乘官方峰谷价目算出来的钱。保留两位小数。';
    var HINT_DF = '本日第一次查到的账号余额 —— 账号口径的一天从这里开始，跨日重取。';
    var HINT_B = '刚刚查到的账号余额。余额是账号级的，别的客户端花的是同一个余额。';
    var HINT_T = '今日充值依据余额变动猜测。点这一行可以手动改；改完之后自动识别到的充值会在你填的数上继续累加。' +
      '填完点确认，这一行立刻显示你填的数（带 *），同时请宿主单独取一次余额更新其余几行；' +
      '下一轮正式记账时星号消失、换成定稿值。留空 = 清除手动值，回到自动。';
    var HINT_O = '无法审计：同一账号上**别的客户端**花掉的部分 —— 余额是账号级的，而本地审计只算这一台设备。' +
      '在电脑上干活、在别的设备上跑 agent，都会记在这里。它不是故障。'
    var HINT_E = '本地审计**高出**账号推算的部分（E = max(0, Λ − S)）。账号总共花的钱' +
      '不可能少于本机花的，所以这一段只可能是本机多算（重复计费、定价档算错）或余额还没扣到。' +
      '  \n\n三档：黄「存疑」E ≥ 0.6（可恢复）；红「失效」E > 1.2（当天锁存，跨日复位）；' +
      '灰「故障」连续三天都红（永久，只能靠升级插件清除）。三档都要求连续 3 窗，' +
      '黄的回落到 0.4 以下才解除。' +
      '  \n\n⚠️ 这个灯的前提是**今日充值已按实付核对**：充值识别错误属于预期内、不可解，' +
      '由手动修正兜底，不算失效。出现红灯先核对「今日充值」，改对了还红才是真出问题。';

    function buildDetail() {
      var root = el('div');
      root.id = NS + '-detail';
      root.className = NS + '-card';
      root.setAttribute('data-' + NS + '-panel', '1');

      var title = el('div', null, '本日详单 · v4');
      title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:6px;';
      root.appendChild(title);

      var body = el('div');
      body.className = NS + '-dbody';
      root.appendChild(body);

      var note = el('div', NS + '-sub', '');
      note.style.cssText = 'margin-top:7px;line-height:1.5;';
      root.appendChild(note);

      /* ── 一键维修（大红按钮）────────────────────────────────
         位置：**最底下**，在误差那行的解释文字下面 —— 看完全部数字与判断，最后才是"动手修"。
         挂在 root 上而不是每次刷新都重建的 dbody：否则每秒重画一次，按钮会闪、也点不稳。
         触控目标按手机来：宽度拉满、高度 ≥44px、白字红底。 */
      var repair = el('button', NS + '-repair', '一键维修');
      repair.type = 'button';
      repair.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:12px 0 2px;'
        + 'padding:14px 12px;min-height:48px;font-size:16px;font-weight:700;letter-spacing:1px;'
        + 'color:#fff;background:' + C_PEAK + ';border:0;border-radius:9px;'
        + 'box-shadow:0 3px 10px rgba(229,72,77,.38);cursor:pointer;-webkit-tap-highlight-color:transparent;';
      repair.title = '把一段指路消息填进下面的输入框（**不自动发送**）：让 agent 读本插件目录里的'
        + ' 维修手册.md 按手册来修。你可以在发送前改它，或干脆不发。';
      repair.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        onRepairClick();
      });
      root.appendChild(repair);

      /* 事件委托：body 里的行每次刷新都重建，处理器必须挂在不重建的 body 上 */
      body.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var t = ev.target;
        while (t !== null && t !== undefined && t !== body) {
          if (t.className && String(t.className).indexOf(NS + '-topup') >= 0) {
            beginEditTopUp();
            return;
          }
          t = t.parentNode;
        }
      });

      /* ⚠️ 详单比主面板宽，**不能沿用它 left**：v4.0.0/4.0.1 就是这么写的，
         结果 180 宽的主面板在 left=199，250 宽的详单右边跑到 449 —— 屏幕只有 400，
         数值那一整列（右对齐）全在屏幕外，看起来像"三行是空的"。
         正确做法：与主面板**右边缘对齐**，并把宽度钳到一定放得下。 */
      if (lastPos) {
        var innerW = window.innerWidth || 360;
        var want = Math.max(lastPos.width, Math.min(260, innerW - 16));
        var rightEdge = lastPos.left + lastPos.width;
        var left = Math.max(8, Math.min(rightEdge - want, innerW - 8 - want));
        root.style.left = left + 'px';
        root.style.width = want + 'px';
      }
      drefs = { body: body, note: note, editing: false };
      return root;
    }

    function openDetail() {
      if (detail !== null) return;
      detail = buildDetail();
      document.body.appendChild(detail);
      /* 贴在主面板下面；放不下就翻到上面去 */
      var pr = panel ? panel.getBoundingClientRect() : null;
      if (pr) {
        var h = detail.getBoundingClientRect().height || 160;
        var top = pr.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, pr.top - h - 6);
        detail.style.top = top + 'px';
      }
      refreshDetail(hostStatus());
    }

    function closeDetail() {
      if (detail && detail.parentNode) detail.parentNode.removeChild(detail);
      detail = null; drefs = null;
    }

    function refreshDetail(st) {
      if (detail === null || drefs === null) return;
      if (drefs.editing) return;                 /* 正在输入，别把输入框冲掉 */
      var has = st !== null && st !== undefined;
      var L = has ? Number(st.localToday) : NaN;
      /* V 自己不再显示（拆成下面两行端点），但缺字段检查仍然认它 */
      var V = has ? Number(st.balanceDelta) : NaN;
      var T = has ? Number(st.topUpTotal) : NaN;
      var E = has ? Number(st.residual) : NaN;

      var body = drefs.body;
      while (body.firstChild) body.removeChild(body.firstChild);
      var O = has ? Number(st.otherSpent) : NaN;
      var DF = has ? Number(st.dayFirstBalance) : NaN;
      var B = has ? Number(st.balance) : NaN;
      var sym = has ? curSym(st) : '';
      var money = function (v) { return Number.isFinite(v) && v >= 0 ? sym + money2(v) : '—'; };
      /* 提交预览：手填值刚提交、正常窗还没跑时，这几个数先用宿主单独采样算出来的预览值
         顶替（只影响显示）。星号 = 预览，下一窗覆盖。 */
      var pv = previewOf(st);
      var pvOk = pv !== null && pv.sampled;
      var mark = pvOk ? STAR : '';
      body.appendChild(detailRow('本地审计', txt2(L), HINT_L, false));
      /* 余额那行不再显示「变动值」这一个差值，改成它的两个端点 ——
         一个带正负号的差值很容易被读成「出错了」，两个余额摆在一起，差额自己一减就清楚。 */
      body.appendChild(detailRow('本日首次观测余额',
        money(pvOk ? pv.dayFirst : DF) + mark, HINT_DF, false));
      body.appendChild(detailRow('当前余额', money(pvOk ? pv.balance : B) + mark, HINT_B, false));
      /* 让"自动识别了多少 / 你手填了多少"一眼可见 —— 这是唯一能发现
         "我今天没充钱，它自己认了 6 元"的地方（详见 计费算法说明 §7.2 的盲区）。 */
      var autoT = has ? Number(st.autoTopUp) : NaN;
      var manualT = has ? Number(st.manualTopUp) : NaN;
      var split = '';
      if (Number.isFinite(autoT) || Number.isFinite(manualT)) {
        split = '  当前：自动识别累计 ' + (Number.isFinite(autoT) ? num2(autoT) : '?') +
          ' 元 · 手填 ' + (Number.isFinite(manualT) && manualT >= 0 ? num2(manualT) : '（无）') + ' 元';
      }
      /* 手填值的来源优先级（v4.1.5）：
           ① 本地回声（我刚点的确认）—— 优先级最高，保证"填多少就是多少"；
           ② 宿主预览（单独采样算出来的）；
           ③ 宿主正式值。
         前两者都带星号，并且**不会先回跳成旧值**。 */
      var echo = liveTopUpEcho(st);
      var tText;
      var tMark = '';
      if (echo !== null) {
        tText = txtInt(echo.display);
        tMark = STAR;
        split += '  已提交，正在确认（' + STAR + '）';
      } else if (pv !== null) {
        tText = txtInt(pv.topUp >= 0 ? pv.topUp : T);
        tMark = STAR;
        split += '  已提交，等下一窗确认（' + STAR + '）';
      } else {
        tText = txtInt(T);
      }
      body.appendChild(detailRow('今日充值', tText + tMark, HINT_T + split, true));
      /* 无法审计：账号级余额与本机审计的差额。放在误差上面 ——
         它先解释了「为什么对不上」，误差那行才不会被误读成故障。 */
      body.appendChild(detailRow('无法审计',
        txt2(pvOk ? pv.otherSpent : O) + mark, HINT_O, false));
      /* 误差不显示具体值，只显示当日锁存的状态：正常（绿）/ 失效（红）。
         级别由宿主维护（alertLevel）—— 面板没打开的时候它也在盯着；
         这里兜一层：万一还没拿到那个字段，就按当前值现算（只是当次，不锁存）。 */
      /* 只认宿主给的锁存位。不拿当前 E 自己判 —— 宿主要求连续 3 窗越线，
         客户端看到的是瞬时值，自己判会抢跑（单窗尖峰就变红）。 */
      /* 三档告警（口径见 lib/index.js 的 accountDay 与 计费算法说明.md §7.2）：
           none 正常 / yellow 存疑（可恢复）/ red 失效（当日锁存）/ gray 故障（永久）
         ⚠️ 只认宿主给的级别，客户端**不**拿瞬时 E 自己判 —— 宿主要求连续 3 窗，
            客户端看到的是瞬时值，自己判会抢跑（单窗尖峰就变红）。 */
      var LEVEL_TEXT = { none: '正常', yellow: '存疑', red: '失效', gray: '故障' };
      var LEVEL_COLOR = { yellow: C_WARN, red: C_PEAK, gray: C_GRAY };
      var level = has && typeof st.alertLevel === 'string' ? st.alertLevel : 'none';
      var latched = level === 'red' || level === 'gray';
      var errText = Number.isFinite(E) ? (LEVEL_TEXT[level] || '正常') : '?';
      var errColor = Number.isFinite(E) ? (LEVEL_COLOR[level] || C_REST) : null;
      body.appendChild(detailRow('误差', errText, HINT_E, false, errColor));

      /* 任何一个值拿不到，就把**缺了哪个字段**直接写出来 ——
         不要再出现「行是空的、没人知道为什么」（v4.0.0 线上就发生过）。 */
      var missing = [];
      if (!Number.isFinite(L)) missing.push('localToday');
      if (!Number.isFinite(V)) missing.push('balanceDelta');
      if (!Number.isFinite(T)) missing.push('topUpTotal');
      if (!Number.isFinite(O)) missing.push('otherSpent');
      if (!Number.isFinite(E)) missing.push('residual');
      if (missing.length > 0) {
        drefs.note.textContent = '宿主还没送全数字：缺 ' + missing.join('、') +
          '（快照 ' + (has ? Object.keys(st).length + ' 个字段' : '拿不到') + '）';
        return;
      }
      /* 数值不显示，所以「该往哪边手动改」只能靠方向提示 —— 失效时才给，正常时不打扰。 */
      /* 版面文字固定成这两句 —— 会随时间变的那几条（失效原因、方向、待确认）
         挪到长按提示里：信息不丢，但底部不再每轮跳字。 */
      var live = (repairMsg !== null && Date.now() - repairMsg.at < 8000) ? repairMsg : null;
      var base = (pv === null ? '' : STAR + ' 预览：'
        + (pv.sampled ? '提交手填值后单独查了一次余额' : '手填值已提交、余额还没取到')
        + '，下一窗正式记账会覆盖。')
        + '今日充值依据余额变动猜测。出现误差请手动调整。';
      drefs.note.textContent = base + (live === null ? '' : '\n' + live.text);

      var notes = sideNotes(st);
      var pend = has ? Number(st.pendingTopUp) : 0;
      var extra = [];
      if (level === 'gray') extra.push('灰色·故障：连续 3 个自然日都触发过红 → 判为永久失效（如官方改了计费规则）。只能靠升级插件清除');
      else if (level === 'red') extra.push('红色·失效：当日锁存，跨日复位。先核对「今日充值」——改对了还红才是真问题');
      else if (level === 'yellow') extra.push('黄色·存疑：可恢复，误差回落到 0.4 以下即解除');
      else extra.push('正常：误差连续 3 窗 ≥ 0.6 变黄、> 1.2 变红；连续 3 天红变灰');
      if (live !== null) {
        extra.push(live.text);
        extra.push('将发给 agent 的原文：' + live.detail);
      }
      if (pv !== null) {
        extra.push(STAR + ' 预览值：' + (pv.sampled
          ? '提交后单独取余额于 ' + (pv.sampleAt > 0 ? new Date(pv.sampleAt).toLocaleTimeString() : '—')
          : '这次没取到余额（只有充值那行是新的）')
          + '，下一窗正式记账时清掉');
      }
      if (Number.isFinite(pend) && pend > 0) {
        extra.push('刚识别到一笔约 ' + pend + ' 元的充值（已先计入今日充值），下一轮确认后定稿');
      }
      for (var i = 0; i < notes.length; i += 1) extra.push(notes[i]);
      drefs.note.title = extra.join('；');
    }

    /** 就地变出输入框。别用 window.prompt：WebView 里可能被拦、样式也不可控。 */
    function beginEditTopUp() {
      if (detail === null || drefs === null || drefs.editing) return;
      var row = drefs.body.querySelector('.' + NS + '-topup');
      if (row === null || row.children.length < 2) return;
      var val = row.children[1];
      var st = hostStatus();
      var cur = (st !== null && Number(st.topUpTotal) >= 0) ? String(Math.round(Number(st.topUpTotal))) : '';
      var input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = cur;
      input.setAttribute('data-' + NS + '-input', '1');
      val.textContent = '';
      val.appendChild(input);
      drefs.editing = true;
      var done = false;
      function finish(raw) {
        if (done) return;
        done = true;
        /* 先解除 editing，commitTopUp 里的 refreshDetail 就会重建这四行、
           连同输入框一起换掉 —— 修掉「编辑一次后输入框永远留着」那个 bug。 */
        drefs.editing = false;
        commitTopUp(raw);
      }
      input.addEventListener('click', function (e) { e.stopPropagation(); });
      input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') finish(input.value);
        else if (e.key === 'Escape') { done = true; if (drefs) drefs.editing = false; refreshDetail(hostStatus()); }
      });
      input.addEventListener('blur', function () { finish(input.value); });
      try { input.focus(); input.select(); } catch (e) { /* 无所谓 */ }
    }

    /**
     * 提交手动充值额度。
     * 空 / 非法 / 负数 → 视为「清除手动值」，回到自动（宿主用 -1 表示这个意思）。
     */
    function commitTopUp(raw) {
      var text = String(raw === undefined || raw === null ? '' : raw).trim();
      var value = -1;
      if (text !== '') {
        var n = Number(text);
        if (!Number.isFinite(n) || n < 0) { refreshDetail(hostStatus()); return; }
        value = Math.round(n);
      }
      var accepted = false;
      if (balScope !== null) {
        try {
          var pending;
          /* 一次提交两个键：手填值 + 「立刻取一次余额做预览」的时间戳。
             合成同一次 mutate，免得第二个请求拿着过期 revision 写失败
             （宿主那边只认时间戳变大，见 lib/index.js 的 previewNow）。 */
          var ops = [
            { op: 'set', path: ['manualTopUp'], value: value },
            { op: 'set', path: ['previewNow'], value: nextStamp() },
          ];
          if (typeof balScope.mutate === 'function') {
            pending = balScope.mutate(ops, balScope.getSnapshot().revision);
            accepted = true;
          } else if (typeof balScope.set === 'function') {
            pending = balScope.set('manualTopUp', value);
            if (pending && typeof pending.catch === 'function') pending.catch(function () {});
            pending = balScope.set('previewNow', nextStamp());
            accepted = true;
          }
          if (pending && typeof pending.catch === 'function') {
            /* 写失败：撤掉回声，否则面板会一直显示一个宿主根本没收到的数 */
            pending.catch(function () { topUpEcho = null; refreshDetail(hostStatus()); });
          }
        } catch (e) { accepted = false; /* 写不进去就只刷新显示 */ }
      }
      /* 写已发出 → 立刻回显用户填的数（这一步不依赖任何宿主往返） */
      if (accepted) noteTopUpEcho(value, hostStatus());
      refreshDetail(hostStatus());
    }

    /* 点完按钮的回执：显示 8 秒（refreshDetail 每秒会重写底部小字，所以放在变量里让它拼） */
    var repairMsg = null;

    /** 拼这次的提示词：固定四句 + 当前面板状态（给 agent 的现成证据）。 */
    function repairPromptText() {
      var st = hostStatus();
      var pv = previewOf(st);
      var bits = [];
      bits.push('当前面板：' + (st === null ? '拿不到状态快照'
        : '本日消耗 ' + (Number.isFinite(Number(pv && pv.sampled ? pv.todaySpent : Number(st.todaySpent)))
          ? (curSym(st) + money2(Number(pv && pv.sampled ? pv.todaySpent : Number(st.todaySpent)))) : '—')
          + '、余额 ' + (Number.isFinite(Number(pv && pv.sampled ? pv.balance : Number(st.balance)))
            ? (curSym(st) + money2(Number(pv && pv.sampled ? pv.balance : Number(st.balance)))) : '—')
          + '、告警档 ' + String(st.alertLevel || 'none')));
      return repairPrompt(st) + '\n\n' + bits.join('\n');
    }

    function onRepairClick() {
      var text = repairPromptText();
      var how = writeToComposer(text);
      var label = {
        lexical: '已填入输入框（编辑器通道）—— 看一眼再按发送',
        insertText: '已填入输入框（execCommand 通道）—— 看一眼再按发送',
        paste: '已填入输入框（粘贴通道）—— 看一眼再按发送',
        'no-composer': '没找到输入框：长按本行可看到该发给 agent 的话，手动复制即可',
        failed: '输入框在，但三条写入通道都没成 —— 长按本行手动复制',
      }[how] || ('写入结果未知：' + how);
      repairMsg = { text: '🛠 ' + label, detail: text, at: Date.now() };
      refreshDetail(hostStatus());
    }

    function closePanel() {
      closeDetail();                       /* 详单是挂在面板上的，面板关了它也跟着走 */
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null; refs = null;
    }

    function openPanel(anchor, now) {
      var r = anchor.getBoundingClientRect();
      var W = Math.min(180, window.innerWidth - 20);
      var left = Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8);
      var H = 340;
      var top = r.bottom + 6;
      if (top + H > window.innerHeight) top = Math.max(8, window.innerHeight - H - 8);
      lastPos = { left: left, top: top, width: W };
      closePanel();
      panel = buildPanel(now);
      document.body.appendChild(panel);
      refreshPanel(now);
    }

    /* ── 指示灯 ─────────────────────────────────────────────
       不点击时只有一个小圆点：绿 = 空闲、红 = 高峰。峰/谷、倒计时这些
       信息都在点开的面板里，折叠状态下不占地方。 */

    var chip = null;

    function ensureChip() {
      if (chip) return chip;
      var e = document.createElement('button');
      e.type = 'button';
      e.setAttribute(CHIP_ATTR, '1');
      e.title = 'DeepSeek 峰谷（点击看详情）';
      e.appendChild(el('span', NS + '-dot'));
      e.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (panel) { closePanel(); return; }
        openPanel(e, Date.now());
      });
      chip = e;
      return e;
    }

    /* 找「对话 / 轨迹」那一行。三级策略，逐级放宽 —— 出货结构一变也能命中。 */
    function findTabsRow() {
      var corner = document.querySelector(CORNER_SEL);
      if (corner && corner.parentElement) {
        var r1 = corner.parentElement.querySelector('[role="tablist"]');
        if (r1) return r1;
      }
      var all = document.querySelectorAll('[role="tablist"]');
      for (var i = 0; i < all.length; i++) {
        var t = all[i].textContent || '';
        if (t.indexOf('对话') >= 0 || t.indexOf('轨迹') >= 0 ||
            t.indexOf('Chat') >= 0 || t.indexOf('Trajectory') >= 0) return all[i];
      }
      if (all.length === 1) return all[0];
      return null;
    }

    function tick() {
      if (!ownsIndicator()) return;      /* 已被新实例接管，让位 */
      ensureStyles();
      var now = Date.now();
      var b = bjParts(now), ph = phaseOf(b), nx = nextSwitch(now);
      var color = ph.peak ? C_PEAK : C_REST;

      var e = ensureChip();

      var rowEl = findTabsRow();
      var inTabs = rowEl !== null;
      if (inTabs) {
        if (e.parentNode !== rowEl) rowEl.appendChild(e);
        if (e.getAttribute('data-in') !== 'tabs') e.setAttribute('data-in', 'tabs');
      } else {
        /* 找不到那一行（出货结构变了、或还在新会话 Hero 页）→ 浮到右下角，
           这样"插件根本没跑"和"锚点没找对"就能一眼区分开。 */
        if (e.parentNode !== document.body) document.body.appendChild(e);
        if (e.getAttribute('data-in') !== 'float') e.setAttribute('data-in', 'float');
      }

      /* 只有圆点会变：颜色就是全部信息。两种形态都显式写全，免得复用到的
         旧元素残留着上一次的行内样式（那个"带框胶囊"就是这么来的）。
         浮到右下角时保留深色底，否则一个孤零零的点在页面上没人看得见。 */
      e.childNodes[0].style.background = color;
      if (inTabs) {
        e.style.border = 'none';
        e.style.background = 'transparent';
        e.style.color = 'inherit';
      } else {
        e.style.border = '1px solid ' + color + '66';
        e.style.background = 'rgba(24,28,48,.96)';
        e.style.color = '#e6ebff';
      }
      e.setAttribute('aria-label', 'DeepSeek 当前' + (ph.peak ? '高峰' : '空闲') +
        (nx ? '，' + fmtDur(nx.inMs) + '后切换' : '') + '，点击看详情');

      refreshPanel(now);
    }

    /* ── 生命周期 ───────────────────────────────────────────── */

    var inject = [];

    /* ── 读当前会话的投影 ─────────────────────────────────────
       官方模型选择器就是这么读的（见 @deepseek-ai/dsh-client-ui-model-selection）：
         ctx.sessions.binding(id).session.projections.faceOf('modelSelection')
       计费再读同一个注册表里的 'tokenUsage'（由 dsh-token-meter 提供）。
       用 ctx.get 惰性取 sessions 服务：拿不到也不影响插件激活，只是退回
       "两个模型都列、不显示花费"。每次 tick 都重读，所以切模型/切会话会自动跟上。 */
    var sctx = null;
    var sessionsSvc = null;

    function modelSvc() {
      if (sessionsSvc === null && sctx !== null) {
        var s = sctx.get('sessions');
        if (s !== undefined) sessionsSvc = s;
      }
      return sessionsSvc;
    }

    /* 当前会话 id */
    function currentId() {
      try {
        var s = modelSvc();
        if (s === null || s.list === undefined) return null;
        var ls = s.list.getSnapshot();
        var id = (ls === null || ls === undefined) ? undefined : ls.current;
        return (id === undefined || id === null) ? null : String(id);
      } catch (e) { return null; }
    }

    /* 取某个会话投影的当前值（modelSelection / tokenUsage 同一条路） */
    function projSnap(key) {
      try {
        var s = modelSvc();
        var id = currentId();
        if (s === null || id === null) return null;
        var b = s.binding(id);
        if (b === undefined || b === null) return null;
        var proj = b.session.projections.faceOf(key);
        if (proj === undefined || proj.getSnapshot === undefined) return null;
        return proj.getSnapshot();
      } catch (e) { return null; }
    }

    function readModel() {
      /* 投影真实形状（见 dsh-client-connection 的 modelSelectionProjectionOf）：
           { lastUsed, next }，两者都是 { provider, model, reasoningEffort } | null；
         next = 待生效的选择 ?? 上次实际使用的选择 —— 就是当前生效的那个。 */
      var snap = projSnap('modelSelection');
      if (snap === null || snap === undefined) return null;
      var cur = snap.next || snap.lastUsed
        || (snap.modelSelection ? (snap.modelSelection.next || snap.modelSelection.lastUsed) : null);
      return (cur !== null && cur !== undefined && cur.model) ? String(cur.model) : null;
    }

    /* 认得出模型就只列它；认不出就两个都列（保守但永远正确） */
    function priceRows() {
      var m = readModel();
      if (m === null) return { rows: PRICES, model: null };
      var low = m.toLowerCase();
      for (var i = 0; i < PRICES.length; i++) {
        if (low.indexOf(PRICES[i].match) >= 0) return { rows: [PRICES[i]], model: m };
      }
      return { rows: PRICES, model: m };
    }

    function apply(ctx) {
      sctx = ctx;
      claimIndicator();
      ensureStyles();
      var timer = setInterval(tick, 1000);
      tick();

      var onDocDown = function (ev) {
        if (!panel) return;
        var t = ev.target;
        if (t && t.closest && t.closest('[data-' + NS + '-panel]')) return;
        if (chip && (t === chip || (t && chip.contains && chip.contains(t)))) return;
        closePanel();
      };
      document.addEventListener('pointerdown', onDocDown, true);

      ctx.effect(function () {
        return function () {
          clearInterval(timer);
          document.removeEventListener('pointerdown', onDocDown, true);
          closePanel();
          if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
          chip = null;
          /* 只有还握着所有权时才收尾：已经被新实例接管的话，DOM 和样式表归它，
             这里再删就把新实例的指示灯一起弄没了。 */
          if (ownsIndicator()) {
            var st = document.getElementById(NS + '-css');
            if (st && st.parentNode) st.parentNode.removeChild(st);
            try { window[OWNER_KEY] = null; } catch (e) { /* 无所谓 */ }
          }
        };
      }, NS + ': cleanup');
    }

    exports.name = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
