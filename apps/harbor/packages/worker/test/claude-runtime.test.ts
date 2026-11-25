import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeRuntime, type ClaudeRuntimeOptions } from '../src/claude/runtime.js';
import { silentLogger } from '../src/log.js';
import { TurnOverError, type TurnEvent } from '../src/runtime.js';

const FAKE = resolve(import.meta.dirname, 'fake-claude.mjs');
const runtimes: ClaudeRuntime[] = [];

function runtime(extra: Partial<ClaudeRuntimeOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-runtime-'));
  const stateDir = join(home, 'state');
  const r = new ClaudeRuntime({
    orgUrl: 'http://harbor.test',
    agentKey: 'rbk_test',
    stateDir,
    log: silentLogger,
    command: process.execPath,
    commandArgs: [FAKE],
    env: {
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_API_KEY: 'metered',
      ANTHROPIC_AUTH_TOKEN: 'metered',
    },
    killGraceMs: 500,
    ...extra,
  });
  runtimes.push(r);
  return { r, home, stateDir };
}

async function run(r: ClaudeRuntime, home: string, prompt: string, sessionId?: string) {
  const session = await r.openSession({
    cwd: home,
    ...(sessionId ? { sessionId } : {}),
  });
  const events: TurnEvent[] = [];
  const handle = await r.turn({
    sessionId: session.sessionId,
    prompt,
    onEvent: (e) => events.push(e),
  });
  return { ...session, events, handle };
}

afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop();
});

describe('ClaudeRuntime', () => {
  it('runs a turn and resumes the same session next time', async () => {
    const { r, home } = runtime();
    const first = await run(r, home, 'say pong');
    expect(await first.handle.done).toEqual({
      status: 'completed',
      answer: 'pong',
    });
    expect(first.events).toContainEqual({
      type: 'activity',
      activity: 'is running `echo hi`',
    });
    const second = await run(r, home, 'say pong', first.sessionId);
    expect(await second.handle.done).toEqual({
      status: 'completed',
      answer: 'pong again',
    });
  });

  it('drops metered credentials and keeps the agent key out of arguments and files', async () => {
    const { r, home, stateDir } = runtime({
      defaultModel: 'sonnet',
      appendSystemPromptFile: '/prompt.md',
    });
    const turn = await run(r, home, 'show environment');
    const { answer } = await turn.handle.done;
    expect(answer).toMatch(/^ROWBOAT_AGENT_KEY,ROWBOAT_URL \| /);
    expect(answer).toContain('--model sonnet');
    expect(answer).toContain('--append-system-prompt-file /prompt.md');
    expect(answer).not.toContain('rbk_test');
    expect(readFileSync(join(stateDir, 'mcp.json'), 'utf8')).not.toContain('rbk_test');
  });

  it('interrupts a running turn', async () => {
    const { r, home } = runtime();
    const turn = await run(r, home, 'wait for a stop');
    await turn.handle.interrupt();
    expect(await turn.handle.done).toEqual({ status: 'interrupted' });
  });

  it('runs one turn at a time across conversations, and drops a queued one on stop', async () => {
    const { r, home } = runtime();
    const blocker = await run(r, home, 'wait for a stop');
    const queued = await run(r, home, 'say pong');
    const next = await run(r, home, 'say pong');
    expect(queued.events).toContainEqual({
      type: 'activity',
      activity: 'is waiting for another conversation to finish',
    });
    await queued.handle.interrupt();
    expect(await queued.handle.done).toEqual({ status: 'interrupted' });
    await blocker.handle.interrupt();
    expect(await next.handle.done).toEqual({
      status: 'completed',
      answer: 'pong',
    });
  });

  it('stops a turn that runs past the limit', async () => {
    const { r, home } = runtime({ turnTimeoutMs: 300 });
    const turn = await run(r, home, 'wait for a stop');
    expect(await turn.handle.done).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('limit'),
    });
  });

  it('reports failures in Claude Code’s words', async () => {
    const { r, home } = runtime();
    expect(await (await run(r, home, 'please fail')).handle.done).toEqual({
      status: 'failed',
      error: 'Claude Code stopped: usage limit reached',
    });
    expect(await (await run(r, home, 'crash now')).handle.done).toEqual({
      status: 'failed',
      error: 'Claude Code stopped: the fake crashed',
    });
  });

  it('refuses to steer', async () => {
    const { r, home } = runtime();
    const turn = await run(r, home, 'say pong');
    await expect(turn.handle.steer('more')).rejects.toBeInstanceOf(TurnOverError);
    await turn.handle.done;
  });
});
