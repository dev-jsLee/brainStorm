// 선택 모듈의 틀(마스터 #1193 · docs/MODULES.md). core 는 이 꼴만 알고, 모듈은 src/modules/<id>/ 에서 자기 일을 한다.
// 옮긴 모듈은 REGISTRY 에 있다. 전달(forward)은 «→ 이름» 버튼의 서버 쪽이라 core 에 남겼다(docs/MODULES.md).
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Store } from './store.js';
import { faceModule } from './modules/face/index.js';
import { delegationsModule } from './modules/delegations/index.js';
import { requestsModule } from './modules/requests/index.js';
import { mergeModule } from './modules/merge/index.js';
import { questionsModule } from './modules/questions/index.js';

/** 선택 모듈 이름. docs/MODULES.md */
export const KNOWN_MODULES = ['face', 'delegations', 'requests', 'merge', 'questions'] as const;
export type ModuleId = (typeof KNOWN_MODULES)[number];

/** 모듈이 받는 손잡이. Store 안쪽 중 모듈이 부르는 것은 @internal 로 표시돼 있다 */
export interface ModuleCtx {
  db: DB;
  cfg: Config;
  store: Store;
  /** 로그인 확인 preHandler — 모듈 경로도 core 와 같은 문을 지난다 */
  auth: preHandlerHookHandler;
}

export interface ModuleMigration {
  /** 모듈 안의 번호(1부터) — module_migrations(module, n) 에 적는다. core 의 user_version 과 따로 센다 */
  n: number;
  sql: string;
}

export interface BrainstormModule {
  id: ModuleId;
  migrations?: ModuleMigration[];
  /** Store 에 자기 일을 붙인다(경로보다 먼저) */
  attach?(store: Store): void;
  /** 켜졌을 때만 붙는다 */
  routes?(f: FastifyInstance, ctx: ModuleCtx): void;
  /** 이 모듈의 화면 조각(참고용 — 화면은 /api/me.modules 를 보고 그린다) */
  ui?: { scripts: string[] };
}

/** 옮긴 모듈 — 순서대로 붙는다 */
export const REGISTRY: BrainstormModule[] = [faceModule, delegationsModule, requestsModule, mergeModule, questionsModule];

/** BRAINSTORM_MODULES — 쉼표 목록 · 'all' 은 전부 · 비면 core 만. 모르는 이름은 오타로 보고 시작을 멈춘다 */
export function parseModules(s: string | undefined): ModuleId[] {
  const raw = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (raw.length === 1 && raw[0] === 'all') return [...KNOWN_MODULES];
  const bad = raw.filter((x) => !(KNOWN_MODULES as readonly string[]).includes(x));
  if (bad.length) throw new Error(`BRAINSTORM_MODULES: 모르는 모듈 ${bad.join(', ')} — 아는 것: ${KNOWN_MODULES.join(', ')} · all`);
  return [...new Set(raw)] as ModuleId[];
}

/** 모듈 마이그레이션 — 표 module_migrations 는 마이그레이션을 가진 모듈이 처음 켜질 때 생긴다 */
export function migrateModule(db: DB, m: BrainstormModule): number {
  if (!m.migrations?.length) return 0;
  db.exec('CREATE TABLE IF NOT EXISTS module_migrations (module TEXT NOT NULL, n INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (module, n))');
  const done = new Set((db.prepare('SELECT n FROM module_migrations WHERE module = ?').all(m.id) as { n: number }[]).map((r) => r.n));
  let applied = 0;
  for (const mg of [...m.migrations].sort((a, b) => a.n - b.n)) {
    if (done.has(mg.n)) continue;
    db.transaction(() => {
      db.exec(mg.sql);
      db.prepare('INSERT INTO module_migrations (module, n, applied_at) VALUES (?, ?, ?)').run(m.id, mg.n, Date.now());
    })();
    applied++;
  }
  return applied;
}

/** 켜진 모듈을 붙인다 — 마이그레이션 → 경로. 붙인 모듈 id 를 돌려준다 */
export function mountModules(f: FastifyInstance, ctx: ModuleCtx, enabled: readonly string[], registry: readonly BrainstormModule[] = REGISTRY): ModuleId[] {
  const on = registry.filter((m) => enabled.includes(m.id));
  for (const m of on) {
    migrateModule(ctx.db, m);
    m.attach?.(ctx.store);
    m.routes?.(f, ctx);
  }
  return on.map((m) => m.id);
}
