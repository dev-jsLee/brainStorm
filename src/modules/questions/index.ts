// 질문함 모듈 — 경로·붙이기. 일은 ./store.ts(QuestionStore), 화면은 public/questions.js(질문함 화면 · 글 안 축소 카드)
import type { BrainstormModule } from '../../modules.js';
import { QUESTIONS_SQL, QuestionStore } from './store.js';

type Q = { Params: { id: string } };
type B = Record<string, unknown>;

export const questionsModule: BrainstormModule = {
  id: 'questions',
  migrations: [{ n: 1, sql: QUESTIONS_SQL }],
  attach(store) {
    store.questions = new QuestionStore(store);
  },
  routes(fastify, { store, auth }) {
    const qs = store.questions!;
    // 에이전트가 올림(bs-ask post) · 마스터는 질문함에서 답·추천대로·나중에·필요 없음·다시 열기 · 에이전트는 자기 것만 내림(close)
    fastify.get<{ Querystring: { status?: string; thread_id?: string; limit?: string } }>('/api/questions', { preHandler: auth }, async (req) => qs.listQuestions(req.principal!, req.query));
    fastify.post('/api/questions', { preHandler: auth }, async (req, reply) => {
      const r = qs.createQuestion(req.principal!, (req.body ?? {}) as B);
      return reply.code(r.duplicate ? 200 : 201).send(r);
    });
    fastify.get<Q>('/api/questions/:id', { preHandler: auth }, async (req) => qs.getQuestion(req.principal!, req.params.id));
    fastify.post<Q>('/api/questions/:id/answer', { preHandler: auth }, async (req) => qs.answerQuestion(req.principal!, req.params.id, (req.body ?? {}) as B));
    fastify.post<Q>('/api/questions/:id/recommend', { preHandler: auth }, async (req) => qs.answerQuestion(req.principal!, req.params.id, (req.body ?? {}) as B, true));
    fastify.post<Q>('/api/questions/:id/snooze', { preHandler: auth }, async (req) => qs.snoozeQuestion(req.principal!, req.params.id, ((req.body ?? {}) as B).on !== false));
    fastify.post<Q>('/api/questions/:id/dismiss', { preHandler: auth }, async (req) => qs.dismissQuestion(req.principal!, req.params.id, (req.body ?? {}) as B));
    fastify.post<Q>('/api/questions/:id/close', { preHandler: auth }, async (req) => qs.closeQuestion(req.principal!, req.params.id, (req.body ?? {}) as B));
    fastify.post<Q>('/api/questions/:id/reopen', { preHandler: auth }, async (req) => qs.reopenQuestion(req.principal!, req.params.id));
  },
  ui: { scripts: ['questions.js'] },
};
