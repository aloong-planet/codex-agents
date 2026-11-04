// Prototype only: deterministic, in-memory events; no timers, model calls, or channel I/O.
/** @typedef {'enabled'|'paused'|'deleted'} TaskStatus */
/** @typedef {{type:string}} Action */
const TERMINAL = new Set(['deleted']);
const PENDING = new Set(['ready', 'context_required', 'auth_required']);
function initial(kind) {
  const news = kind === 'news', once = kind === 'once';
  return {
    status: 'enabled', illegal: null, kind, name: once ? '浇水提醒' : news ? 'AI 新闻日报' : 'AI 工具周报',
    instruction: once ? '提醒我给花浇水' : news ? '沿用已有日报的研究、摘要和归档要求' : '整理本周 AI 编程工具更新，说明核心变化及来源',
    schedule: once ? '明天 15:00（一次性）' : news ? '每天 08:30' : '每周五 21:00', timezone: 'Asia/Shanghai', revision: 1,
    slot: news ? 2 : 0, serial: news ? 2 : 0, context: 1, credential:1, contextCredential:1,
    usable:true, blockedContext:news ? {credential:1,context:1} : null,
    pauseGeneration:0, capacityBlocked:false, recoveryWake:false,
    runs: news ? [1, 2].map(n => ({id:n, slot:n, revision:1, manual:false, pauseGeneration:0,
      execution:'succeeded', delivery:'context_required', attemptedContext:1, attemptedCredential:1,
      body:`示例缓存日报 ${n}：完整内容保持不变。`})) : [],
    outbox: [], log: [], reply: once ? '已保存一次性浇水提醒；到期执行后保留记录。' : news ? '模拟导入：AI 日报已纳入管理；2 份示例缓存保留，等待原微信会话刷新。' :
      '已创建“AI 工具周报”，每周五 21:00（北京时间）执行，结果发到当前微信会话。'
  };
}
function reduce(s, a) {
  if (!s) return s;
  const deny = why => ({...s, illegal: `${a.type} ignored: ${why}`});
  if (TERMINAL.has(s.status)) return deny('任务已删除；历史记录保留，请清空后重新建例子');
  const n = structuredClone(s); n.illegal = null;
  const active = n.runs.find(r => r.execution === 'running' || r.delivery === 'sending');
  const authorised = r => n.status==='enabled' || (r.manual && r.pauseGeneration===n.pauseGeneration);
  const pending = () => n.runs.filter(r => PENDING.has(r.delivery) && authorised(r))
    .sort((x,y) => x.slot-y.slot || x.id-y.id);
  const freshContext = () => n.contextCredential===n.credential &&
    (!n.blockedContext || n.blockedContext.credential!==n.credential || n.context>n.blockedContext.context);
  const reconcile = () => {
    for(const r of n.runs) {
      if(PENDING.has(r.delivery)) r.delivery=!n.usable ? 'auth_required' : freshContext() ? 'ready' : 'context_required';
    }
    n.recoveryWake=!n.runs.some(r=>r.execution==='running'||r.delivery==='sending') &&
      pending().some(r=>r.delivery==='ready');
  };
  const recoveryStatus = () => {
    if(!n.runs.some(r=>PENDING.has(r.delivery))) return '当前没有待发缓存；已结束和结果未知的记录不会重发。';
    if(!pending().length) return '任务仍停用，缓存暂不续发；此前的手动执行许可也已被后续停用撤销。';
    if(!n.usable) return '缓存保留；请重新绑定原账号，再从原微信会话发送新消息。';
    if(!freshContext()) return '缓存保留；请在原微信会话发送新消息，以取得当前绑定下的有效会话。';
    if(!n.recoveryWake) return '当前会话已有效；待正在进行的操作结算后检查最早缓存。';
    return n.status==='paused' ? '任务仍停用；仅本次停用之后手动执行的结果可提交，已安排续发检查。' :
      '当前会话已有效，已安排续发检查；将按原时间顺序提交缓存，完整内容不变。';
  };
  const finish = (reply, recovery=false) => {
    reconcile(); n.reply=reply+(recovery ? recoveryStatus() : '');
    n.log.push({action:a.type,reply:n.reply}); return n;
  };
  const append = (slot, manual) => {
    n.runs.push({id:++n.serial, slot, revision:n.revision, manual, pauseGeneration:n.pauseGeneration,
      execution:'running', delivery:null, attemptedContext:null, attemptedCredential:null, body:null});
  };
  const blockAttempt = r => { n.blockedContext={credential:r.attemptedCredential,context:r.attemptedContext}; };
  switch(a.type) {
    case 'pause':
      n.status='paused'; n.pauseGeneration++;
      return finish('已停用后续自动执行和缓存续发，并撤销此前的手动续发许可。已提交的操作不能撤回；结果会保留。');
    case 'resume':
      if(n.status !== 'paused') return deny('任务尚未停用');
      n.status='enabled'; return finish('已启用后续计划。',true);
    case 'edit_time':
      if(n.kind==='once') return deny('本次一次性例子只验证完成状态；重设时间不在当前范围');
      n.schedule=n.kind==='news' ? (n.schedule.includes('09:00')?'每天 08:30':'每天 09:00') :
        (n.schedule.includes('09:00')?'每周五 21:00':'每周五 09:00'); n.revision++;
      return finish(`已将后续执行时间改为${n.schedule}（北京时间）。停用状态及已产生的执行记录保持不变。`);
    case 'edit_content':
      n.instruction='只汇总 AI 编程工具的正式发布，附来源与核心变化'; n.revision++;
      return finish('已保存新的任务要求；已开始的执行和已缓存内容仍使用当时的设置。');
    case 'remove':
      if(active) return deny('示例中的执行尚未结算；可先停用，待结果记录后删除');
      n.status='deleted';
      for(const r of n.runs) if(PENDING.has(r.delivery)) r.delivery='cancelled';
      return finish('已删除任务，待发内容标为取消；既有提交结果和历史记录保留。');
    case 'tick':
    case 'missed':
      if(n.status !== 'enabled') return deny('任务已停用，不触发自动执行');
      if(n.kind==='once' && n.runs.some(r=>!r.manual)) return deny('一次性计划已触发，不再自动执行；已生成内容继续保留');
      if(active) return deny('上一轮仍在执行，不能重叠启动');
      if(n.capacityBlocked) return deny('缓存容量已满；暂停生成，已有缓存仍可恢复推送');
      if(a.type === 'missed' && n.kind!=='once') n.runs.push({id:++n.serial,slot:n.slot+1,throughSlot:n.slot+2,revision:n.revision,
        manual:false,pauseGeneration:n.pauseGeneration,execution:'skipped',delivery:null,attemptedContext:null,attemptedCredential:null,body:null});
      n.slot += a.type === 'missed' && n.kind!=='once' ? 3 : 1; append(n.slot,false);
      return finish(a.type === 'missed' ? n.kind==='once' ? '恢复后执行这一次到期计划，不重复触发。' : '恢复后只执行最近一次错过的计划；较早两次合并记录为跳过区间。已有缓存仍保留。' : '已到计划时间，本轮开始执行。');
    case 'run_now':
      if(active) return deny('本任务已有进行中的执行');
      if(n.capacityBlocked) return deny('缓存容量已满，未启动本次执行；可先恢复推送或删除不再需要的任务');
      append(n.slot+0.5,true); return finish('已开始一次手动执行；原定周期和启停状态不变，后续停用可撤销本次续发许可。');
    case 'generated':
      if(!active || active.execution !== 'running') return deny('当前没有正在生成内容的执行');
      active.execution='succeeded'; active.delivery='ready';
      active.body=`示例结果 ${active.id}：按第 ${active.revision} 版任务要求生成的完整内容。`;
      return finish('内容生成完成并已缓存；推送尚未提交。',true);
    case 'failed':
      if(!active || active.execution !== 'running') return deny('当前没有正在执行的任务');
      active.execution='failed'; return finish(n.kind==='once' ? '本次执行失败，不会自动重跑；失败记录保留。' : '本轮执行失败，没有可推送内容；已记录原因，后续周期仍按原计划运行。');
    case 'send': {
      if(active) return deny('已有生成或推送操作正在进行');
      const r=pending()[0];
      if(!r) return deny('没有获准续发的缓存；停用后的旧手动许可无效，终态也不会重发');
      if(!n.usable) return deny('账号需要重新绑定');
      if(!freshContext()) return deny('需要当前绑定下的有效新会话；不能复用已失败或重绑前的会话');
      r.delivery='sending'; r.attemptedContext=n.context; r.attemptedCredential=n.credential;
      n.outbox.push({run:r.id,body:r.body,credential:n.credential,context:n.context,outcome:'sending'});
      return finish(`开始提交最早的缓存 #${r.id}；不重新生成内容。`);
    }
    case 'accepted': case 'partial': case 'rejected': case 'unknown': case 'stale': case 'auth': {
      if(!active || active.delivery !== 'sending') return deny('当前没有正在提交的推送');
      active.delivery=a.type === 'stale' ? 'context_required' : a.type === 'auth' ? 'auth_required' : a.type;
      if(a.type === 'auth' && active.attemptedCredential===n.credential) n.usable=false;
      if(a.type !== 'accepted') blockAttempt(active);
      n.outbox.at(-1).outcome=active.delivery;
      const replies={accepted:'微信已接受本次推送；不等于确认手机已收到。',partial:'部分内容被接受，本轮不自动重发；原补发批次停止。',
        rejected:'本次明确拒绝属于不可恢复原因，不自动重发；原补发批次停止。',unknown:'发送结果未知，禁止自动重发；原补发批次停止。',
        stale:'此前提交遇到会话失效，失败记录已保存。',auth:'此前提交遇到账号失效，失败记录已保存。'};
      return finish(replies[a.type],true);
    }
    case 'refresh':
      n.context++; n.contextCredential=n.credential;
      return finish('已记录原会话的新消息。',true);
    case 'rebind':
      n.credential++; n.usable=true; n.contextCredential=null;
      return finish('原账号已重新绑定，旧会话已清除。',true);
    case 'restart':
      if(active?.delivery === 'sending') { active.delivery='unknown'; blockAttempt(active); n.outbox.at(-1).outcome='unknown'; }
      else if(active?.execution === 'running') active.execution='unknown';
      return finish(active ? '已恢复保存的记录；中断操作的结果未知，不自动重做。' : '服务恢复，任务、启停状态及缓存保留。',true);
    case 'capacity_full':
      if(n.capacityBlocked) return deny('已处于容量阻塞示例');
      n.capacityBlocked=true; return finish('模拟缓存容量已满：停止接纳新执行；已预留的执行可完成，已有缓存仍可推送。');
    case 'capacity_free':
      if(!n.capacityBlocked) return deny('当前没有容量阻塞');
      n.capacityBlocked=false; return finish('模拟容量已释放：恢复检查最新到期计划，停用任务仍保持停用。');
    default: return deny('未知事件');
  }
}
const ALL_ACTIONS = ['pause','resume','edit_time','edit_content','remove','tick','missed','run_now','generated','failed',
  'send','accepted','stale','auth','partial','rejected','unknown','refresh','rebind','restart','capacity_full','capacity_free'].map(type=>({type}));
function legal(s) {
  return Object.fromEntries(ALL_ACTIONS.map(a=>{
    if(!s) return [a.type,{legal:false,why:'请先创建一个示例任务'}];
    const next=reduce(s,a);
    return [a.type,{legal:!next.illegal,why:next.illegal?.replace(/^\S+ ignored: /,'') || null}];
  }));
}
function completionView(s) {
  if(!s) return null;
  if(s.kind!=='once'||s.status==='deleted') return {status:s.status,active:s.status!=='deleted',history:s.runs.length>0};
  let status='scheduled';
  if(s.runs.some(r=>r.execution==='running')) status='running';
  else if(s.runs.some(r=>r.delivery==='sending')) status='sending';
  else if(s.runs.some(r=>PENDING.has(r.delivery))) status='pending_delivery';
  else if(s.runs.some(r=>r.execution==='unknown'||r.delivery==='unknown')) status='unknown';
  else if(s.runs.some(r=>r.execution==='failed')) status='failed';
  else if(s.runs.some(r=>r.delivery==='partial')) status='partial';
  else if(s.runs.some(r=>r.delivery==='rejected')) status='rejected';
  else if(s.runs.length && s.runs.every(r=>r.execution==='succeeded'&&r.delivery==='accepted')) status='completed';
  return {status,active:status!=='completed',history:s.runs.length>0};
}
window.StateMachine={initial,reduce,legal,completionView,ALL_ACTIONS,TERMINAL};
