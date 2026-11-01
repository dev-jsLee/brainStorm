// 대면 모듈 — 경로·붙이기. 일은 ./store.ts(FaceStore), 화면은 public/face.js, 규칙 조각은 src/face.ts
import type { BrainstormModule } from '../../modules.js';
import { FaceStore } from './store.js';

type P = { Params: { id: string } };

export const faceModule: BrainstormModule = {
  id: 'face',
  attach(store) {
    store.face = new FaceStore(store);
  },
  routes(fastify, { store, auth }) {
    const face = store.face!;
    // 대면 모드(마스터 #581): 켜고 끄기·결정·판정·멈추기·다시 돌리기는 마스터만 · 보기는 멤버
    fastify.post<P & { Body: { mode?: unknown } }>('/api/threads/:id/mode', { preHandler: auth }, async (req) =>
      face.setThreadMode(req.principal!, req.params.id, (req.body ?? {}).mode),
    );
    fastify.get<P & { Querystring: { round?: string } }>('/api/threads/:id/face', { preHandler: auth }, async (req) =>
      face.getFace(req.principal!, req.params.id, req.query.round || undefined),
    );
    fastify.post<{ Params: { id: string; iid: string } }>('/api/face/:id/issues/:iid/decide', { preHandler: auth }, async (req) =>
      face.decideIssue(req.principal!, req.params.id, req.params.iid, (req.body ?? {}) as any),
    );
    fastify.post<P>('/api/face/:id/verdict', { preHandler: auth }, async (req) => face.faceVerdict(req.principal!, req.params.id, (req.body ?? {}) as any));
    fastify.post<P>('/api/face/:id/stop', { preHandler: auth }, async (req) => face.faceStop(req.principal!, req.params.id));
    fastify.post<P>('/api/face/:id/retry', { preHandler: auth }, async (req) => face.faceRetry(req.principal!, req.params.id));
  },
  ui: { scripts: ['face.js'] },
};
