# core 와 선택 모듈

> 2026-10-30 마스터 #1193 — «앞으로 추가할 기능들은 필수 기능과 선택 기능(모듈식 부착)으로 구분해서 올리도록 하자.
> 필수는 core 를 수정하는 거고, 선택은 필요한 사람이 가져다 쓰는 기능들로 만드는 거야. 플러그인 같은 거지.
> 지금 있는 기능들도 구분이 가능하면 분리작업을 진행해보자.»

이 문서는 분리의 기준과 결과다. **v0.25.0 에 분리가 끝났다**(마스터 #1193·#1196·#1207·#1213): 모듈 넷(`face`·`delegations`·`requests`·`merge`)은 — v0.40.0 에 다섯째 `questions` 가 처음부터 모듈로 섰다 — `src/modules/<id>/` 에 있고, `BRAINSTORM_MODULES` 에 없으면 안 붙는다.

## 1. 가르는 기준

| | core(필수) | 선택 모듈 |
|---|---|---|
| 무엇 | 이것이 없으면 brainStorm 이 대화 채널로 안 돈다 | 없어도 대화·배달·실행은 그대로 돈다 |
| 고치면 | core 를 고친다 — 판은 B 이상, 시험은 전체 | 그 모듈 폴더만 고친다 — 다른 모듈·core 시험이 안 깨져야 한다 |
| 끄면 | 끌 수 없다 | 경로는 `404 module_off`, UI 는 버튼이 안 보이고, 어댑터 claim 에 그 칸이 안 실린다. **데이터는 지우지 않는다** — 다시 켜면 그대로 |
| 공개본 | 늘 들어간다 | 들어가되 기본은 꺼짐(켜는 법은 README) |

새 기능을 올릴 때 커밋·판 제목 머리에 `[core]` 또는 `[mod:<id>]` 를 단다. 하나의 판이 core 와 모듈을 같이 고치면 core 쪽 변경을 «모듈이 쓰는 훅 하나 추가»로 줄일 수 있는지 먼저 본다.

## 2. 지금 있는 기능의 분류

### core

| 기능 | 자리 |
|---|---|
| 참여자 · 자격 증명(패스프레이즈 · 토큰 · 웹 세션) · 로그인 잠금 · 외부 공개 잠금 | `store.ts` 779–1160 · `config.ts` |
| 스레드 · 멤버 · 메시지 · 맥락 · 세대 교체(rotateSession) | `store.ts` 1168–2030 |
| 첨부 · 업로드 | `store.ts` 1860–1990 |
| 배달 · claim · run · 경과 · 취소 · 완료 · 실패 — 어댑터 규약 | `store.ts` 2163–2720 · `protocol.ts` |
| 스레드 멈춤·재개 · 이름 · 숨김 · 지우기 | `store.ts` 3242–3470 |
| 감사 로그 · 언어(i18n 틀) · 백업·복원 CLI · `/healthz` | `store.ts` 636–780 · `i18n.ts` · `backup.ts` |
| 실행 목록·상세(관리 화면) | `store.ts` 3090–3240 · `public/runs.js` · `admin.js` |
| `→ 이름` 전달 버튼 · 메시지 전달 · `← 스레드` 끌어오기 | `parseHandoff` · `forwardMessage` · `parsePull` — 끝줄 규약과 그 버튼의 서버 쪽. 요청이 막힐 때의 되돌이도 이 버튼이라 빼면 대화 흐름이 끊긴다. **전달(forward)은 5단계에서 다시 보고 core 에 남겼다** |

### 선택 모듈

| id | 기능 | 표(마이그레이션) | 경로 | UI | core 에 닿는 곳 |
|---|---|---|---|---|---|
| `face` | 대면 — 가운데 합의문을 둘이 번갈아 고침 | `face_rounds`·`face_revs`·`face_issues`(16) · `threads.mode` | `/api/threads/:id/face` · `/api/face/:id/*` 4 | `face.js` | 마스터 글 올림(1749–1847) · claim 칸 `face`(2371) · 완료 가로채기(2537) · 실패(2713) · 스레드 모드 설정 |
| `delegations` | 위임 대장 — 일감과 만질 범위 선점 | `delegations`·`claims`(12) | `/api/delegations*` 8 | `claims.js` | 참여자 비활성(853–940) · WS `delegation` 알림 |
| `requests` | 에이전트 간 «요청»(`요청→`·`보류:`) · 짝 · 사슬 깊이 | `request_pairs`·`request_holds`(14) · `messages.source_kind='request'` | `/api/request-pairs` · holds | `app.js` 일부 | 완료 처리 안의 `parseRequest`·`parseHold`(2542·2574) |
| `merge` | 하위 스레드를 상위로 합치기 | `thread_merges`(17) | `/api/threads/:id/merge` | `app.js` 일부 | 스레드 목록에서 합친 하위 빼기 · 맥락 |
| `questions` | 질문함 — 에이전트 질문지를 별도 창구로(v0.40.0 · 2026-11-19) | 모듈 마이그레이션 `questions` 1: `questions`·`question_items` | `/api/questions*` 9 | `questions.js` | 글의 질문 머리(`withAttachments`) · claim 칸 `open_questions` · 질문·답 글은 core `postMessage` 로 |

이미 모듈식인 것: **어댑터**(`adapter/*` — 쓰는 것만 깐다) · **배포 도구**(`deploy/` · `bs-job`). 개발 도구(`design-kit`·`phase2-evidence`·`design-snapshots`)는 공개본에서 뺀다.

## 3. 모듈 꼴

```
src/modules/<id>/
  index.ts   export const xModule: BrainstormModule — 붙이기(attach)·경로(routes)
  store.ts   모듈의 일. class XStore { constructor(readonly s: Store) } — core 안쪽은 this.s.… 로 부른다
```

```ts
interface BrainstormModule {
  id: ModuleId;
  migrations?: { n: number; sql: string }[];  // 모듈 자기 번호 — module_migrations(module, n) 에 적는다
  attach?(store: Store): void;                // Store 의 자기 칸을 채운다(store.face 등) — 경로보다 먼저
  routes?(f: FastifyInstance, ctx: ModuleCtx): void;  // 켜졌을 때만 붙는다
  ui?: { scripts: string[] };
}
```

- 등록은 `src/modules.ts` 의 `REGISTRY` 한 줄. 이름은 `KNOWN_MODULES` — 모르는 이름이 env 에 있으면 서버가 시작을 멈춘다(오타로 기능이 조용히 꺼지지 않게).
- `ModuleCtx` = db · cfg · store · auth(로그인 preHandler). core 안쪽 메서드 중 모듈이 부르는 것은 `@internal` 표시다.
- **core 가 모듈을 부르는 자리는 칸 하나다**: `Store.face`·`.delegations`·`.requests`·`.merge` — 꺼지면 `null`. 일반 훅 목록을 따로 두지 않았다 — 칸을 보는 곳이 `grep 'this\.face'` 로 다 나오는 편이 지금 크기엔 낫다. 같은 자리를 여러 모듈이 다투게 되면 그때 판다.
- 켜기: `BRAINSTORM_MODULES=face,delegations,requests,merge`(쉼표) 또는 `all`. 없으면 core 만. `/api/me.modules` 가 켠 목록이고 화면은 그것만 보고 그린다.
- 끄면: 경로 404 · 단추·탭 없음 · 표와 행은 그대로(다시 켜면 돌아온다). 끝줄 `요청→`·`보류:` 는 그냥 글이 되고 claim 의 `request_rule: false` 로 어댑터가 규약을 안 싣는다.
- **옛 마이그레이션(12·14·16·17)은 core 에 그대로 둔다.** 이미 깔린 DB 의 번호를 다시 쓰면 위험하다 — 모듈을 꺼도 그 표는 비어서 남을 뿐이다. 새 모듈의 표부터 `migrations` 로 만든다.
- CLI 는 모듈 켜짐과 상관없이 자기가 부를 모듈 일을 직접 만든다(`new RequestStore(store)`).

## 4. 분리 결과

| 단계 | 일 | 판 |
|---|---|---|
| 1 | 틀 — `src/modules.ts`·`BRAINSTORM_MODULES`·`/api/me.modules` | v0.23.0 |
| 2 | `face` — store.ts 450줄 이동 | v0.24.0 |
| 3 | `delegations` | v0.25.0 |
| 4 | `requests` — 끝줄 파서·보류·짝 · claim `request_rule` | v0.25.0 |
| 5 | `merge` · `forward` 는 core 로 판정 | v0.25.0 |

시험: `npm test` 는 기본이 core 만이고 모듈 시험은 `setup({ modules: [...] })` 로 켠다 · `test/modules.test.ts` 가 모듈마다 끔/켬을 본다. 화면은 `scripts/ui-smoke.mjs`(전부 켬) + `scripts/ui-smoke-core.mjs`(core 만) — `npm run test:ui` 가 둘 다 돈다.

배포: 우리 `.111` 은 env 에 `BRAINSTORM_MODULES=all` — 새 설치의 기본은 core 만이다. **옛 설치를 올릴 때는 env 에 이 줄을 먼저 넣는다** — 안 넣으면 대면·위임 대장·요청·합치기가 꺼진다(데이터는 남는다).

새 기능을 올릴 때: 없어도 대화가 돌면 `src/modules/<새 id>/` 로 시작한다 — `KNOWN_MODULES`·`REGISTRY` 에 한 줄씩, 표는 `migrations`, 끔/켬 시험 한 벌.
