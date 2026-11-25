// A stand-in for `claude --print --output-format stream-json`: the prompt on
// stdin picks what happens. A session it has run leaves a transcript, as the
// real one does, so a later turn is seen resuming it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const resumed = after('--resume');
const session = resumed ?? after('--session-id');

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, `${session}.jsonl`), '');

const say = (message) => console.log(JSON.stringify(message));
const assistant = (...content) => say({ type: 'assistant', parent_tool_use_id: null, message: { content } });

say({ type: 'system', subtype: 'init', session_id: session });

if (prompt.includes('wait for a stop')) {
  setInterval(() => {}, 1000);
} else if (prompt.includes('crash now')) {
  console.error('the fake crashed');
  process.exit(3);
} else if (prompt.includes('please fail')) {
  say({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'usage limit reached',
  });
  process.exit(1);
} else if (prompt.includes('show environment')) {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ROWBOAT_AGENT_KEY', 'ROWBOAT_URL'];
  const seen = names.filter((n) => process.env[n]).join(',');
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `${seen} | ${args.join(' ')}`,
  });
} else {
  assistant({ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } });
  assistant({ type: 'text', text: 'pong' });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resumed ? 'pong again' : 'pong',
  });
}
