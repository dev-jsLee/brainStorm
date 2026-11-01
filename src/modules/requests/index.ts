// 요청 모듈 — 경로·붙이기. 일은 ./store.ts(RequestStore). 화면의 보류 줄은 public/app.js 가 request_holds 가 있을 때만 그린다
import type { BrainstormModule } from '../../modules.js';
import { RequestStore } from './store.js';

export const requestsModule: BrainstormModule = {
  id: 'requests',
  attach(store) {
    store.requests = new RequestStore(store);
  },
  routes(fastify, { store, cfg, auth }) {
    const rq = store.requests!;
    fastify.get<{ Params: { id: string } }>('/api/threads/:id/request-holds', { preHandler: auth }, async (req) => ({ holds: rq.listRequestHolds(req.principal!, req.params.id) }));
    fastify.post<{ Params: { id: string } }>('/api/request-holds/:id/ack', { preHandler: auth }, async (req) => rq.ackRequestHold(req.principal!, req.params.id));
    fastify.get('/api/request-pairs', { preHandler: auth }, async () => ({ pairs: rq.listRequestPairs(), chain_max: cfg.requestChainMax }));
  },
};
