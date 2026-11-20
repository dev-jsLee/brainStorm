# brainStorm

[한국어](README.md) | **English**

A self-hosted channel where one human (the *master*) and several AI agents talk in **threads**.

> **The UI is available in Korean and English** (language picker in the menu; the browser language is used first).
> Dictionaries live in `i18n/ko.json` / `en.json`, term mappings in `i18n/glossary.json` (adding a language: `i18n/README.md`).
> Code comments and in-repo docs are in Korean.
>
> **By default it only listens on this machine** (`127.0.0.1:8080`). To use it from other devices, follow `docs/EXTERNAL-ACCESS.md`;
> the server refuses to listen on non-loopback addresses unless `BRAINSTORM_ALLOW_EXTERNAL=1`. This English README is a translation of [README.md](README.md);
> if they disagree, the Korean one wins.

- One server + a browser PWA (vanilla JS, no build step). Works on phones too.
- Agents connect through **adapters** — Claude Code CLI (`claude -p`) · an already-running herdr window (interactive Claude Code) · OpenAI Codex CLI (`codex exec`) · any OpenAI-compatible `/v1/chat/completions` server (llama.cpp · vLLM · Ollama · OpenAI, …) · an OpenClaw channel plugin.
- Adapters only open **outbound connections** to the server (no port needed on the agent side).
- Stack: TypeScript (Node 22) · Fastify · ws · better-sqlite3 (WAL)

## What it does

- **Main room + thread tree** — branch from any message, and choose which context (point in time · range) the branch carries. A child thread can be **merged** back into its parent (as a single bundled message).
- **The master picks the recipients** — an `@name` in the body is not a call. Agents never call each other automatically (the only exception is the «request channel» below).
- **Run accounting** — delivery is at-least-once (lease), execution is exactly-once per `(cause, recipient, generation)`. If an adapter dies the run becomes `unknown` and is never re-run automatically. Cancel is a *request*, confirmed by the adapter.
- **Session generations** — one session per agent per thread. Rotating starts a new generation that does not receive the old transcript (can rotate automatically when the context fills up).
- **Forwarding** — a final line `→ name` in an agent's reply shows up as a «forward» button for the master. The master can attach a note when forwarding.
- **Request channel** — explicitly allowed agent pairs can hand each other research or verification with a final line `요청→ name` (a request, not an instruction · chain limit · the receiver can decline with `보류: reason`).
- **Face-to-face mode** — two agents take turns editing a single agreement document. A turn that leaves the document unchanged means agreement.
- **Delegation ledger** — before handing work over, claim the scope it will touch (paths · resources); overlapping claims are not handed over.
- **Questions inbox** — an agent posts a decision it needs as a questionnaire instead of burying it in its reply (1–4 items · 2–4 options each · the recommendation goes first, marked «(recommended)»). The master picks or types an answer on the «Questions» screen and presses Send · As recommended · Later · Not needed — the answer goes to that conversation as an instruction and calls the agent that asked. If the master answered in chat instead, the agent closes the question itself, recording the message and the answer it read; the master can reopen it if it was misread. Adapters append the room's open questions to the prompt. Agents post through the MCP tools (`ask_question` etc. · «MCP» below) or the `bs-ask` command.
- **Tag views** (stage 1) — messages carry master-registered `#tags` (up to 2 primary · inline in the body); clicking a tag opens a view of only those messages, where you keep writing. Storage stays in the single root room. Per-tag owner · default agent · archive (read only) · hide (left off the list and picker only) · delete (trash → restore / delete forever). The tag list puts the most recently called topics first; topics left uncalled fade and drift away.
- **Attachments** (images · PDF · text) · Markdown rendering · read state / elapsed time · search · archive / hide / trash · audit log · agent connection status screen.

## Principles (enforced by the code)

| Principle | Where |
|---|---|
| **REST is the source of truth, WebSocket only notifies** — it sends just `{"t":"msg","thread_id":…,"seq":N}` and the client re-reads with a cursor (`after=seq`) | `src/app.ts` |
| **The server decides the author from authentication** — presenting another `author_id` is 403 `impersonation` | `Store.postMessage` |
| **Recipients only through the structured field (`recipients`)** — an `@name` in the body is not a call | 〃 |
| **No automatic agent-to-agent calls — except «requests» between allowed pairs** — agent messages create no deliveries. The exception is source `request`: an allowed pair (`request_pairs` · changed only via CLI) · a single receiver · within the chain limit after the master's message | 〃 |
| Agents cannot post with the `instruction` (user instruction) source — quotes, observations and requests are never promoted to instructions | 〃 |
| Message and delivery in **one transaction** | 〃 |
| Delivery is **at-least-once** (lease), execution is **exactly-once** per `(cause, recipient, generation)` · one active run per session | `claim`, DB unique index |
| If an adapter dies mid-run the lease expires → run **`unknown`**, **no automatic re-run** | `Store.sweep` |
| **Cancelling a running run is a request, not a fact** — adapter confirmation → `cancelled`, no answer → `unknown`, a completion arriving before confirmation → `succeeded` (completion wins) | `cancelRun`·`ackCancel`·`completeRun` |
| A branch thread does not inherit the whole parent — you pick the branch point and the messages to bring | `forkThread` |
| Threads you are not a member of look like «not found» (404) | `requireRead` |
| **Sensitive actions and denials are audited** — bodies, tokens and passphrases are never recorded | `Store.audit` |
| **Agent tokens are never issued from the UI** — server-side CLI → mode 600 file. The UI can only list and revoke | `listConnections`·`revokeCredential` |

## Quick start

```bash
npm ci
npm run build
mkdir -p data
BRAINSTORM_DATA_DIR=./data npm run admin -- init > ./data/pass.txt   # register the master + initial passphrase
BRAINSTORM_DATA_DIR=./data npm start                                  # http://127.0.0.1:8080
```

Open it in a browser and log in with the passphrase in `data/pass.txt`.

Attach a fake agent (no model · echoes back):

```bash
BRAINSTORM_DATA_DIR=./data npm run admin -- participant add --id echo --name Echo
BRAINSTORM_DATA_DIR=./data npm run admin -- token create --participant echo --label local > ./data/echo.token
BRAINSTORM_TOKEN=$(cat data/echo.token) node dist/adapter/fake-adapter.js run --url http://127.0.0.1:8080
```

## Tests

```bash
npm test          # build + node:test (starts the server in a temp dir and runs the fake adapter as a child process)
npm run test:ui   # UI smoke: attaches public/*.js to a real server via jsdom and drives the whole UI
```

## Deployment (systemd)

Unpack the built repo on the server and run `deploy/install.sh <directory>` as root. Safe to run repeatedly.

| What | Where |
|---|---|
| System account `brainstorm` (nologin) | |
| App (root-owned, read-only) | `/opt/brainstorm` (`npm ci --omit=dev`) |
| Data (750) | `/var/lib/brainstorm/{brainstorm.db, attachments/, backups/}` |
| Config (no secrets) | `/etc/brainstorm/brainstorm.env` — `deploy/brainstorm.env` is installed only if missing |
| Service | `brainstorm.service` |
| Daily backup | `brainstorm-backup.timer` (03:40) |
| Agent adapter template (not enabled) | `brainstorm-agent@.service` (OpenAI-compatible), config in `/etc/brainstorm/agents/` |
| Commands | `/usr/local/bin/brainstorm-{admin,backup,restore}` |
| Node path | The value of `command -v node` goes into the units and `brainstorm-admin` — re-run after moving Node (a node under a home directory is refused: services run with `ProtectHome`) |
| First install only: master registration + initial passphrase | `/root/brainstorm-initial-passphrase.txt` (600) |

Check: `curl http://127.0.0.1:8080/healthz` → `{"ok":true,…}`

### Configuration (`/etc/brainstorm/brainstorm.env`)

| Variable | Meaning |
|---|---|
| `BRAINSTORM_LISTEN` | Listen addresses (comma-separated). The first is the main listener · default `127.0.0.1:8080` |
| `BRAINSTORM_ALLOW_EXTERNAL` | Must be `1` to listen on non-loopback addresses (off by default) |
| `BRAINSTORM_ORIGINS` | Origins accepted for cookie-authenticated state-changing requests and WebSocket. **Always add the address you open in the browser (LAN IP · domain)** |
| `BRAINSTORM_SECURE_COOKIE` | `auto` = Secure only on HTTPS requests |
| `BRAINSTORM_TRUSTED_PROXIES` | Proxy addresses (IP · CIDR, comma-separated) whose `X-Forwarded-For` · `X-Forwarded-Proto` are trusted. **Only requests from these addresses** are believed — login lockout · audit IP · Secure cookie (`auto`) then follow the real client. Empty = trust nothing (the direct peer address) |
| `BRAINSTORM_MODULES` | Optional modules to enable (comma list · `all` · empty = core only) — face-to-face `face` · delegations `delegations` · requests `requests` · merge up `merge` · questions inbox `questions` (`docs/MODULES.md`) |
| `BRAINSTORM_FACE_DRAFTER` · `BRAINSTORM_FACE_REVIEWER` | Agent ids for face-to-face mode (drafter · reviewer). Leave empty and face-to-face mode cannot be turned on |
| Others | Size limits · lease · cancel-confirmation wait · call budget — see comments in `deploy/brainstorm.env` |

Put HTTPS and outside access in front (Tailscale serve, a reverse proxy, or an auth proxy) — see `docs/EXTERNAL-ACCESS.md`.

### Master login · admin CLI

```bash
brainstorm-admin set-passphrase < new-passphrase-file     # 12+ chars · existing web sessions are dropped
brainstorm-admin participant add --id agent-a --name "Agent A"
brainstorm-admin participant list
brainstorm-admin token create --participant agent-a --label host-a [--expires-days 90]   # plaintext printed to stdout once
brainstorm-admin token list
brainstorm-admin token revoke cred_XXXX
brainstorm-admin member set --thread th_XXX --participant agent-a [--no-read] [--no-post] [--remove]
brainstorm-admin sessions rotate --thread th_XXX --agent agent-a --reason saturated
brainstorm-admin request-pair add --from agent-a --to agent-b    # allowed request pair (directional) · remove to drop
brainstorm-admin participant disable --id agent-a                # revoke tokens · retire sessions · remove from threads
brainstorm-admin audit list [--limit 50]
```

10 failed logins lock that IP out for 10 minutes. CLI actions are audited as `cli:root`.

### Backup · restore

```bash
brainstorm-backup                          # → /var/lib/brainstorm/backups/brainstorm-YYYYMMDD-HHMMSS.tar.gz
brainstorm-restore /var/lib/brainstorm/backups/brainstorm-….tar.gz
```

Backup is SQLite online backup → `integrity_check` → copy attachments. Restore moves the current DB aside instead of deleting it,
then sets pending deliveries to `cancelled` and in-flight runs to `unknown` (old work is never re-run automatically).

## Connecting agents

Common steps: register a participant on the server, issue a token, and move it to the adapter side as a **mode 600 file** (the adapter refuses to start if group/other permissions are set).
Every adapter has `check` (identity check only) and `run` (long-running). Exit code 2 = config error, 4 = auth rejected.

### MCP — any agent (`POST /mcp`)

The server opens an MCP endpoint (Streamable HTTP · stateless · JSON responses). Register it in any MCP client with the agent token as `Authorization: Bearer` and the agent can call brainStorm tools — nothing else to install. Humans (cookie) get 403.

| Tool | What it does (module) |
|---|---|
| `ask_question` | Post a questionnaire to the Questions inbox (1–4 items · 2–4 options each · `recommended`) — `questions` |
| `close_question` | Close your own question (answered in chat = `answer` + `by_msg_seq` · superseded · obsolete · per item `item`) — `questions` |
| `list_questions` | Your questions and their answers (`status` open·closed·all · `thread_id` · `id`) — `questions` |

The tool list follows the enabled modules (empty when the questions module is off). **Which room**: `thread_id` if given; otherwise the server takes the room and the trigger message's primary tags from the run this agent is running now (the run named by the `X-Brainstorm-Run` header, or the only room with a running run) — if it can't tell, the error is `thread_required`.
The Claude adapter below attaches it every turn on its own. Without an adapter:

```bash
# Claude Code — the token is stored in ~/.claude.json
claude mcp add --transport http -s user brainstorm https://brainstorm.example/mcp --header "Authorization: Bearer $(cat ~/.config/brainstorm/agent.token)"
# Codex — the token is read from an environment variable (set BRAINSTORM_TOKEN where codex starts)
codex mcp add brainstorm --url https://brainstorm.example/mcp --bearer-token-env-var BRAINSTORM_TOKEN
```

### Claude Code (`claude -p`)

`adapter/claude-cli-adapter.ts`. One Claude Code session per thread and generation (`--session-id`/`--resume`) · the prompt carries only unseen messages · the actual model is read from `modelUsage` and recorded.

On the server (root) — participant and token. The token goes to a file, not the screen:

```bash
brainstorm-admin participant add --id claude --name "Claude"
(umask 077; brainstorm-admin token create --participant claude --label host-a > claude.token)
```

As the account that runs the adapter — from the repository folder (with a built `dist/`). `~/claude.token` is where you moved the token file:

```bash
mkdir -p ~/.config/brainstorm ~/.config/systemd/user ~/.local/lib/brainstorm-adapter ~/workspace
install -m 600 ~/claude.token ~/.config/brainstorm/claude.token && rm ~/claude.token
cp -r dist package.json ~/.local/lib/brainstorm-adapter/
sed "s#/home/you#$HOME#" deploy/claude-cli/claude.env.example > ~/.config/brainstorm/claude.env   # edit BRAINSTORM_URL if the server is on another machine
sed "s#/usr/bin/env node#$(command -v node)#" deploy/claude-cli/brainstorm-agent-claude.service > ~/.config/systemd/user/brainstorm-agent-claude.service
mkdir -p ~/.local/bin && sed "1s#/usr/bin/env node#$(command -v node)#" deploy/claude-cli/bs-ask.mjs > ~/.local/bin/bs-ask && chmod 755 ~/.local/bin/bs-ask   # (optional) question-inbox command — the fallback when MCP is off (CLAUDE_BRAINSTORM_MCP=0)
set -a; . ~/.config/brainstorm/claude.env; set +a
node ~/.local/lib/brainstorm-adapter/dist/adapter/claude-cli-adapter.js check
systemctl --user daemon-reload
systemctl --user enable --now brainstorm-agent-claude
```

Log in to `claude` as this account first. To run without a login session, run `loginctl enable-linger <account>` as root.

To fix the node path in a unit you installed earlier (Node moved, or an old unit pins `/usr/bin/node`):

```bash
sed -i "s#^ExecStart=\(/usr/bin/env \)\?[^ ]*node #ExecStart=$(command -v node) #" ~/.config/systemd/user/brainstorm-agent-claude.service
systemctl --user daemon-reload && systemctl --user restart brainstorm-agent-claude
```

The adapter attaches the question tools every turn — per run it writes a 0600 MCP config (token · run id) under `~/.cache/brainstorm/mcp/`, passes it with `--mcp-config` · `--allowedTools mcp__brainstorm`, and deletes it when the turn ends. Turn it off with `CLAUDE_BRAINSTORM_MCP=0` (location: `CLAUDE_MCP_DIR`).
Permissions are not hard-coded — use `CLAUDE_EXTRA_ARGS`. Concurrency `BRAINSTORM_CONCURRENCY` (default 3; the server serializes runs within a thread).
With `CLAUDE_REFS_DIR`, a `#tag` in a message attaches the body of the note with the same name (or front-matter `별칭` alias) to the prompt.

### Codex (`codex exec`)

`adapter/codex-cli-adapter.ts`. Same install as above, with the name `codex`:

On the server (root) — participant and token. The token goes to a file, not the screen:

```bash
brainstorm-admin participant add --id codex --name "Codex"
(umask 077; brainstorm-admin token create --participant codex --label host-a > codex.token)
```

As the account that runs the adapter — from the repository folder (with a built `dist/`). `~/codex.token` is where you moved the token file:

```bash
mkdir -p ~/.config/brainstorm ~/.config/systemd/user ~/.local/lib/brainstorm-adapter ~/workspace
install -m 600 ~/codex.token ~/.config/brainstorm/codex.token && rm ~/codex.token
cp -r dist package.json ~/.local/lib/brainstorm-adapter/
sed "s#/home/you#$HOME#" deploy/codex-cli/codex.env.example > ~/.config/brainstorm/codex.env   # edit BRAINSTORM_URL if the server is on another machine
sed "s#/usr/bin/env node#$(command -v node)#" deploy/codex-cli/brainstorm-agent-codex.service > ~/.config/systemd/user/brainstorm-agent-codex.service
set -a; . ~/.config/brainstorm/codex.env; set +a
node ~/.local/lib/brainstorm-adapter/dist/adapter/codex-cli-adapter.js check
systemctl --user daemon-reload
systemctl --user enable --now brainstorm-agent-codex
```


Log in to `codex` as this account first. Permissions via `CODEX_ARGS` (example value `--sandbox read-only --ask-for-approval never`).
The adapter attaches the question tools every turn — before `exec` it adds `-c mcp_servers.brainstorm.url=…/mcp` · `bearer_token_env_var="BRAINSTORM_MCP_TOKEN"` (the token goes only into the child's environment, never the arguments) · `http_headers={ "X-Brainstorm-Run" = run id }` · `default_tools_approval_mode="approve"` (so the tools aren't blocked under approval policy never). Turn it off with `CODEX_BRAINSTORM_MCP=0`.

### herdr window (an already-running Claude Code window)

`adapter/herdr-adapter.ts`. Instead of spawning `claude -p`, it types the message into **one interactive Claude Code window that is already running** inside a [herdr](https://herdr.dev) session (`herdr agent prompt`). The turn's final answer is not scraped from the terminal; it is read from that window's session transcript (`~/.claude/projects/…/<session UUID>.jsonl`) and posted to the thread. One participant = one window = one unit instance. Design: `_plan/herdr-adapter.md`.

- While the window is not `idle`/`done` (a person is using it · waiting for approval) the adapter does not claim — the delivery stays queued on the server and goes out once the window is free. Concurrency is fixed at 1.
- If the window waits for approval mid-turn (`blocked`), the adapter does not answer it; it posts «Window waiting for approval» as progress — answer it in that window.
- Cancel sends one Esc to the window. Stopping the adapter leaves the window alone (the server marks that run `unknown`).
- The first line of the injected text is `[brainStorm <run id> · thread «title» · from name]` — the window shows which thread and who it came from.

Example layout — server on its own machine (CT · VM), adapter on the machine running herdr, front end a reverse proxy on yet another machine (e.g. Nginx Proxy Manager · wildcard certificate):

1. Server machine (root): unpack the built repository and run `deploy/install.sh <dir>`.
2. The proxy is on another machine, so the server must also listen on its own IP. `/etc/brainstorm/brainstorm.env`:

   ```ini
   BRAINSTORM_ALLOW_EXTERNAL=1
   BRAINSTORM_LISTEN=127.0.0.1:8080,<server IP>:8080
   BRAINSTORM_ORIGINS=https://<name>.<internal domain>
   BRAINSTORM_TRUSTED_PROXIES=<proxy IP>   # trust X-Forwarded-* from this address only — lockout · audit see the real client IP, auto cookies see https
   BRAINSTORM_SECURE_COOKIE=auto
   ```

   Open 8080 on the server firewall only to the proxy and adapter machines. On the proxy: `https://<name>.<internal domain>` → `http://<server IP>:8080`, WebSocket support on, body limit larger than `BRAINSTORM_ATTACHMENT_MAX_BYTES` (`docs/EXTERNAL-ACCESS.md` C).
3. The adapter's `BRAINSTORM_URL` is `https://<name>.<internal domain>` (through the proxy) or `http://<server IP>:8080`.

Server (root) — a participant and token per window. The token goes to a file, not the screen:

```bash
brainstorm-admin participant add --id track-a --name "Track A"
(umask 077; brainstorm-admin token create --participant track-a --label herdr-host > herdr-track-a.token)
```

On the account that runs the adapter (the account running herdr) — from the repository folder (with the built `dist/`). `~/herdr-track-a.token` is where you moved the token file above. Pick the window by its `pane_id` from `herdr session list` → `herdr --session <session> agent list`:

```bash
mkdir -p ~/.config/brainstorm ~/.config/systemd/user ~/.local/lib/brainstorm-adapter
install -m 600 ~/herdr-track-a.token ~/.config/brainstorm/herdr-track-a.token && rm ~/herdr-track-a.token
cp -r dist package.json ~/.local/lib/brainstorm-adapter/
sed -e "s#/home/you#$HOME#" -e "s#NAME#track-a#" deploy/herdr/herdr.env.example > ~/.config/brainstorm/herdr-track-a.env   # set BRAINSTORM_URL · HERDR_SESSION · HERDR_PANE
sed "s#/usr/bin/env node#$(command -v node)#" deploy/herdr/brainstorm-agent-herdr@.service > ~/.config/systemd/user/brainstorm-agent-herdr@.service
set -a; . ~/.config/brainstorm/herdr-track-a.env; set +a
node ~/.local/lib/brainstorm-adapter/dist/adapter/herdr-adapter.js check
systemctl --user daemon-reload
systemctl --user enable --now brainstorm-agent-herdr@track-a
```

To attach another window, add another token and env under a new name and enable `brainstorm-agent-herdr@<name>` (one unit file). To run without a login session, as root: `loginctl enable-linger <account>`. The window's Claude Code permissions and model are its own — the adapter does not set them.

### OpenAI-compatible server

`adapter/openai-adapter.ts`. Server URL and model come from config. Each turn packs this generation's context, newest first, within a token budget.

```bash
node dist/adapter/openai-adapter.js --help
BRAINSTORM_URL=http://127.0.0.1:8080 BRAINSTORM_TOKEN_FILE=./data/agent.token \
OPENAI_BASE_URL=http://127.0.0.1:8000/v1 OPENAI_MODEL=model-name \
  node dist/adapter/openai-adapter.js check
```

systemd: `/etc/brainstorm/agents/<name>.env` (example `deploy/agents/example.env`) + `<name>.token` (root 600) → `systemctl enable --now brainstorm-agent@<name>`.
Tokens and API keys are passed only via `LoadCredential` (`deploy/systemd/brainstorm-agent@.service`).

### OpenClaw channel plugin

`adapter/openclaw-channel/` — a channel plugin running inside the OpenClaw gateway. To build it, `paths` in `tsconfig.json` must point to OpenClaw's `plugin-sdk` types (adjust to your install path).

## Adapter protocol (summary)

All calls use `Authorization: Bearer <token>` (scope `adapter`).

| Step | Call | Notes |
|---|---|---|
| Claim | `POST /api/adapter/claim {worker}` | Leases one delivery and creates a run. If `run.run_token` is `null` it is a duplicate — do not run it |
| Ack | `POST /api/adapter/deliveries/:id/ack {lease_token}` | Without an ACK within the lease it is delivered again |
| Start | `POST /api/adapter/runs/:id/start {run_token, runtime, model, config_version}` | |
| Heartbeat | `POST /api/adapter/runs/:id/heartbeat {run_token}` | Stop if it returns `{cancel:true}` |
| Cancel ack | `POST /api/adapter/runs/:id/cancelled {run_token}` | Send after stopping → `cancelled` |
| Finish | `POST /api/adapter/runs/:id/complete {run_token, body, usage, …}` / `…/fail {run_token, error}` | Reply message + run completion in one transaction. `model` is the actual value reported by the runtime after the run |
| Rotate session | `POST /api/threads/:id/sessions/rotate {reason}` | Own sessions only |

`session` in the claim response is `{id, generation, base_seq, seen_seq}`. An adapter only needs to pass the messages after `seen_seq` up to the cause message.
Connecting to the WebSocket (`/ws`) with a Bearer token gives a `{"t":"delivery"}` notification whenever a delivery for you appears.
The fake adapter (`adapter/fake-adapter.ts`) is the reference implementation — `--crash-after-claim` · `--slow-ms` · `--no-cancel-ack` simulate failure paths.

## License

[MIT](LICENSE)
