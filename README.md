# brainStorm

사람 한 명(마스터)과 AI 에이전트 여럿이 **스레드**로 대화하는 자체 호스팅 채널.

- 한 서버 + 브라우저 PWA(빌드 없는 바닐라 JS). 폰에서도 쓴다.
- 에이전트는 **어댑터**로 붙는다 — Claude Code CLI(`claude -p`) · OpenAI Codex CLI(`codex exec`) · OpenAI 호환 `/v1/chat/completions` 서버(llama.cpp · vLLM · Ollama · OpenAI 등) · OpenClaw 채널 플러그인.
- 어댑터는 서버로 **나가는 연결만** 연다(에이전트 쪽에 포트가 필요 없다).
- 스택: TypeScript(Node 22) · Fastify · ws · better-sqlite3(WAL)

UI·문서·코드 주석은 한국어다.

## 무엇을 하나

- **메인 채팅방 + 스레드 트리** — 어느 글에서든 분기하고, 분기할 때 가져갈 맥락(시점·범위)을 고른다. 하위 스레드는 상위 대화로 **합칠** 수 있다(묶음 글 하나로).
- **수신자는 마스터가 고른다** — 본문 속 `@이름`은 호출이 아니다. 에이전트끼리는 서로를 자동으로 부르지 않는다(아래 «요청 창구»만 예외).
- **실행 판정** — 전달은 최소 한 번(lease), 실행은 `(원인, 수신자, 세대)`로 한 번만. 어댑터가 죽으면 `unknown`이고 자동 재실행하지 않는다. 취소는 «요청»이고 어댑터의 확인으로 확정된다.
- **세션 세대** — 에이전트별·스레드별 세션. 교체하면 새 세대는 옛 원문을 받지 않는다(맥락 포화 시 자동 교체 가능).
- **전달** — 에이전트 답 끝줄 `→ 이름`은 마스터 화면에 «전달» 버튼으로 뜬다. 전달할 때 마스터 메모를 덧붙일 수 있다.
- **요청 창구** — 허용한 에이전트 짝끼리는 끝줄 `요청→ 이름`으로 서로에게 조사·검증을 맡긴다(지시가 아니라 요청 · 연쇄 상한 · 받은 쪽은 `보류: 사유`로 거절).
- **대면 모드** — 두 에이전트가 턴을 번갈아 가며 합의문 하나를 고친다. 한 턴이 문서를 안 바꾸면 합의.
- **위임 대장** — 작업을 넘기기 전에 만질 범위(경로·자원)를 선점하고, 겹치면 넘기지 않는다.
- **첨부**(그림·PDF·텍스트) · 마크다운 렌더 · 읽음/경과 · 검색 · 보관/숨김/휴지통 · 감사 기록 · 에이전트 연결 상태 화면.

## 원칙 (코드가 지키는 것)

| 원칙 | 어디서 |
|---|---|
| **REST가 원본, WebSocket은 알림만** — `{"t":"msg","thread_id":…,"seq":N}`만 보내고, 클라이언트는 커서(`after=seq`)로 다시 읽는다 | `src/app.ts` |
| **작성자는 서버가 인증으로 정한다** — 다른 `author_id`를 내밀면 403 `impersonation` | `Store.postMessage` |
| **수신자는 구조화된 칸(`recipients`)으로만** — 본문 속 `@이름`은 호출이 아니다 | 〃 |
| **에이전트 간 자동 호출 끔 — 허용 짝의 «요청»만 예외** — 에이전트 글은 전달을 만들지 않는다. 예외는 출처 `request`: 허용 짝(`request_pairs` · CLI 로만 바꿈) · 받는 이 한 명 · 마스터 글 뒤 연쇄 상한 안 | 〃 |
| 에이전트는 `instruction`(사용자 지시) 출처로 못 쓴다 — 인용·관찰·요청이 지시로 승격되지 않는다 | 〃 |
| 메시지와 전달은 **한 트랜잭션** | 〃 |
| 전달은 **최소 한 번**(lease), 실행은 `(원인, 수신자, 세대)`로 **한 번만** · 세션당 활성 실행 하나 | `claim`, DB 유니크 인덱스 |
| 어댑터가 실행 중 죽으면 lease 만료 → run **`unknown`**, **자동 재실행 없음** | `Store.sweep` |
| **실행 중 취소는 «요청»이지 확정이 아니다** — 어댑터 확인이면 `cancelled`, 무응답이면 `unknown`, 확인 전에 온 완료는 `succeeded`(완료 우선) | `cancelRun`·`ackCancel`·`completeRun` |
| 분기 스레드는 부모 전체를 물려받지 않는다 — 분기 시점과 가져올 메시지를 고른다 | `forkThread` |
| 멤버가 아닌 스레드는 «없음»(404)으로 보인다 | `requireRead` |
| **민감 작업과 거부는 감사 기록에 남는다** — 본문·토큰·패스프레이즈는 넣지 않는다 | `Store.audit` |
| **에이전트 토큰은 화면에서 발급하지 않는다** — 서버 안 CLI → 600 파일. 화면은 조회·폐기만 | `listConnections`·`revokeCredential` |

## 빠르게 돌려 보기

```bash
npm ci
npm run build
mkdir -p data
BRAINSTORM_DATA_DIR=./data npm run admin -- init > ./data/pass.txt   # 마스터 등록 + 초기 패스프레이즈
BRAINSTORM_DATA_DIR=./data npm start                                  # http://127.0.0.1:8080
```

브라우저로 열어 `data/pass.txt`의 패스프레이즈로 로그인한다.

가짜 에이전트 하나 붙이기(모델 없음 · 에코 답):

```bash
BRAINSTORM_DATA_DIR=./data npm run admin -- participant add --id echo --name Echo
BRAINSTORM_DATA_DIR=./data npm run admin -- token create --participant echo --label local > ./data/echo.token
BRAINSTORM_TOKEN=$(cat data/echo.token) node dist/adapter/fake-adapter.js run --url http://127.0.0.1:8080
```

## 시험

```bash
npm test          # 빌드 + node:test (서버를 임시 디렉터리로 띄우고 가짜 어댑터를 자식 프로세스로 돌린다)
npm run test:ui   # UI 스모크: jsdom 으로 public/*.js 를 실제 서버에 붙여 화면 전체를 돌린다
```

## 배포 (systemd)

빌드한 저장소를 서버에 풀고 root 로 `deploy/install.sh <디렉터리>`. 여러 번 돌려도 된다.

| 무엇 | 어디 |
|---|---|
| 시스템 계정 `brainstorm` (nologin) | |
| 앱(root 소유, 읽기 전용) | `/opt/brainstorm` (`npm ci --omit=dev`) |
| 데이터(750) | `/var/lib/brainstorm/{brainstorm.db, attachments/, backups/}` |
| 설정(비밀 없음) | `/etc/brainstorm/brainstorm.env` — 없을 때만 `deploy/brainstorm.env`를 깐다 |
| 서비스 | `brainstorm.service` |
| 매일 백업 | `brainstorm-backup.timer` (03:40) |
| 에이전트 어댑터 템플릿(켜지 않는다) | `brainstorm-agent@.service`(OpenAI 호환), 설정 자리 `/etc/brainstorm/agents/` |
| 명령 | `/usr/local/bin/brainstorm-{admin,backup,restore}` |
| 첫 설치 때만: 마스터 등록 + 초기 패스프레이즈 | `/root/brainstorm-initial-passphrase.txt` (600) |

확인: `curl http://127.0.0.1:8080/healthz` → `{"ok":true,…}`

### 설정 (`/etc/brainstorm/brainstorm.env`)

| 변수 | 뜻 |
|---|---|
| `BRAINSTORM_LISTEN` | 듣는 주소들(쉼표). 첫 주소가 주 리스너 |
| `BRAINSTORM_ORIGINS` | 쿠키 인증 상태 변경 요청·WebSocket 이 받는 Origin. **브라우저로 여는 주소(LAN IP·도메인)를 반드시 더한다** |
| `BRAINSTORM_SECURE_COOKIE` | `auto` = HTTPS 요청일 때만 Secure |
| `BRAINSTORM_FACE_DRAFTER` · `BRAINSTORM_FACE_REVIEWER` | 대면 모드의 초안·검토 에이전트 id. 비우면 대면 모드를 못 켠다 |
| 그 밖 | 크기 제한·lease·취소 확인 대기·호출 예산 — `deploy/brainstorm.env` 주석 |

HTTPS 는 앞단 리버스 프록시(또는 Tailscale serve 등)로 붙인다.

### 마스터 로그인 · 관리 CLI

```bash
brainstorm-admin set-passphrase < 새-패스프레이즈-파일     # 12자 이상 · 기존 웹 세션은 끊긴다
brainstorm-admin participant add --id agent-a --name "에이전트 A"
brainstorm-admin participant list
brainstorm-admin token create --participant agent-a --label host-a [--expires-days 90]   # 원문은 한 번만 표준출력
brainstorm-admin token list
brainstorm-admin token revoke cred_XXXX
brainstorm-admin member set --thread th_XXX --participant agent-a [--no-read] [--no-post] [--remove]
brainstorm-admin sessions rotate --thread th_XXX --agent agent-a --reason 포화
brainstorm-admin request-pair add --from agent-a --to agent-b    # 요청 창구 허용 짝(방향 있음) · 빼기는 remove
brainstorm-admin participant disable --id agent-a                # 토큰 폐기 · 세션 은퇴 · 멤버에서 뺌
brainstorm-admin audit list [--limit 50]
```

로그인 실패 10번이면 10분 잠긴다(IP별). CLI 작업은 감사 기록에 `cli:root` 로 남는다.

### 백업 · 복원

```bash
brainstorm-backup                          # → /var/lib/brainstorm/backups/brainstorm-YYYYMMDD-HHMMSS.tar.gz
brainstorm-restore /var/lib/brainstorm/backups/brainstorm-….tar.gz
```

백업은 SQLite 온라인 백업 → `integrity_check` → 첨부 복사. 복원은 지금 DB 를 지우지 않고 옆으로 치운 뒤 풀고,
대기 전달은 `cancelled`, 진행 중 실행은 `unknown`으로 바꾼다(옛 작업을 자동으로 다시 돌리지 않는다).

## 에이전트 붙이기

공통: 서버에서 참여자를 등록하고 토큰을 발급해 **모드 600 파일**로 어댑터 쪽에 옮긴다(그룹·기타 권한이 있으면 어댑터가 시작하지 않는다).
어댑터는 `check`(신원 확인만)와 `run`(상주)을 가진다. 종료 코드 2 = 설정 오류, 4 = 인증 거절.

### Claude Code (`claude -p`)

`adapter/claude-cli-adapter.ts`. 스레드·세대마다 Claude Code 세션 하나(`--session-id`/`--resume`) · 프롬프트에는 아직 못 본 글만 · 실제 모델은 `modelUsage`에서 읽어 기록.

```bash
mkdir -p ~/.local/lib/brainstorm-adapter && cp -r dist package.json ~/.local/lib/brainstorm-adapter/
cp deploy/claude-cli/claude.env.example ~/.config/brainstorm/claude.env      # 고친다
cp deploy/claude-cli/brainstorm-agent-claude.service ~/.config/systemd/user/
node ~/.local/lib/brainstorm-adapter/dist/adapter/claude-cli-adapter.js check
systemctl --user enable --now brainstorm-agent-claude
```

권한은 코드에 박지 않는다 — `CLAUDE_EXTRA_ARGS`. 동시 실행 `BRAINSTORM_CONCURRENCY`(기본 3, 같은 스레드는 서버가 직렬로 낸다).
`CLAUDE_REFS_DIR`를 주면 글의 `#태그`와 같은 이름(또는 앞머리 `별칭`)의 노트 본문을 프롬프트에 붙인다.

### Codex (`codex exec`)

`adapter/codex-cli-adapter.ts`. 본보기 `deploy/codex-cli/codex.env.example` · `brainstorm-agent-codex.service` — 설치는 위와 같다.
권한은 `CODEX_ARGS`(예: `--sandbox read-only --ask-for-approval never`).

### OpenAI 호환 서버

`adapter/openai-adapter.ts`. 서버 주소·모델은 설정이 정한다. 매 턴 이 세대의 맥락을 토큰 예산 안에서 최근부터 넣는다.

```bash
node dist/adapter/openai-adapter.js --help
BRAINSTORM_URL=http://127.0.0.1:8080 BRAINSTORM_TOKEN_FILE=./data/agent.token \
OPENAI_BASE_URL=http://127.0.0.1:8000/v1 OPENAI_MODEL=model-name \
  node dist/adapter/openai-adapter.js check
```

systemd: `/etc/brainstorm/agents/<이름>.env`(본보기 `deploy/agents/example.env`) + `<이름>.token`(root 600) → `systemctl enable --now brainstorm-agent@<이름>`.
토큰·API 키는 `LoadCredential`로만 넘어간다(`deploy/systemd/brainstorm-agent@.service`).

### OpenClaw 채널 플러그인

`adapter/openclaw-channel/` — OpenClaw 게이트웨이 안에서 도는 채널 플러그인. 빌드할 때 `tsconfig.json`의 `paths`가 OpenClaw 의 `plugin-sdk` 타입을 가리켜야 한다(설치 경로에 맞게 고친다).

## 어댑터 프로토콜 (요약)

모두 `Authorization: Bearer <토큰>` (scope `adapter`).

| 단계 | 호출 | 비고 |
|---|---|---|
| 받기 | `POST /api/adapter/claim {worker}` | 전달 하나를 lease로 빌리고 실행(run)을 만든다. `run.run_token`이 `null`이면 중복 — 돌리지 않는다 |
| 받았음 | `POST /api/adapter/deliveries/:id/ack {lease_token}` | lease 안에 ACK가 없으면 다시 나간다 |
| 시작 | `POST /api/adapter/runs/:id/start {run_token, runtime, model, config_version}` | |
| 살아 있음 | `POST /api/adapter/runs/:id/heartbeat {run_token}` | `{cancel:true}`면 멈춘다 |
| 중단 확인 | `POST /api/adapter/runs/:id/cancelled {run_token}` | 멈춘 뒤 보낸다 → `cancelled` |
| 끝 | `POST /api/adapter/runs/:id/complete {run_token, body, usage, …}` / `…/fail {run_token, error}` | 답 메시지 + run 완료가 한 트랜잭션. `model`은 실행 뒤 런타임이 알려 준 실제 값 |
| 세션 교체 | `POST /api/threads/:id/sessions/rotate {reason}` | 자기 세션만 |

claim 응답의 `session`은 `{id, generation, base_seq, seen_seq}`다. 어댑터는 `seen_seq` 뒤 ~ 원인 메시지만 새로 넘기면 된다.
WebSocket(`/ws`)에 Bearer로 붙으면 자기 앞 전달이 생길 때 `{"t":"delivery"}` 알림을 받는다.
가짜 어댑터(`adapter/fake-adapter.ts`)가 참조 구현이다 — `--crash-after-claim` · `--slow-ms` · `--no-cancel-ack`로 실패 경로를 흉내 낸다.

## 라이선스

[MIT](LICENSE)
