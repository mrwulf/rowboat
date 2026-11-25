# @rowboat/worker

The worker that runs beside an agent's harness and carries Harbor's invocations to it (SPEC.md §8 Connectors, *the agent worker*; the plan is `plans/agent-worker-v1.md` in Main). It is a client of the agent contract on the agent's own key, like the echo example and the Hermes plugin: told live when the agent is invoked, listing every minute, acknowledging, running each conversation's turns one after another through the harness, reporting what it does, posting the answer, reporting done. It declares Stop, and steering when the harness can take input mid-turn. Codex is the first harness, through `codex app-server`; Claude Code runs as one `claude --print` process per turn.

```
rowboat-worker --url https://org.example --cwd /data/workspace --state /data/rowboat/worker --idle 600
```

The key comes from `ROWBOAT_AGENT_KEY` or `--key-file`; the worker never writes it anywhere. `--idle` makes it exit after that many seconds with nothing to do, so a Maritime box can sleep; without it, it runs until stopped. `--sandbox` is `danger-full-access` unless told otherwise: the machine is the sandbox, as it was for the exec-driven turn.

```
rowboat-worker --url https://org.example --agent claude --cwd /data/workspace --state /data/rowboat/worker
```

Claude Code signs in as it does on that machine (`claude auth login`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`); the worker drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, so a turn is never billed to a key by accident. Settings, hooks, `CLAUDE.md` and skills load as in a terminal; `--system-prompt-file` appends to the system prompt. Each conversation resumes its own session. It does not steer, so a follow-up waits for the turn. `--max-concurrent` (default 1) bounds the turns running across conversations, which share one account's limits, and `--turn-timeout` (default 1200 seconds) ends a turn that runs on. `--permission-mode` is `bypassPermissions` unless told otherwise, for the same reason as Codex's sandbox: whoever may mention the agent may run commands on that machine.

`pnpm build` writes the library to `dist/` and one file for the machine the worker runs on, `dist/rowboat-worker.cjs` (Node 20 or later, nothing to install beside it). `pnpm test` runs the worker against the real stub Harbor on Postgres in-process, and each adapter against a stand-in harness (`test/fake-app-server.mjs`, `test/fake-claude.mjs`).
