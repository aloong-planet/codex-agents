// In-memory model for reviewing Penny's private bookkeeping interactions.
// No transport, file parser, model, credentials, or real financial state is used.
(function () {
  /** @typedef {'ready'|'needs_details'|'awaiting_confirmation'|'committed'|'cancelled'|'rejected'} Status */
  const TERMINAL = new Set(['committed', 'cancelled', 'rejected']);
  const STATUS_NAMES = { ready: '待写入', needs_details: '待补充', awaiting_confirmation: '待确认', committed: '已完成', cancelled: '已取消', rejected: '已拒绝' };
  const ALL_ACTIONS = ['post', 'confirm', 'choose_personal', 'choose_business', 'fill_amount', 'cancel', 'duplicate_delivery', 'foreign_sender'].map(type => ({ type }));
  const seed = () => [
    { id: 'P001', book: 'personal', kind: 'income', cents: 800000, date: '2026-11-02', item: '工资', source: 'salary-demo', revision: 1, active: true },
    { id: 'P002', book: 'personal', kind: 'expense', cents: 3500, date: '2026-11-06', item: '午饭', source: 'wx-lunch-demo', revision: 1, active: true },
    { id: 'B001', book: 'business', kind: 'income', cents: 120000, date: '2026-11-05', item: '商品销售到账', source: 'sale-demo', revision: 1, active: true },
  ];
  const money = cents => (cents / 100).toFixed(2);
  const bookName = book => book === 'business' ? '经营账' : '个人账';
  const say = (who, text) => ({ who, text });
  function totals(entries, book) {
    const selected = entries.filter(row => row.active && row.book === book);
    const income = selected.filter(row => row.kind === 'income').reduce((sum, row) => sum + row.cents, 0);
    const expense = selected.filter(row => row.kind === 'expense').reduce((sum, row) => sum + row.cents, 0);
    return { count: selected.length, income, expense, net: income - expense };
  }
  function report(entries, book) {
    const sum = totals(entries, book);
    return `${bookName(book)} · 2026 年 11 月\n收入 ¥${money(sum.income)}\n支出 ¥${money(sum.expense)}\n结余 ¥${money(sum.net)}\n共 ${sum.count} 笔有效记录。仅统计已入账记录；另一账本单独核算。`;
  }
  function preview(state) {
    const rows = state.rows.map((row, index) => `${index + 1}. ${row.date} · ${row.item} · ${row.kind === 'income' ? '收入' : '支出'} ¥${money(row.cents)}`).join('\n');
    return `入账预览 · ${bookName(state.book)}\n${rows}\n${state.skipped ? `另有 ${state.skipped} 笔已入账交易，已排除。\n` : ''}尚未入账。请确认，或先更改账本；回复“取消”放弃本次导入。`;
  }
  /** Create one isolated scenario, including its explicitly fictitious starting ledger. */
  function initial(mode) {
    const state = { mode, status: 'ready', illegal: null, book: 'personal', entries: seed(), rows: [], skipped: 0, messages: [], audit: [], received: 0, total: 1 };
    if (mode === 'text') {
      state.rows = [{ date: '2026-11-06', kind: 'expense', cents: 1800, item: '咖啡', source: 'text-coffee-demo' }];
      state.messages = [say('你', '记一笔：今天咖啡 18 元。')];
    } else if (mode === 'file') {
      state.status = 'awaiting_confirmation'; state.skipped = 1;
      state.rows = [
        { date: '2026-11-06', kind: 'expense', cents: 5800, item: '买菜', source: 'wx-grocery-demo' },
        { date: '2026-11-06', kind: 'expense', cents: 1200, item: '交通', source: 'wx-transport-demo' },
      ];
      state.messages = [say('你', '导入这份微信账单。'), say('Penny', preview(state))];
    } else if (mode === 'screenshot') {
      state.status = 'needs_details';
      state.rows = [{ date: '2026-11-06', kind: 'expense', cents: null, item: '餐饮', source: 'screenshot-demo' }];
      state.messages = [say('你', '帮我记下这张支付截图。'), say('Penny', '截图里的付款金额看不清。请告诉我准确金额；补齐后我会给你入账预览，目前还没有记账。')];
    } else if (mode === 'correct') {
      state.rows = [{ id: 'P002', cents: 3200 }];
      state.messages = [say('你', '把 P002 午饭金额从 35 元改成 32 元。')];
    } else if (mode === 'void') {
      state.status = 'awaiting_confirmation';
      state.messages = [say('你', '撤销 P002。'), say('Penny', '将撤销个人账 P002：11 月 6 日午饭支出 ¥35.00。撤销后不计入收支，历史修改记录保留。确认撤销吗？')];
    } else if (mode === 'summary') {
      state.status = 'committed'; state.received = 1;
      state.messages = [say('你', '这个月个人账的收入和开销是多少？'), say('Penny', report(state.entries, 'personal'))];
    } else if (mode === 'private_boundary') {
      state.status = 'rejected'; state.entries = []; state.book = null;
      state.messages = [say('验证说明', '模拟群聊或非本人消息。服务拒绝读取和写入账本，不发送财务回复。')];
    }
    return state;
  }
  function commit(state, confirmation) {
    const next = structuredClone(state);
    if (confirmation) next.messages.push(say('你', state.mode === 'void' ? '确认撤销。' : '确认入账。'));
    if (state.mode === 'correct') {
      const row = next.entries.find(item => item.id === 'P002');
      next.audit.push({ id: row.id, oldCents: row.cents, newCents: 3200 });
      row.cents = 3200; row.revision += 1;
      next.messages.push(say('Penny', '已更正 P002：午饭支出 ¥35.00 → ¥32.00。修改历史已保留，本月个人账支出已更新为 ¥32.00。'));
    } else if (state.mode === 'void') {
      const row = next.entries.find(item => item.id === 'P002');
      row.active = false; row.revision += 1;
      next.audit.push({ id: row.id, action: 'void' });
      next.messages.push(say('Penny', '已撤销 P002。该笔不再计入统计，历史记录保留；本月个人账支出为 ¥0.00。'));
    } else {
      const ids = [];
      for (const row of next.rows) {
        if (next.entries.some(existing => existing.source === row.source)) continue;
        const id = `${next.book === 'personal' ? 'P' : 'B'}${String(next.entries.length + 1).padStart(3, '0')}`;
        ids.push(id); next.entries.push({ ...row, id, book: next.book, revision: 1, active: true });
      }
      const total = next.rows.reduce((sum, row) => sum + row.cents, 0);
      next.messages.push(say('Penny', `已记入${bookName(next.book)}：${ids.length} 笔支出，共 ¥${money(total)}。\n记录编号：${ids.join('、')}。${next.skipped ? `\n已排除 ${next.skipped} 笔已有交易，没有重复入账。` : ''}`));
    }
    next.status = 'committed'; next.received = 1; next.illegal = null;
    return next;
  }
  /** Admission and transition rules live here; the panel derives reachability. */
  function reduce(state, action) {
    const deny = why => ({ ...state, illegal: `${action.type} ignored: ${why}` });
    if (!state) return { illegal: '先选择一个演示场景' };
    if (TERMINAL.has(state.status)) return deny('本次请求已结束；重复通知不能再次入账，请选择新场景');
    if (action.type === 'foreign_sender') return deny('仅原请求人可以确认、更改账本或取消');
    if (action.type === 'duplicate_delivery') return deny('同一来源消息已接收，不再生成第二份记录');
    if (action.type === 'cancel') return { ...state, status: 'cancelled', illegal: null, rows: [], messages: [...state.messages, say('你', '取消。'), say('Penny', '已取消本次请求，账本没有变化。')] };
    if (action.type === 'post') {
      if (state.status !== 'ready') return deny('当前请求需要先补充信息或确认预览');
      return commit(state, false);
    }
    if (action.type === 'fill_amount') {
      if (state.status !== 'needs_details') return deny('当前没有待补充的金额');
      const next = { ...state, status: 'awaiting_confirmation', illegal: null, rows: state.rows.map(row => ({ ...row, cents: 3990 })) };
      next.messages = [...state.messages, say('你', '金额是 39.90 元。'), say('Penny', preview(next))];
      return next;
    }
    if (action.type === 'choose_personal' || action.type === 'choose_business') {
      if (state.status !== 'awaiting_confirmation' || !['file', 'screenshot'].includes(state.mode)) return deny('仅导入预览阶段可以更改目标账本');
      const next = { ...state, book: action.type === 'choose_personal' ? 'personal' : 'business', illegal: null };
      if (next.book === state.book) return deny('当前已选中该账本');
      next.messages = [...state.messages, say('你', `改为${bookName(next.book)}。`), say('Penny', preview(next))];
      return next;
    }
    if (action.type === 'confirm') {
      if (state.status !== 'awaiting_confirmation') return deny('当前没有可确认的完整预览');
      return commit(state, true);
    }
    return deny('未知事件');
  }
  function legal(state) {
    return Object.fromEntries(ALL_ACTIONS.map(action => {
      if (!state) return [action.type, { legal: false, why: '先选择一个演示场景' }];
      const next = reduce(state, action);
      return [action.type, { legal: !next.illegal, why: next.illegal?.replace(/^\S+ ignored: /, '') ?? null }];
    }));
  }
  window.StateMachine = { initial, reduce, legal, ALL_ACTIONS, TERMINAL, STATUS_NAMES, totals, money, bookName };
})();
