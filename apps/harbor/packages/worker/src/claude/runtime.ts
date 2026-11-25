import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { errorText, oneLine, type Logger } from '../log.js';
import {
  TurnOverError,
  type ModelChoice,
  type OpenSessionInput,
  type Runtime,
  type TurnEvent,
  type TurnHandle,
  type TurnInput,
  type TurnResult,
} from '../runtime.js';

// Claude Code as the unmodified `claude` binary in print mode, so the user's
// hooks, CLAUDE.md and skills load as they do in a terminal, and sign-in is the
// binary's own. One process per turn; the session is Claude Code's own, resumed
// by id. Print mode takes no input mid-turn here, so it does not steer and
// Harbor keeps queueing.

export interface ClaudeRuntimeOptions {
  /** The org's address with its scheme, for the Spaces MCP server. */
  orgUrl: string;
  /** The agent's own Spaces key, handed to Claude Code through the environment. */
  agentKey: string;
  /** Where the MCP config is written (it names the key's variable, never the key). */
  stateDir: string;
  log: Logger;
  /** The executable and the arguments before Claude Code's own; tests point at a fake. */
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  appendSystemPromptFile?: string;
  defaultModel?: string;
  permissionMode?: string;
  /** Turns running at once, across all conversations: they share one subscription's limits. */
  maxConcurrent?: number;
  turnTimeoutMs?: number;
  killGraceMs?: number;
}

const MODELS: ModelChoice[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];
const EFFORTS: ModelChoice[] = ['low', 'medium', 'high'].map((id) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
}));

/** Credentials that outrank a subscription sign-in and would bill per token. */
const METERED_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export class ClaudeRuntime implements Runtime {
  readonly name = 'claude';
  readonly label = 'Claude';
  readonly capabilities = { steer: false };
  private readonly cwds = new Map<string, string>();
  private readonly busy = new Set<string>();
  private readonly children = new Set<ChildProcess>();
  private readonly waiting: Array<() => void> = [];
  private running = 0;

  constructor(private readonly opts: ClaudeRuntimeOptions) {}

  async start(): Promise<void> {
    mkdirSync(this.opts.stateDir, { recursive: true });
    const headers = { Authorization: 'Bearer ${ROWBOAT_AGENT_KEY}' };
    const config = {
      mcpServers: {
        rowboat: { type: 'http', url: `${this.opts.orgUrl}/mcp`, headers },
      },
    };
    writeFileSync(this.mcpConfigFile(), JSON.stringify(config, null, 2));
  }

  async stop(): Promise<void> {
    for (const child of this.children) signalGroup(child, 'SIGKILL');
  }

  async openSession(input: OpenSessionInput): Promise<{ sessionId: string }> {
    await this.start();
    const sessionId = input.sessionId ?? randomUUID();
    this.cwds.set(sessionId, input.cwd);
    return { sessionId };
  }

  async turn(input: TurnInput): Promise<TurnHandle> {
    const { sessionId } = input;
    if (this.busy.has(sessionId)) throw new Error('a turn is already running on this session');
    this.busy.add(sessionId);

    let child: ChildProcess | undefined;
    let interrupted = false;
    let abandonWait: (() => void) | undefined;

    const done = (async (): Promise<TurnResult> => {
      if (this.running >= (this.opts.maxConcurrent ?? 1)) {
        input.onEvent({
          type: 'activity',
          activity: 'is waiting for another conversation to finish',
        });
        const granted = await new Promise<boolean>((resolve) => {
          const grant = () => resolve(true);
          this.waiting.push(grant);
          abandonWait = () => {
            const at = this.waiting.indexOf(grant);
            if (at >= 0) this.waiting.splice(at, 1);
            resolve(false);
          };
        });
        abandonWait = undefined;
        if (!granted) return { status: 'interrupted' };
      } else {
        this.running += 1;
      }
      try {
        if (interrupted) return { status: 'interrupted' };
        return await this.run(
          input,
          (spawned) => (child = spawned),
          () => interrupted,
        );
      } finally {
        // The slot passes straight to the next in line, so the count only drops when nobody waits.
        const next = this.waiting.shift();
        if (next) next();
        else this.running -= 1;
      }
    })().finally(() => this.busy.delete(sessionId));

    return {
      id: randomUUID(),
      done,
      steer: async () => {
        throw new TurnOverError('Claude Code takes no input mid-turn');
      },
      interrupt: async () => {
        interrupted = true;
        abandonWait?.();
        if (child) this.terminate(child, 'SIGINT');
      },
    };
  }

  async models(): Promise<ModelChoice[]> {
    return MODELS;
  }

  efforts(): ModelChoice[] {
    return EFFORTS;
  }

  private mcpConfigFile(): string {
    return join(this.opts.stateDir, 'mcp.json');
  }

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      ROWBOAT_URL: this.opts.orgUrl,
      ROWBOAT_AGENT_KEY: this.opts.agentKey,
    };
    for (const name of METERED_CREDENTIALS) delete env[name];
    return env;
  }

  /** Whether Claude Code has a transcript for the session: resume it, else start it under that id. */
  private hasTranscript(sessionId: string, env: NodeJS.ProcessEnv): boolean {
    const projects = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'projects');
    if (!existsSync(projects)) return false;
    return readdirSync(projects).some((project) => existsSync(join(projects, project, `${sessionId}.jsonl`)));
  }

  private args(input: TurnInput, env: NodeJS.ProcessEnv): string[] {
    const model = input.model ?? this.opts.defaultModel;
    const prompt = this.opts.appendSystemPromptFile;
    return [
      ...(this.opts.commandArgs ?? []),
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.opts.permissionMode ?? 'bypassPermissions',
      '--mcp-config',
      this.mcpConfigFile(),
      ...(prompt ? ['--append-system-prompt-file', prompt] : []),
      ...(model ? ['--model', model] : []),
      ...(input.effort ? ['--effort', input.effort] : []),
      this.hasTranscript(input.sessionId, env) ? '--resume' : '--session-id',
      input.sessionId,
    ];
  }

  private run(input: TurnInput, spawned: (child: ChildProcess) => void, wasInterrupted: () => boolean): Promise<TurnResult> {
    return new Promise((resolve) => {
      const env = this.environment();
      const cwd = this.cwds.get(input.sessionId) ?? dirname(this.opts.stateDir);
      // Its own process group, so Stop reaches the commands Claude Code started too.
      const child = spawn(this.opts.command ?? 'claude', this.args(input, env), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child);
      spawned(child);

      let result: Obj | undefined;
      let lastText: string | undefined;
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const timeoutMs = this.opts.turnTimeoutMs ?? 20 * 60_000;
      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(child, 'SIGTERM');
      }, timeoutMs);

      createInterface({ input: child.stdout! }).on('line', (line) => {
        const message = parseLine(line);
        if (!message) return;
        if (message.type === 'result') {
          result = message;
          return;
        }
        for (const event of eventsOf(message)) {
          if (event.type === 'answer') lastText = event.text;
          input.onEvent(event);
        }
      });
      child.stderr!.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-2000)));
      // A child that exits before reading the prompt closes the pipe; its exit says why.
      child.stdin!.on('error', () => {});
      child.stdin!.end(input.prompt);

      const settle = (outcome: TurnResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.children.delete(child);
        resolve(outcome);
      };
      child.on('error', (err) =>
        settle({
          status: 'failed',
          error: `Claude Code did not start: ${errorText(err)}`,
        }),
      );
      child.on('close', (code, signal) => {
        if (wasInterrupted()) return settle({ status: 'interrupted' });
        if (timedOut)
          return settle({
            status: 'failed',
            error: `Claude Code ran past the ${Math.round(timeoutMs / 60_000)} minute limit and was stopped`,
          });
        const answer = str(result?.result) ?? lastText;
        if (result && result.is_error !== true && result.subtype === 'success') {
          return settle({ status: 'completed', ...(answer ? { answer } : {}) });
        }
        const why = str(result?.result) ?? (oneLine(stderr, 500) || str(result?.subtype) || `exit ${code ?? signal}`);
        this.opts.log('claude turn failed', { code, signal, error: why });
        settle({ status: 'failed', error: `Claude Code stopped: ${why}` });
      });
    });
  }

  private terminate(child: ChildProcess, signal: NodeJS.Signals): void {
    signalGroup(child, signal);
    const kill = setTimeout(() => signalGroup(child, 'SIGKILL'), this.opts.killGraceMs ?? 10_000);
    kill.unref?.();
    child.once('close', () => clearTimeout(kill));
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    // The group is already gone.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function parseLine(line: string): Obj | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** What one stream-json message tells the thread. Subagents' own messages stay out of it. */
export function eventsOf(message: Record<string, unknown>): TurnEvent[] {
  if (message.type !== 'assistant' || message.parent_tool_use_id) return [];
  const content = obj(message.message)?.content;
  if (!Array.isArray(content)) return [];
  const events: TurnEvent[] = [];
  for (const raw of content) {
    const block = obj(raw);
    if (block?.type === 'text') {
      const text = str(block.text);
      if (text?.trim()) events.push({ type: 'answer', text });
    } else if (block?.type === 'tool_use') {
      events.push({
        type: 'activity',
        activity: activityOf(str(block.name) ?? '', obj(block.input) ?? {}),
      });
    }
  }
  return events;
}

export function activityOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const command = str(input.command);
    return command ? `is running \`${oneLine(command, 150)}\`` : 'is running a command';
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'is editing files';
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return 'is reading files';
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'is searching the web';
  return `is using ${oneLine(tool.split('__').at(-1) || 'a tool', 60)}`;
}
