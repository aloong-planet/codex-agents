// A disposable model of group admission and ownership; no network or persistence.
const TERMINAL = new Set(['disabled']);
const ALL_ACTIONS = ['ambient_guest', 'mention_guest', 'mention_alice', 'mention_bob', 'offer_choice', 'choose_alice', 'choose_bob', 'create_task', 'edit_task_bob', 'reply', 'switch_group', 'private_memory', 'foreign_task', 'unknown_group', 'disable_group'].map(type => ({ type }));
function initial(secondGroup) {
  return { status: 'observing', illegal: null, group: secondGroup ? 'Beta' : 'Alpha', actor: null,
    history: { Alpha: [], Beta: [] }, pending: { Alpha: {}, Beta: {} },
    tasks: { Alpha: [], Beta: [] }, turns: 0, effects: [], privateMemoryAccess: 0 };
}
function reduce(s, a) {
  const deny = why => ({ ...s, illegal: `${a.type} ignored: ${why}` });
  if (TERMINAL.has(s.status)) return deny('group access is disabled');
  const n = JSON.parse(JSON.stringify(s)); n.illegal = null;
  const finish = () => { n.actor = null; n.status = Object.keys(n.pending[n.group]).length ? 'waiting' : 'observing'; return n; };
  switch (a.type) {
    case 'ambient_guest': case 'mention_guest':
      n.history[n.group].push({ sender: 'Guest', mode: 'context only', mentioned: a.type === 'mention_guest' }); return n;
    case 'mention_alice': case 'mention_bob':
      if (s.status === 'processing') return deny('the current request must complete; later requests queue in production');
      n.actor = a.type === 'mention_alice' ? 'Alice' : 'Bob';
      n.history[n.group].push({ sender: n.actor, mode: 'authorized request' }); n.turns++; n.status = 'processing'; return n;
    case 'offer_choice':
      if (s.status !== 'processing') return deny('an authorized request is required');
      n.pending[n.group][n.actor] = 'Choose one file'; n.actor = null; n.status = 'waiting'; return n;
    case 'choose_alice': case 'choose_bob': {
      const actor = a.type === 'choose_alice' ? 'Alice' : 'Bob';
      if (s.status === 'processing') return deny('wait for the current request to complete');
      if (!s.pending[s.group][actor]) return deny('no pending operation belongs to this requester in this group');
      delete n.pending[n.group][actor]; n.effects.push({ group: n.group, actor, operation: 'continue own file operation' }); return finish();
    }
    case 'create_task':
      if (s.status !== 'processing') return deny('an authorized request is required');
      n.tasks[n.group].push({ name: 'Group reminder', createdBy: n.actor, editedBy: null });
      n.effects.push({ group: n.group, actor: n.actor, operation: 'create group task' }); return finish();
    case 'edit_task_bob':
      if (s.status === 'processing') return deny('wait for the current request to complete');
      if (!s.tasks[s.group].length) return deny('this group has no task');
      n.tasks[n.group][0].editedBy = 'Bob'; n.effects.push({ group: n.group, actor: 'Bob', operation: 'edit shared group task after an authorized mention' }); return n;
    case 'reply':
      if (s.status !== 'processing') return deny('no active request');
      n.effects.push({ group: n.group, actor: n.actor, operation: 'reply to source group' }); return finish();
    case 'switch_group':
      if (s.status === 'processing') return deny('finish this demonstration request first');
      n.group = s.group === 'Alpha' ? 'Beta' : 'Alpha'; return finish();
    case 'private_memory': return deny('private memory is outside every group memory scope');
    case 'foreign_task': return deny('task IDs do not grant access to another group or private scope');
    case 'unknown_group': return deny('the group is not explicitly enabled');
    case 'disable_group': n.status = 'disabled'; n.actor = null; return n;
    default: return deny('unknown event');
  }
}
function legal(s) {
  const result = {};
  for (const a of ALL_ACTIONS) {
    if (s === null) { result[a.type] = { legal: false, why: 'choose a group first' }; continue; }
    const next = reduce(s, a);
    result[a.type] = { legal: !next.illegal, why: next.illegal ? next.illegal.replace(/^\S+ ignored: /, '') : null };
  }
  return result;
}
window.StateMachine = { initial, reduce, legal, ALL_ACTIONS, TERMINAL };
