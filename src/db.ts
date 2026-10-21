// SQLite 열기 + 코드 안의 마이그레이션. user_version 으로 판을 센다.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/** 마이그레이션 한 판 — SQL 묶음이나, SQL 로 못 하는 것(CHECK 넓히기)은 함수 */
type Migration = string | ((db: DB) => void);

/** messages.source_kind CHECK — 마이그레이션 1의 문자열 그대로(14 가 이것을 넓힌다) */
const SOURCE_CHECK_V1 = "CHECK (source_kind IN ('instruction','quote','observation','proposal'))";
const SOURCE_CHECK_V14 = "CHECK (source_kind IN ('instruction','quote','observation','proposal','request'))";

const MIGRATIONS: Migration[] = [
  // 1 — v2 데이터 계약 전체 (context_snapshots·attachments 는 1단계에서 표만 쓴다)
  `
  CREATE TABLE participants (
    id              TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^a-z0-9_-]*'),
    kind            TEXT NOT NULL CHECK (kind IN ('human','agent')),
    name            TEXT NOT NULL,
    is_master       INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0,1)),
    passphrase_hash TEXT,
    created_at      INTEGER NOT NULL,
    disabled_at     INTEGER
  );
  CREATE UNIQUE INDEX participants_one_master ON participants(is_master) WHERE is_master = 1;

  CREATE TABLE credentials (
    id             TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    token_hash     TEXT NOT NULL UNIQUE,
    scope          TEXT NOT NULL,            -- JSON 배열, 예: ["adapter"]
    label          TEXT,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER,
    revoked_at     INTEGER,
    last_used_at   INTEGER
  );

  CREATE TABLE web_sessions (
    id_hash        TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL
  );

  CREATE TABLE threads (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','archived')),
    default_recipient TEXT REFERENCES participants(id),
    parent_thread_id  TEXT REFERENCES threads(id),
    fork_seq          INTEGER,               -- 분기 시점 메시지(부모의 seq)
    invoke_paused     INTEGER NOT NULL DEFAULT 0,  -- «새 호출 금지»
    created_by        TEXT NOT NULL REFERENCES participants(id),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE TABLE thread_members (
    thread_id      TEXT NOT NULL REFERENCES threads(id),
    participant_id TEXT NOT NULL REFERENCES participants(id),
    can_read       INTEGER NOT NULL DEFAULT 1,
    can_post       INTEGER NOT NULL DEFAULT 1,
    can_invoke     INTEGER NOT NULL DEFAULT 0,
    added_at       INTEGER NOT NULL,
    PRIMARY KEY (thread_id, participant_id)
  );

  CREATE TABLE messages (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,   -- 서버 순번(전역, 단조 증가)
    id             TEXT NOT NULL UNIQUE,
    thread_id      TEXT NOT NULL REFERENCES threads(id),
    author_id      TEXT NOT NULL REFERENCES participants(id),  -- 서버가 인증으로 확정
    client_key     TEXT NOT NULL,                        -- 클라이언트 중복 방지 키
    body           TEXT NOT NULL,
    body_version   INTEGER NOT NULL DEFAULT 1,
    reply_to_seq   INTEGER REFERENCES messages(seq),
    quote_of_seq   INTEGER REFERENCES messages(seq),
    source_kind    TEXT NOT NULL CHECK (source_kind IN ('instruction','quote','observation','proposal')),
    input_mode     TEXT NOT NULL DEFAULT 'text' CHECK (input_mode IN ('text','voice')),
    recipients     TEXT NOT NULL DEFAULT '[]',          -- 구조화된 수신자(JSON). 본문에서 파싱하지 않는다
    call_budget    INTEGER,                              -- 요청 하나당 호출 예산
    hop            INTEGER NOT NULL DEFAULT 0,
    trigger_run_id TEXT,                                 -- 에이전트 답이면 그 run
    created_at     INTEGER NOT NULL,
    UNIQUE (author_id, client_key)
  );
  CREATE INDEX messages_thread_seq ON messages(thread_id, seq);

  -- 분기 스레드가 부모에서 «가져온» 메시지. 부모 전체를 상속하지 않는다.
  CREATE TABLE thread_context (
    thread_id   TEXT NOT NULL REFERENCES threads(id),
    message_seq INTEGER NOT NULL REFERENCES messages(seq),
    PRIMARY KEY (thread_id, message_seq)
  );

  CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    message_seq INTEGER NOT NULL REFERENCES messages(seq),
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,     -- 데이터 디렉터리 기준 상대 경로 (웹 실행 경로와 분리)
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE agent_sessions (
    id                 TEXT PRIMARY KEY,
    thread_id          TEXT NOT NULL REFERENCES threads(id),
    agent_id           TEXT NOT NULL REFERENCES participants(id),
    generation         INTEGER NOT NULL,
    runtime            TEXT,
    actual_model       TEXT,
    config_version     TEXT,
    prev_session_id    TEXT REFERENCES agent_sessions(id),
    status             TEXT NOT NULL CHECK (status IN ('active','retired')),
    reason             TEXT,
    last_delivered_seq INTEGER,
    created_at         INTEGER NOT NULL,
    ended_at           INTEGER,
    UNIQUE (thread_id, agent_id, generation)
  );
  CREATE UNIQUE INDEX agent_sessions_one_active ON agent_sessions(thread_id, agent_id) WHERE status = 'active';

  CREATE TABLE deliveries (
    id               TEXT PRIMARY KEY,
    message_seq      INTEGER NOT NULL REFERENCES messages(seq),
    thread_id        TEXT NOT NULL REFERENCES threads(id),
    recipient_id     TEXT NOT NULL REFERENCES participants(id),
    status           TEXT NOT NULL CHECK (status IN ('pending','leased','acked','dead','cancelled')),
    lease_token_hash TEXT,
    lease_expires_at INTEGER,
    attempts         INTEGER NOT NULL DEFAULT 0,
    acked_at         INTEGER,
    retry_at         INTEGER,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (message_seq, recipient_id)
  );
  CREATE INDEX deliveries_recipient_status ON deliveries(recipient_id, status);

  CREATE TABLE runs (
    id               TEXT PRIMARY KEY,
    thread_id        TEXT NOT NULL REFERENCES threads(id),
    trigger_seq      INTEGER NOT NULL REFERENCES messages(seq),   -- 원인 이벤트
    delivery_id      TEXT REFERENCES deliveries(id),
    agent_id         TEXT NOT NULL REFERENCES participants(id),
    session_id       TEXT NOT NULL REFERENCES agent_sessions(id),
    generation       INTEGER NOT NULL,
    input_snapshot   TEXT NOT NULL,     -- JSON: 넘긴 메시지 seq 목록 등
    state            TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled','unknown')),
    run_token_hash   TEXT,
    lease_expires_at INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    started_at       INTEGER,
    ended_at         INTEGER,
    error            TEXT,
    usage            TEXT,
    result_seq       INTEGER REFERENCES messages(seq),
    UNIQUE (trigger_seq, agent_id, generation)
  );
  -- 세션 하나에 활성 실행 하나
  CREATE UNIQUE INDEX runs_one_active_per_session ON runs(session_id) WHERE state IN ('queued','running');
  CREATE INDEX runs_thread ON runs(thread_id, created_at);

  CREATE TABLE context_snapshots (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES agent_sessions(id),
    thread_id         TEXT NOT NULL REFERENCES threads(id),
    source_refs       TEXT NOT NULL,   -- JSON [{seq, body_version}]
    summary           TEXT,
    summary_author_id TEXT REFERENCES participants(id),
    summary_model     TEXT,
    constraints       TEXT,
    counter_evidence  TEXT,
    unverified        TEXT,
    excluded_scope    TEXT,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2 — 2단계(메티 어댑터): 세대 경계. 새 세대는 base_seq 뒤의 메시지만 원문으로 받는다
  //     (그 앞은 context_snapshots 로 넘긴 것만). 1세대는 NULL = 스레드 처음부터.
  `
  ALTER TABLE agent_sessions ADD COLUMN base_seq INTEGER;
  `,
  // 3 — 기획 대조 1단계: «메인 채팅방»과 스레드 생성 중복 방지.
  //     kind='room' 은 하나뿐(부분 유니크 인덱스). 기존 행은 전부 'thread' 로 남는다 — 기록을 고치지 않는다.
  //     방 행 자체는 여기서 만들지 않는다: 마스터(created_by)가 있어야 하므로 Store.ensureRoom() 이 기동·init 때 만든다.
  //     client_key 는 스레드 생성·분기 요청의 중복 방지 키(같은 생성자 안에서 유일). 옛 행은 NULL.
  `
  ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread' CHECK (kind IN ('room','thread'));
  CREATE UNIQUE INDEX threads_one_room ON threads(kind) WHERE kind = 'room';
  ALTER TABLE threads ADD COLUMN client_key TEXT;
  CREATE UNIQUE INDEX threads_client_key ON threads(created_by, client_key) WHERE client_key IS NOT NULL;
  `,
  // 4 — 기획 대조 2단계: 실행 취소의 «요청 → 어댑터 확인 / 무응답 제한 → unknown» 판정(정책 1).
  //     runs 에 취소 처리 시각 칸 여섯 + 상태 변경 이력 표 run_events. 기존 행은 고치지 않는다 —
  //     옛 실행은 새 칸이 모두 NULL 이고 이벤트가 없다(화면은 created_at/started_at/ended_at 으로 대신 보여 준다).
  //     run 상태 집합(CHECK)은 그대로다: «중단 요청됨» = state 'running' + cancel_requested_at 있음.
  `
  ALTER TABLE runs ADD COLUMN cancel_requested_by TEXT REFERENCES participants(id);
  ALTER TABLE runs ADD COLUMN cancel_requested_at INTEGER;
  ALTER TABLE runs ADD COLUMN stop_sent_at INTEGER;
  ALTER TABLE runs ADD COLUMN stop_ack_at INTEGER;
  ALTER TABLE runs ADD COLUMN finalized_at INTEGER;
  ALTER TABLE runs ADD COLUMN last_checked_at INTEGER;
  CREATE INDEX runs_created ON runs(created_at);
  CREATE TABLE run_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL REFERENCES runs(id),
    at      INTEGER NOT NULL,
    event   TEXT NOT NULL,
    source  TEXT NOT NULL,   -- 'server' 또는 참여자 id(마스터·어댑터의 에이전트)
    detail  TEXT             -- JSON. 본문·토큰은 넣지 않는다
  );
  CREATE INDEX run_events_run ON run_events(run_id, id);
  `,
  // 5 — 기획 대조 3단계: 민감 작업 감사 기록(정책 9). 새 표 하나 — 기존 표·행은 건드리지 않는다.
  //     한 행 = 사건 하나(요청 또는 최종 결과). 요청과 최종 결과는 corr_id(감사 식별자)로 잇는다(예: 실행 중단 요청 → 어댑터 확인/무응답).
  //     actor_id 는 참여자 id 거나 'cli:root'(CT 안 관리 CLI)·'server'(서버 판정)·'anonymous'(누군지 모르는 인증 실패) — 그래서 FK 를 걸지 않는다.
  //     본문·토큰 원문·토큰 해시·패스프레이즈는 넣지 않는다. before_state/after_state 는 서버가 고른 칸만 담은 JSON.
  //     거부 폭주 상한: 같은 (작업자, 작업 유형, 결과, 사유)가 묶음 시간(기본 1분) 안에 또 오면 새 행 대신 repeat_count·last_at 만 올린다.
  `
  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    corr_id      TEXT NOT NULL,
    actor_id     TEXT NOT NULL,
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('master','agent','cli','server','anonymous')),
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    thread_id    TEXT,
    requested_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    result       TEXT NOT NULL CHECK (result IN ('ok','requested','noop','denied','failed')),
    reason       TEXT,
    before_state TEXT,
    after_state  TEXT,
    repeat_count INTEGER NOT NULL DEFAULT 1,
    last_at      INTEGER NOT NULL
  );
  CREATE INDEX audit_log_at ON audit_log(requested_at);
  CREATE INDEX audit_log_action ON audit_log(action, requested_at);
  CREATE INDEX audit_log_actor ON audit_log(actor_id, requested_at);
  CREATE INDEX audit_log_target ON audit_log(target_id);
  CREATE INDEX audit_log_corr ON audit_log(corr_id);
  `,
  // 6 — 스레드 정리(2026-10-11 마스터): 숨김(목록 표시만) · 휴지통(deleted_at — 에이전트에겐 없는 스레드).
  //     보관은 기존 status 'archived'(읽기 전용) 를 쓴다. 옛 행은 hidden=0 · deleted_at=NULL 로 남는다.
  //     영구 삭제는 행을 지운다(감사 기록은 FK 가 없어 남는다).
  `
  ALTER TABLE threads ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1));
  ALTER TABLE threads ADD COLUMN deleted_at INTEGER;
  ALTER TABLE threads ADD COLUMN deleted_by TEXT;
  `,
  // 7 — 수동 전달(2026-10-12 마스터 #62·#70 · vault Notes/brainStorm-수동-전달.md):
  //     에이전트 답 끝줄 «→ 이름»은 서버가 떼어 messages.handoff_to 에 적는다(전달 아님 — 버튼 표시용).
  //     전달은 마스터가 누를 때만 deliveries 한 줄(forwarded_by · context_upto_seq = 누른 시점의 스레드 머리).
  //     runs.seen_upto = 그 실행이 실제로 받은 맥락의 끝(전달 실행만 · null 이면 result_seq — 옛 판 그대로).
  `
  ALTER TABLE messages ADD COLUMN handoff_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE deliveries ADD COLUMN forwarded_by TEXT;
  ALTER TABLE deliveries ADD COLUMN context_upto_seq INTEGER;
  ALTER TABLE runs ADD COLUMN seen_upto INTEGER;
  `,
  // 8 — 첨부 2판(2026-10-13 마스터 «이미지·문서 첨부»): 파일을 먼저 올리고(uploads) 메시지를 쓸 때 묶는다(attachments 로 옮김).
  //     그래서 에이전트는 첨부가 다 붙은 메시지만 받는다(옛 판은 메시지 뒤에 붙여 claim 과 경주했다).
  //     attachments.kind 는 서버가 내용으로 판별한다(image · pdf · text · file) — 옛 행은 'file' 그대로. mime 은 판별한 형식.
  //     묶이지 않은 업로드는 uploadTtlMs 뒤 걷힌다(행과 파일). 파일 자리는 attachments 와 같은 디렉터리(id 가 이름) — 옮길 때 파일은 그대로다.
  `
  ALTER TABLE attachments ADD COLUMN mime TEXT NOT NULL DEFAULT 'application/octet-stream';
  CREATE TABLE uploads (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES participants(id),
    kind        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX uploads_owner ON uploads(owner_id, created_at);
  `,
  // 9 — 읽음·경과(2026-10-13 마스터 «읽었다는 반응을 되돌려주어 반응없음이 안 나오게»): 어댑터 heartbeat 의 마지막 시각과
  //     경과 한 줄(«읽었음 — 작업 시작» · «도구: Bash …» 등). 화면이 «✓ 읽음 · 경과 · 신호 n초 전»을 보인다.
  //     경과는 실행 중의 표시일 뿐 — run_events 에는 남기지 않는다(본문 조각이 섞일 수 있다). 옛 행은 NULL.
  `
  ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
  ALTER TABLE runs ADD COLUMN progress TEXT;
  ALTER TABLE runs ADD COLUMN progress_at INTEGER;
  `,
  // 10 — 맥락 끌어오기(2026-10-13 마스터 #162 «권장대로» · vault Notes/brainStorm-맥락-가져오기-백구안.md «수렴»):
  //     에이전트 답 끝줄 «← 스레드제목 [#a~#b]»은 서버가 떼어 messages.pull_req 에 적는다(가져오기 아님 — 버튼 표시용).
  //     마스터가 누르면 그 글에 대한 배달 하나(받는 쪽 = 청한 에이전트)에 원문 사본(pulled · JSON)을 붙인다 —
  //     스레드에 메시지를 만들지 않고 원본과 FK 로 묶지 않는다. 배달 속성이라 한 번만 실린다.
  `
  ALTER TABLE messages ADD COLUMN pull_req TEXT;
  ALTER TABLE deliveries ADD COLUMN pulled TEXT;
  ALTER TABLE deliveries ADD COLUMN pulled_from TEXT;
  `,
  // 11 — 자동 세션 교체 · 이어받기(2026-10-15 마스터 #283): 새 세대가 최근 글 원문 + 이어받은 맥락(사서 요약 · baalda 원문 위치)으로
  //      시작하나. 1 이면 base_seq 가 «최근 N개 앞»이고 첫 실행 claim 에 carry 가 붙는다. 옛 행(0)은 예전처럼 빈 손으로 시작.
  `
  ALTER TABLE agent_sessions ADD COLUMN carry INTEGER NOT NULL DEFAULT 0;
  `,
  // 12 — 위임 대장(2026-10-16 마스터 #339·#341): 백구가 백수(작업 세션 여럿)에게 일을 넘기기 전에 만질 범위(claims)를 선점한다.
  //      다른 활성 위임의 선점과 겹치면 넘기지 않는다(검사 + 넣기가 IMMEDIATE 트랜잭션 하나). 일하는 중 더 청한 범위가 잡혀 있으면
  //      기다리지 않고 바로 실패한다(교착 없음) — 백수는 멈추고 «막힘»을 보고한다. 새 표 둘 — 기존 표·행은 건드리지 않는다.
  //      assignee 는 자유 문자열(백수 세션은 여럿이고 한 에이전트 자격 증명 아래 돈다) — 참여자 FK 가 아니다.
  //      released_at IS NULL 이고 위임이 done·cancelled 가 아닌 선점만 «활성»이다. done·cancelled 는 선점을 모두 놓는다.
  `
  CREATE TABLE delegations (
    id           TEXT PRIMARY KEY,
    thread_id    TEXT REFERENCES threads(id),
    source_seq   INTEGER,
    assignee     TEXT NOT NULL,
    title        TEXT NOT NULL,
    spec         TEXT NOT NULL,          -- 작업 명세(마크다운)
    version_slot TEXT CHECK (version_slot IN ('a','b','c')),
    status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','blocked','done','cancelled')),
    created_by   TEXT NOT NULL REFERENCES participants(id),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    result       TEXT,
    last_seen_at INTEGER
  );
  CREATE INDEX delegations_status ON delegations(status, created_at);
  CREATE TABLE claims (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    delegation_id TEXT NOT NULL REFERENCES delegations(id),
    kind          TEXT NOT NULL CHECK (kind IN ('path','resource')),
    repo          TEXT NOT NULL,
    scope         TEXT NOT NULL,
    origin        TEXT NOT NULL CHECK (origin IN ('initial','added')),
    claimed_at    INTEGER NOT NULL,
    released_at   INTEGER
  );
  CREATE INDEX claims_active ON claims(repo, kind) WHERE released_at IS NULL;
  CREATE INDEX claims_delegation ON claims(delegation_id);
  `,
  // 13 — 위임 대장 대기(2026-10-16 마스터 #345 · 선점 시각화): 겹치면 거절만 하던 대장에 «쌓여서 기다리는 블록»을 들인다.
  //      만들 때 queue:true 면 409 대신 위임을 queued 로 만들고 선점 줄을 전부 granted=0(대기)으로 둔다(부분 진입 없음).
  //      겹침 검사는 granted=1 인 활성 선점만 센다 — 대기 줄은 남을 막지 않는다. 진입(admit)은 마스터·만든 이가 부르고 자동 진입은 없다.
  //      옛 행은 모두 잡힌 선점이었으니 granted=1.
  `
  ALTER TABLE claims ADD COLUMN granted INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0,1));
  DROP INDEX claims_active;
  CREATE INDEX claims_active ON claims(repo, kind) WHERE released_at IS NULL AND granted = 1;
  `,
  // 14 — 요청 창구(2026-10-16 마스터 #352 · 백구↔비전): 에이전트가 허용 짝의 다른 에이전트에게 «요청»을 직접 낸다(출처 'request' · 지시 아님).
  //      messages.source_kind CHECK 를 넓힌다 — 표를 다시 만들지 않고 스키마 글만 고친다(SQLite 문서 «제약을 푸는 바뀜»의 writable_schema 절차:
  //      기존 행은 옛 집합 안이라 그대로 맞고, 디스크 형식은 안 바뀐다). 새 표 둘 — request_pairs(허용 짝 · 방향 있음 · 마스터만 CLI 로 바꾼다)는
  //      비어서 시작하고(CLI `request-pair add` 로 더한다), request_holds 는 마스터가 봐야 할 요청(받은 쪽 보류 · 연쇄 상한)을 남긴다. 기존 행은 그대로.
  (db) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string };
    if (!row.sql.includes(SOURCE_CHECK_V1)) throw new Error('migration 14: messages.source_kind CHECK 가 예상과 다르다');
    const v = db.pragma('schema_version', { simple: true }) as number;
    db.unsafeMode(true); // writable_schema 는 방어 모드에서 막힌다 — 이 판 동안만 푼다
    try {
      db.pragma('writable_schema = ON');
      db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = 'messages'").run(SOURCE_CHECK_V1, SOURCE_CHECK_V14);
      db.pragma(`schema_version = ${v + 1}`);
      db.pragma('writable_schema = OFF');
    } finally {
      db.unsafeMode(false);
    }
    db.exec(`
    CREATE TABLE request_pairs (
      from_id    TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE TABLE request_holds (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL REFERENCES threads(id),
      request_seq  INTEGER,                -- held = 요청 글 · chain_limit = 요청이 될 뻔한 글(직접 게시가 막혔으면 NULL)
      requester_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('held','chain_limit')),
      reason       TEXT NOT NULL,
      note         TEXT,
      run_id       TEXT,
      created_at   INTEGER NOT NULL,
      acked_at     INTEGER,
      acked_by     TEXT
    );
    CREATE INDEX request_holds_thread ON request_holds(thread_id, acked_at);
    `);
  },
  // 15 — 보류 알림(마스터 #352 보완 · #374): 보류(kind 'held')를 요청자에게 «한 번» 알린 실행. 요청자가 그 스레드에서 처음 불리는 실행이
  //      claim 될 때 채운다 — 채워진 행은 다시 안 싣는다. 기존 행은 그대로(null = 아직 안 알림 · 다음 실행에 한 번 실린다).
  `
  ALTER TABLE request_holds ADD COLUMN notified_run_id TEXT;
  CREATE INDEX request_holds_notify ON request_holds(thread_id, requester_id) WHERE kind = 'held' AND notified_run_id IS NULL;
  `,
  // 16 — 대면 모드(2026-10-19 마스터 #579·#581 · 설계 Design/brainStorm-대면-모드.md): 스레드의 모드(chat|face) ·
  //      face_rounds(마스터 지시 하나 = 라운드 · 상태 · 다음 차례 · 턴 · 기본/상한 · 현재 합의문 · 판) ·
  //      face_revs(판마다 글쓴이·실행·글 seq·합의문·줄 출처 JSON) · face_issues(안건 · 판들 JSON · 마스터 결정).
  //      옛 스레드는 모두 mode='chat' — 기존 행은 그대로.
  `
  ALTER TABLE threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','face'));
  CREATE TABLE face_rounds (
    id              TEXT PRIMARY KEY,
    thread_id       TEXT NOT NULL REFERENCES threads(id),
    instruction_seq INTEGER NOT NULL,
    drafter         TEXT NOT NULL,
    reviewer        TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('running','question','agreed','limit','stopped','approved','rejected')),
    next_agent      TEXT,
    turn_seq        INTEGER,
    turn            INTEGER NOT NULL DEFAULT 0,
    base_turns      INTEGER NOT NULL,
    max_turns       INTEGER NOT NULL,
    doc             TEXT,
    rev             INTEGER NOT NULL DEFAULT 0,
    stop_reason     TEXT,
    question        TEXT,
    question_by     TEXT,
    question_seq    INTEGER,
    verdict         TEXT CHECK (verdict IN ('approve','reject')),
    verdict_note    TEXT,
    verdict_by      TEXT,
    verdict_at      INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    ended_at        INTEGER
  );
  CREATE INDEX face_rounds_thread ON face_rounds(thread_id, created_at);
  CREATE TABLE face_revs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id    TEXT NOT NULL REFERENCES face_rounds(id),
    rev         INTEGER NOT NULL,
    turn        INTEGER NOT NULL,
    author_id   TEXT NOT NULL,
    run_id      TEXT,
    message_seq INTEGER,
    doc         TEXT NOT NULL,
    origins     TEXT NOT NULL,
    changed     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (round_id, rev)
  );
  CREATE TABLE face_issues (
    id          TEXT PRIMARY KEY,
    round_id    TEXT NOT NULL REFERENCES face_rounds(id),
    n           INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('contested','limit')),
    versions    TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','decided')),
    decision    TEXT,
    decided_by  TEXT,
    decided_at  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX face_issues_round ON face_issues(round_id, n);
  `,
  // 17 — 하위 스레드 합치기(2026-10-21 마스터 #706): 하위 스레드의 글을 상위 대화에 묶음 한 글로 옮긴다.
  //      묶음 글(message_seq)은 상위 대화의 보통 글(출처 quote · 받는 이 없음)이고, 무엇을 옮겼는지는 여기에 — 하위 스레드의 제 글 중 (from_seq..to_seq).
  //      같은 하위 스레드를 다시 합치면 지난 to_seq 뒤의 글만. 에이전트 claim 맥락에서 이 글은 옮긴 글 전문으로 펼쳐진다
  `
  CREATE TABLE thread_merges (
    message_seq      INTEGER PRIMARY KEY REFERENCES messages(seq),
    child_thread_id  TEXT NOT NULL REFERENCES threads(id),
    parent_thread_id TEXT NOT NULL REFERENCES threads(id),
    from_seq         INTEGER NOT NULL,
    to_seq           INTEGER NOT NULL,
    count            INTEGER NOT NULL,
    created_by       TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX thread_merges_child ON thread_merges(child_thread_id, to_seq);
  `,
  // 18 — 전달 메모(2026-10-21 마스터 #740): 마스터가 «전달»을 누를 때 함께 넘기는 말(선택). 비면 NULL — 옛 전달과 같다.
  //     받는 에이전트에겐 전달된 글 끝에 «마스터 전달 메모 · 지시» 블록으로 실린다(claim 에서 · 어댑터 그대로).
  `
  ALTER TABLE deliveries ADD COLUMN forward_note TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/** target 을 주면 그 판까지만 올린다(마이그레이션 시험이 옛 스키마 DB 를 만들 때) */
export function migrate(db: DB, target = MIGRATIONS.length): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < Math.min(target, MIGRATIONS.length); v++) {
    db.transaction(() => {
      const m = MIGRATIONS[v];
      if (typeof m === 'string') db.exec(m);
      else m(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}
