# Architecture

Synapse is a local-first app made of three processes: an **Electron shell**, a **Node.js server** bound to loopback, and one **child process per AI client** (Codex, Claude Code, Gemini/Antigravity). The UI is plain HTML/CSS/JS served by the local server.

## Request path of a turn

1. The user sends a message in a room (`public/app.js` → `POST /api/...`). The server validates every field (`textField` in `server.mjs`), checks `Host`, `Origin` and the CSRF token, and stores the message.
2. The **Coordinator** (`lib/coordinator.mjs`) opens or resumes a *job* for the room and asks the **round planner** (`lib/rounds.mjs`) who speaks next, based on the room's mode (Chat or Code), lead order, pending @mentions and calls between participants (max 3 per round).
3. **Routing** (`lib/routing.mjs`) filters out participants that are over their preventive quota threshold, or that hit a hard limit on the current model/transport, and ranks the rest. Unknown usage is never treated as zero.
4. The **Orchestrator** (`lib/orchestrator.mjs`) builds the prompt: role directions for the stage (Opening, Analysis, Synthesis, Implementation, Review, Refinement, Verification), the newest history that fits the budget, the exact quote when the user replied to a passage, and an incremental delta when the participant's session is resumed.
5. **Providers** (`lib/providers.mjs`) run the turn on the official client, loading only the MCP servers enabled for the room and enforcing the per-turn tool-call ceiling:
   - **Codex:** `codex app-server`, JSON-RPC over stdio (`lib/rpc.mjs`), with per-turn usage computed from the thread totals.
   - **Claude:** `@anthropic-ai/claude-agent-sdk`, with a tool policy derived from the room's access level.
   - **Gemini:** AI Studio `streamGenerateContent` over SSE (`lib/ai-studio.mjs`) or the Antigravity agent (`lib/google-client.mjs`), with automatic fallback between models when a quota is hit.
6. Every action an agent wants to take becomes an **approval** (`lib/approvals.mjs`). MCP tool calls go through `lib/tool-gateway.mjs`, so an agent's own client cannot skip the queue. With Autonomy on, routine permissions are auto-approved and logged; the `SEMPRE_PERGUNTAR` deny-list (push, hard reset, recursive delete, publish, disk, shutdown, registry) still waits for the user.
7. Before and after the turn, `lib/versions.mjs` fingerprints the room's files to attribute changes to the participant who made them and to tell product changes from docs-only changes.
8. The result, usage and events are persisted in SQLite (`lib/store.mjs`) and pushed to the UI over Server-Sent Events.

## Persistence (`node:sqlite`)

| Table | Holds |
|---|---|
| `rooms` | name, mode, folder, per-room settings, archived flag |
| `messages` | user and agent messages, reply target and quoted passage |
| `jobs` / `events` | a round's lifecycle and its *Actions* log |
| `sessions` / `checkpoints` | client session ids and the last message each session already received (watermark) |
| `approvals` | pending and resolved actions, with sanitized details only |
| `provider_state` | last known quota/usage per client |

## Security model

- Server listens on `127.0.0.1` only; strict CSP; CSRF token compared with `timingSafeEqual`.
- Child processes receive a scrubbed environment (`subscriptionEnvironment` in `lib/agents.mjs`): no API-billing keys, cloud credentials or `NODE_OPTIONS`.
- Diagnostics and stored approvals pass through `safeDiagnostic`, which masks emails, keys and bearer tokens.
- A continued task can only narrow its grants (`narrowSettings`).
- A process lock (`lib/lock.mjs`) prevents two servers from sharing one database and only removes a stale lock it actually inspected.

## Account connection (`lib/accounts.mjs`)

Each login runs through the vendor's own client: Codex `app-server` (`account/login/start`, with device code as fallback), `claude auth login --claudeai`, and Antigravity's `authenticate oauth-personal`. Synapse only opens login URLs whose host is on an allow-list (`openai.com`, `chatgpt.com`, `claude.ai`, `claude.com`, `anthropic.com`, `google.com`), relays the code the user pastes when Claude asks for one, and records nothing about the login in the database or logs.

## Desktop shell (`desktop/`)

`main.mjs` enforces a single instance, starts or replaces the local server when the app version changes, owns the tray icon and keeps navigation inside the app's origin. `atualizacao.mjs` watches a folder for a newer installer and runs it in update mode after the user confirms. It is kept free of Electron imports so it can be unit-tested.

## Tests

`npm test` runs 25 `node:test` files (234 tests) without network or accounts. `tests/fixtures/gateway-server.mjs` fakes an MCP server to test the approval gateway. Several suites reproduce incidents from real use (`*-regressions.test.mjs`, `conversa-renovada`, `contexto-incremental`, `gemini-rescue`).
