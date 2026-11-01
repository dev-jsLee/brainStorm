// 위임 대장 모듈 — 경로·붙이기. 일은 ./store.ts(DelegationStore), 화면은 public/claims.js(선점 탭)
import type { BrainstormModule } from '../../modules.js';
import { DelegationStore } from './store.js';

type D = { Params: { id: string } };

export const delegationsModule: BrainstormModule = {
  id: 'delegations',
  attach(store) {
    store.delegations = new DelegationStore(store);
  },
  routes(fastify, { store, auth }) {
    const dlg = store.delegations!;
    // 에이전트 → 작업 세션 일감과 만질 범위 선점. 권한은 delegationGate 한곳 · 겹침은 409 claim_conflict
    fastify.get<{ Querystring: { active?: string; recent?: string } }>('/api/delegations', { preHandler: auth }, async (req) => dlg.listDelegations(req.principal!, req.query));
    fastify.post('/api/delegations', { preHandler: auth }, async (req, reply) =>
      reply.code(201).send(dlg.createDelegation(req.principal!, (req.body ?? {}) as any)),
    );
    fastify.get<D>('/api/delegations/:id', { preHandler: auth }, async (req) => dlg.getDelegation(req.principal!, req.params.id));
    fastify.post<D & { Body: { claims?: unknown } }>('/api/delegations/:id/claims', { preHandler: auth }, async (req) =>
      dlg.addClaims(req.principal!, req.params.id, (req.body ?? {}).claims),
    );
    fastify.post<D & { Body: { status?: unknown; result?: unknown } }>('/api/delegations/:id/status', { preHandler: auth }, async (req) =>
      dlg.setDelegationStatus(req.principal!, req.params.id, (req.body ?? {}).status, (req.body ?? {}).result),
    );
    fastify.post<D>('/api/delegations/:id/heartbeat', { preHandler: auth }, async (req) => dlg.delegationHeartbeat(req.principal!, req.params.id));
    fastify.post<D>('/api/delegations/:id/release', { preHandler: auth }, async (req) => dlg.releaseStale(req.principal!, req.params.id));
    // 대기 위임 진입(마이그레이션 13) — 마스터·만든 이가 «먼저 해도 된다»고 판정할 때만. 아직 겹치면 409 claim_conflict
    fastify.post<D>('/api/delegations/:id/admit', { preHandler: auth }, async (req) => dlg.admitDelegation(req.principal!, req.params.id));
  },
  ui: { scripts: ['claims.js'] },
};
