// Synthetic prototype walkthrough only; does not contact Feishu or an agent.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('./logic.js', import.meta.url), 'utf8'), context);
const model = context.window.StateMachine;
const scenes = [
  ['alice', ['recognize', 'accept', 'deliver', 'complete', 'deliver']],
  ['inferred', ['recognize', 'deliver', 'other_confirm', 'confirm', 'accept', 'deliver', 'complete', 'reject_send', 'retry_report', 'deliver']],
  ['wrong', ['recognize', 'deliver', 'reassign', 'deliver', 'accept', 'deliver', 'complete', 'uncertain']],
];

console.log('Synthetic design walkthrough. No messages sent and no files produced.');
for (const [scene, actions] of scenes) {
  let state = model.initial(scene);
  const transitions = [];
  for (const type of actions) {
    state = model.reduce(state, { type });
    transitions.push({ action: type, status: state.status, executions: state.operations, ignored: state.illegal });
  }
  console.log(JSON.stringify({ scene, transitions, status: state.status, outcome: state.outcome, assignee: state.agent, executions: state.operations, notifications: state.outbox.map(({ speaker, text, delivery }) => ({ speaker, text, delivery })) }, null, 2));
}
console.log(`Preview: ${new URL('./index.html', import.meta.url).pathname}`);
