// Offline configuration model. No real process, transport or configuration I/O.
/** @typedef {{status:string, configured:string, active:string|null, note:string, illegal:string|null}} State */
const TERMINAL = new Set();
/** @returns {State} */
function initial(reverse) {
  const channel = reverse ? 'Feishu' : 'Weixin';
  return { status:'running', configured:channel, active:channel, illegal:null,
    note:'先停止服务，再修改配置并启动。记忆和权限共享，会话按渠道分别保存。' };
}
/** @param {State} s @param {{type:string}} a @returns {State} */
function reduce(s,a) {
  const deny = why => ({...s,illegal:`${a.type} ignored: ${why}`});
  const ok = patch => ({...s,illegal:null,...patch});
  switch(a.type) {
    case 'stop':
      if(s.status!=='running') return deny('只有运行中的服务需要停止');
      return ok({status:'stopped',active:null,note:'服务已停止。可以修改渠道配置；个人数据保持不变。'});
    case 'configure_weixin':
    case 'configure_feishu':
    case 'configure_invalid':
      if(!['stopped','failed'].includes(s.status)) return deny('此流程先停止服务再改配置，不提供运行中切换');
      return ok({status:'stopped',configured:a.type==='configure_weixin'?'Weixin':a.type==='configure_feishu'?'Feishu':'invalid',
        note:'仅修改模拟配置；服务仍未启动。未修改真实文件或凭据。'});
    case 'start':
      if(!['stopped','failed'].includes(s.status)) return deny('服务必须先停止');
      if(!['Weixin','Feishu'].includes(s.configured))return ok({status:'failed',active:null,note:'配置无效，启动失败；不自动选择其他渠道。'});
      return ok({status:'starting',active:null,note:'读取启动配置，仅准备所选适配器。尚未接纳消息或推送。'});
    case 'ready':
      if(s.status!=='starting')return deny('请先启动服务');
      return ok({status:'running',active:s.configured,note:'启动成功；仅所选渠道收发消息，未来推送使用该渠道。'});
    case 'fail':
      if(s.status!=='starting')return deny('当前没有启动中的连接');
      return ok({status:'failed',active:null,note:'所选渠道启动失败。修正配置后再启动，不自动回退。'});
    default:return deny('unknown event');
  }
}
const ALL_ACTIONS=['stop','configure_weixin','configure_feishu','configure_invalid','start','ready','fail'].map(type=>({type}));
function legal(s){return Object.fromEntries(ALL_ACTIONS.map(a=>{if(s===null)return[a.type,{legal:false,why:'请先选择初始渠道'}];const n=reduce(s,a);return[a.type,{legal:!n.illegal,why:n.illegal}];}));}
window.StateMachine={initial,reduce,legal,ALL_ACTIONS,TERMINAL};
