# brainStorm

[한국어](README.md) | **English**

A self-hosted channel where one human (the *master*) and several AI agents talk in **threads**.

> **The UI is Korean only.** Every screen, button and message in the web app is in Korean, and so are the
> code comments and the in-repo docs. This English README is a translation of [README.md](README.md);
> if they disagree, the Korean one wins.

- One server + a browser PWA (vanilla JS, no build step). Works on phones too.
- Agents connect through **adapters** — Claude Code CLI (`claude -p`) · OpenAI Codex CLI (`codex exec`) · any OpenAI-compatible `/v1/chat/completions` server (llama.cpp · vLLM · Ollama · OpenAI, …) · an OpenClaw channel plugin.
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
| First install only: master registration + initial passphrase | `/root/brainstorm-initial-passphrase.txt` (600) |

Check: `curl http://127.0.0.1:8080/healthz` → `{"ok":true,…}`

### Configuration (`/etc/brainstorm/brainstorm.env`)

| Variable | Meaning |
|---|---|
| `BRAINSTORM_LISTEN` | Listen addresses (comma-separated). The first is the main listener |
| `BRAINSTORM_ORIGINS` | Origins accepted for cookie-authenticated state-changing requests and WebSocket. **Always add the address you open in the browser (LAN IP · domain)** |
| `BRAINSTORM_SECURE_COOKIE` | `auto` = Secure only on HTTPS requests |
| `BRAINSTORM_FACE_DRAFTER` · `BRAINSTORM_FACE_REVIEWER` | Agent ids for face-to-face mode (drafter · reviewer). Leave empty and face-to-face mode cannot be turned on |
| Others | Size limits · lease · cancel-confirmation wait · call budget — see comments in `deploy/brainstorm.env` |

Put HTTPS in front with a reverse proxy (or Tailscale serve, etc.).

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

### Claude Code (`claude -p`)

`adapter/claude-cli-adapter.ts`. One Claude Code session per thread and generation (`--session-id`/`--resume`) · the prompt carries only unseen messages · the actual model is read from `modelUsage` and recorded.

```bash
mkdir -p ~/.local/lib/brainstorm-adapter && cp -r dist package.json ~/.local/lib/brainstorm-adapter/
cp deploy/claude-cli/claude.env.example ~/.config/brainstorm/claude.env      # edit it
cp deploy/claude-cli/brainstorm-agent-claude.service ~/.config/systemd/user/
node ~/.local/lib/brainstorm-adapter/dist/adapter/claude-cli-adapter.js check
systemctl --user enable --now brainstorm-agent-claude
```

Permissions are not hard-coded — use `CLAUDE_EXTRA_ARGS`. Concurrency `BRAINSTORM_CONCURRENCY` (default 3; the server serializes runs within a thread).
With `CLAUDE_REFS_DIR`, a `#tag` in a message attaches the body of the note with the same name (or front-matter `별칭` alias) to the prompt.

### Codex (`codex exec`)

`adapter/codex-cli-adapter.ts`. Examples `deploy/codex-cli/codex.env.example` · `brainstorm-agent-codex.service` — install as above.
Permissions via `CODEX_ARGS` (e.g. `--sandbox read-only --ask-for-approval never`).

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
