// Prototype only: pure notification routing model, no transport or persistence.
/** @typedef {'ready'|'sending'|'accepted'|'unknown'} Status */
/** @typedef {{status:Status, origin:string, destination:string, online:Record<string,boolean>, replies:string[], attempts:number, illegal:string|null}} State */
const TERMINAL = new Set(['accepted','unknown']);
const ALL_ACTIONS = ['weixin_down','weixin_up','feishu_down','feishu_up','chat_weixin','chat_feishu','submit','accept','uncertain','restart','redirect'].map(type=>({type}));
/** @param {string} origin @returns {State} */
function initial(origin) {return {status:'ready',origin,destination:origin==='legacy'?'feishu':origin,online:{weixin:true,feishu:true},replies:[],attempts:0,illegal:null};}
/** @param {State} s @param {{type:string}} a @returns {State} */
function reduce(s,a){
 const deny=why=>({...s,illegal:a.type+' ignored: '+why});
 const ok=patch=>({...s,illegal:null,...patch});
 if(TERMINAL.has(s.status)) return deny('This delivery is terminal. Start another scenario.');
 const [channel,operation]=a.type.split('_');
 if(['weixin','feishu'].includes(channel)) {
  const next=operation==='up';
  if(s.online[channel]===next)return deny('Connection already has that state');
  return ok({online:{...s.online,[channel]:next}});
 }
 switch(a.type){
 case 'chat_weixin':case 'chat_feishu':{
  const source=a.type.slice(5);
  if(!s.online[source])return deny('That channel is offline');
  return ok({replies:[...s.replies,source+' → '+source]});
 }
 case 'submit':
  if(s.status!=='ready')return deny('A submission is already in flight');
  if(!s.online[s.destination])return deny('Wait for the original destination; no fallback');
  return ok({status:'sending',attempts:s.attempts+1});
 case 'accept':
  if(s.status!=='sending')return deny('No submitted delivery');
  return ok({status:'accepted'});
 case 'uncertain':
  if(s.status!=='sending')return deny('No submitted delivery');
  return ok({status:'unknown'});
 case 'restart':
  return ok({status:s.status==='sending'?'unknown':'ready'});
 case 'redirect':return deny('Cross-channel fallback is forbidden');
 default:return deny('Unknown event');
 }
}
function legal(s){return Object.fromEntries(ALL_ACTIONS.map(a=>{if(!s)return[a.type,{legal:false,why:'Start a scenario first'}];const next=reduce(s,a);return[a.type,{legal:!next.illegal,why:next.illegal}];}));}
window.StateMachine={initial,reduce,legal,ALL_ACTIONS,TERMINAL};
