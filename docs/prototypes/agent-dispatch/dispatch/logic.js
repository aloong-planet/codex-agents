// Prototype only: drives synthetic group messages; no network, storage or agent calls.
(function () {
  /** @typedef {'received'|'proposal'|'clarification'|'redirect'|'queued'|'running'|'reporting'|'done'|'unknown'|'ignored'} Status */
  /** @typedef {{type:string}} Action */
  const TERMINAL = new Set(['done', 'unknown', 'ignored']);
  const LABELS = { received: '收到消息', proposal: '等待原作者确认', clarification: 'Sam 澄清需求', redirect: '等待 Sam 转派', queued: '已派给一个 Agent', running: 'Agent 正在处理', reporting: '结果等待汇报', done: '本次流程结束', unknown: '汇报结果未知', ignored: '保持安静' };
  const SCENARIOS = {
    alice: { kind: 'explicit', agent: 'Alice', task: '整理二手键盘的上架材料包', text: '帮我把这把二手键盘整理成闲鱼和淘宝的商品文案，保存成文件。', result: '上架材料包已完成：包含两平台标题、商品描述、成色说明和买家问答。文件：键盘上架材料包.md。尚未发布到平台。' },
    bill: { kind: 'explicit', agent: 'Bill', task: '安排周六的杭州一日游', text: '帮我们两个人安排周六杭州一日游，预算 500 元，少走路，做成行程文件。', result: '行程方案已完成：包含交通、餐饮、预算估算和雨天备选。文件：杭州一日游.md。价格与开放时间的查证来源列在文件中。' },
    jack: { kind: 'explicit', agent: 'Jack', task: '排查代码问题并准备补丁', text: '帮我检查已授权项目里的 TypeScript 排序错误，生成补丁和回归测试用例。', result: '问题分析与补丁已准备：修复比较器的边界处理，附回归用例。文件：排序修复.patch。尚未执行测试，请在应用补丁后验证。' },
    inferred: { kind: 'inferred', agent: 'Bill', task: '安排周末出行', text: '最近有点累，周末想出去走走，但一直没安排。', result: '周末出行方案已完成，包含轻松路线与预算估算。文件：周末安排.md。' },
    wrong: { kind: 'wrong', agent: 'Bill', task: '排查代码问题并准备补丁', text: '@Bill 帮我修一下这个 TypeScript 排序错误。', result: '问题分析与补丁已准备，附回归用例。文件：排序修复.patch。尚未执行测试。' },
    unclear: { kind: 'unclear', agent: null, task: '明确要处理的问题', text: '帮我把那个问题处理一下。', result: '问题分析与补丁已准备，附回归用例。文件：排序修复.patch。尚未执行测试。' },
    casual: { kind: 'casual', agent: null, task: null, text: '今天的晚霞真好看。', result: null },
    guest: { kind: 'guest', agent: null, task: null, text: '帮我修改项目代码。', result: null }
  };
  const ALL_ACTIONS = ['recognize', 'confirm', 'decline', 'clarify', 'reassign', 'accept', 'complete', 'fail', 'cancel', 'deliver', 'uncertain', 'reject_send', 'retry_report', 'other_confirm', 'other_cancel', 'duplicate', 'restart'].map(type => ({ type }));

  /** @param {keyof typeof SCENARIOS} scenario */
  function initial(scenario) {
    const entry = SCENARIOS[scenario];
    return { status: 'received', illegal: null, scenario, kind: entry.kind, task: entry.task, agent: entry.agent, originalAuthor: entry.kind === 'guest' ? '未授权成员' : '成员甲', source: entry.text, outcome: null, progress: 1, outbox: [], inputs: [{ order: 0, speaker: entry.kind === 'guest' ? '未授权成员' : '成员甲', text: entry.text }], operations: 0, decisions: 0, memory: '本群业务事实共享；执行过程按 Agent 分开' };
  }

  /** Single authority for admission and transitions. @param {ReturnType<typeof initial>} s @param {Action} a */
  function reduce(s, a) {
    if (!s) return null;
    const deny = why => ({ ...s, illegal: `${a.type} ignored: ${why}` });
    const ok = patch => ({ ...s, illegal: null, ...patch });
    const notice = (speaker, text, kind) => [...s.outbox, { id: s.outbox.length + 1, order: s.inputs.length + s.outbox.length, speaker, text, kind, delivery: 'queued' }];
    const final = (outcome, text) => ok({ status: 'reporting', outcome, progress: 4, outbox: notice(s.status === 'running' ? s.agent : 'Sam', text, 'final').map(item => outcome === 'cancelled' && item.delivery === 'queued' && item.kind !== 'final' ? { ...item, delivery: 'cancelled' } : item) });
    if (TERMINAL.has(s.status)) return deny('本次流程已结束，不重复处理；新的明确请求另建任务');
    if (a.type === 'duplicate') return deny('同一条原消息已登记，不重复派单或执行');
    if (a.type === 'other_confirm') return deny('待办建议需要原消息作者确认');
    if (a.type === 'other_cancel') return deny('仅原发起人可取消');
    if (a.type === 'restart') return ok({});
    if (['deliver', 'uncertain', 'reject_send'].includes(a.type)) {
      const index = s.outbox.findIndex(item => item.delivery === 'queued');
      if (index < 0) return deny('没有等待发送的通知');
      const delivery = a.type === 'deliver' ? 'accepted' : a.type === 'uncertain' ? 'unknown' : 'rejected';
      const outbox = s.outbox.map((item, i) => i === index ? { ...item, delivery } : item);
      const item = outbox[index];
      const status = item.kind === 'final' && delivery === 'accepted' ? 'done' : item.kind === 'final' && delivery === 'unknown' ? 'unknown' : s.status;
      return ok({ outbox, status });
    }
    switch (a.type) {
      case 'recognize':
        if (s.status !== 'received') return deny('这条消息已经识别过');
        if (['guest', 'casual'].includes(s.kind)) return ok({ status: 'ignored', agent: null, progress: 4, decisions: 1 });
        if (s.kind === 'inferred') return ok({ status: 'proposal', progress: 2, decisions: 1, outbox: notice('Sam', '要不要请 Bill 帮你安排周末出行？请回复这条建议确认，或告诉我暂时不用。', 'proposal') });
        if (s.kind === 'unclear') return ok({ status: 'clarification', progress: 2, decisions: 1, outbox: notice('Sam', '你指的是哪件事，希望得到什么结果？确认后我会交给一个合适的 Agent。', 'clarification') });
        if (s.kind === 'wrong') return ok({ status: 'redirect', progress: 2, decisions: 1, outbox: notice('Bill', '这属于技术开发事务。我请 Sam 重新分派给 Jack，由他独立处理。', 'redirect') });
        return ok({ status: 'queued', progress: 2, decisions: 1 });
      case 'confirm':
        if (s.status !== 'proposal') return deny('没有等待原作者确认的建议');
        if (!s.outbox.some(item => item.kind === 'proposal' && item.delivery === 'accepted')) return deny('请先模拟建议送达，再由原作者确认');
        return ok({ status: 'queued', inputs: [...s.inputs, { order: s.inputs.length + s.outbox.length, speaker: '成员甲', text: '回复 Sam 的建议：确认，请安排。' }] });
      case 'decline':
        if (s.status !== 'proposal') return deny('当前没有待确认建议');
        return ok({ status: 'ignored', outcome: 'declined', progress: 4, outbox: s.outbox.map(item => item.delivery === 'queued' ? { ...item, delivery: 'cancelled' } : item), inputs: [...s.inputs, { order: s.inputs.length + s.outbox.length, speaker: '成员甲', text: '回复 Sam 的建议：暂时不用。' }] });
      case 'clarify':
        if (s.status !== 'clarification') return deny('当前没有待澄清的分派');
        if (!s.outbox.some(item => item.kind === 'clarification' && item.delivery === 'accepted')) return deny('请先模拟澄清消息送达');
        return ok({ status: 'queued', agent: 'Jack', task: '排查代码问题并准备补丁', inputs: [...s.inputs, { order: s.inputs.length + s.outbox.length, speaker: '成员甲', text: '回复 Sam：是项目里的 TypeScript 排序问题，请准备补丁。' }] });
      case 'reassign':
        if (s.status !== 'redirect') return deny('没有待转派的请求');
        return ok({ status: 'queued', agent: 'Jack', outbox: notice('Sam', '已将这项技术需求转派给 Jack。', 'reassignment') });
      case 'accept':
        if (s.status !== 'queued') return deny('需要先确定唯一承办 Agent');
        if (s.agent === 'Sam' || !s.agent) return deny('Sam 只协调，不能接手具体事务');
        return ok({ status: 'running', progress: 3, operations: s.operations + 1, outbox: notice(s.agent, `我准备处理：${s.task}。完成后会在本群汇报。`, 'receipt') });
      case 'complete':
        if (s.status !== 'running') return deny('Agent 尚未开始执行');
        return final('succeeded', SCENARIOS[s.scenario].result);
      case 'fail':
        if (s.status !== 'running') return deny('Agent 尚未开始执行');
        return final('failed', `这次未能完成${s.task}：所需资料暂时无法访问。已保留现有工作记录；请补充资料后明确让我重试。`);
      case 'cancel':
        if (!['proposal', 'clarification', 'redirect', 'queued', 'running'].includes(s.status)) return deny('当前没有可取消的未完成请求');
        return final('cancelled', '已停止继续处理。已经完成的操作不会自动撤销。');
      case 'retry_report': {
        const index = s.outbox.findIndex(item => item.kind === 'final' && item.delivery === 'rejected');
        if (index < 0) return deny('只有明确发送失败的结果通知可重试；未知结果不自动重发');
        return ok({ outbox: s.outbox.map((item, i) => i === index ? { ...item, delivery: 'queued' } : item) });
      }
      default: return deny('未知动作');
    }
  }

  /** Reachability is derived by trying the reducer, never duplicated in the panel. */
  function legal(s) {
    return Object.fromEntries(ALL_ACTIONS.map(action => {
      if (!s) return [action.type, { legal: false, why: '请先选择一条群消息' }];
      const next = reduce(s, action);
      return [action.type, { legal: !next.illegal, why: next.illegal?.replace(/^\S+ ignored: /, '') || null }];
    }));
  }
  window.StateMachine = { initial, reduce, legal, ALL_ACTIONS, TERMINAL, LABELS, SCENARIOS };
})();
