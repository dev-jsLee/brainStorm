// 합치기 모듈 — 경로·붙이기. 일은 ./store.ts(MergeStore). 화면은 public/app.js(머리 «상위로 합치기»)
import type { BrainstormModule } from '../../modules.js';
import { MergeStore } from './store.js';

export const mergeModule: BrainstormModule = {
  id: 'merge',
  attach(store) {
    store.merge = new MergeStore(store);
  },
  routes(fastify, { store, auth }) {
    const mg = store.merge!;
    fastify.post<{ Params: { id: string } }>('/api/threads/:id/merge', { preHandler: auth }, async (req, reply) => reply.code(201).send(mg.mergeThread(req.principal!, req.params.id)));
  },
};
