// 언어(마스터 #821·#823) — 사전 검사 · 서버 언어 설정(마스터만 · 감사) · claim 의 lang · 오류 안내의 요청 언어 ·
//   규약 낱말은 모든 언어의 것을 함께 받는다(요청→ · 보류: · 질문: · ```합의문) · 프롬프트 틀이 그 언어로
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { buildPrompt } from '../adapter/openclaw-channel/src/mapping.js';
import { parseFaceAnswer } from '../src/face.js';
import { languages, t } from '../src/i18n.js';
import type { Message } from '../src/protocol.js';
import { renderFace, requestRule } from '../src/protocol.js';
import { parseHold, parseRequest } from '../src/modules/requests/store.js';
import { newThread, post, setup, waitFor, type Ctx } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANGUL = /[가-힣]/;

describe('사전', () => {
  test('i18n-check 통과 — 키·자리표시·단어집·규약 낱말·코드가 부르는 키', () => {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'i18n-check.mjs')], { encoding: 'utf8' });
    assert.match(out, /✓/);
  });
  test('언어 목록에 ko·en · 빠진 키는 ko 로 · ko 에도 없으면 키 그대로', () => {
    const codes = languages().map((l) => l.code);
    assert.ok(codes.includes('ko') && codes.includes('en'));
    assert.equal(t('en', 'proto.hold'), 'hold');
    assert.equal(t('xx', 'proto.hold'), '보류');
    assert.equal(t('en', 'no.such.key'), 'no.such.key');
    assert.equal(t('en', 'prompt.hold_notice', { seq: ' #3' }), '[Notice] Your request #3 was put on hold (the master sees the reason).');
  });
});

describe('규약 낱말 — 모든 언어를 함께 받는다', () => {
  const C = [{ id: 'beta', name: 'BETA' }];
  test('요청→ / request→ · 보류: / hold:', () => {
    assert.equal(parseRequest('done\nrequest→ BETA', C).to, 'beta');
    assert.equal(parseRequest('done\n**Request -> beta**', C).to, 'beta');
    assert.equal(parseRequest('답\n요청→ BETA', C).to, 'beta');
    assert.deepEqual(parseHold('why\nhold: out of scope'), { reason: 'out of scope', note: 'why' });
    assert.equal(parseHold('보류: 범위 밖')?.reason, '범위 밖');
    assert.equal(parseHold('holding the line\nnothing'), null);
  });
  test('대면: question: · ```agreement 블록도 읽는다', () => {
    assert.deepEqual(parseFaceAnswer('need input\nquestion: which DB?'), { kind: 'question', question: 'which DB?' });
    const a = parseFaceAnswer('changed line 2\n```agreement\nA\nB\n```');
    assert.equal(a.kind, 'doc');
    assert.equal(a.kind === 'doc' && a.doc, 'A\nB');
    assert.equal(parseFaceAnswer('고침\n```합의문\nA\n```').kind, 'doc');
  });
});

describe('프롬프트 틀이 그 언어로', () => {
  const msg = (seq: number, author: string, body: string, source_kind = 'instruction'): Message =>
    ({ seq, thread_id: 'th', author_id: author, body, source_kind, attachments: [] }) as unknown as Message;
  const participants = new Map([
    ['master', { id: 'master', name: 'Miracle', kind: 'human' as const, is_master: true }],
    ['alpha', { id: 'alpha', name: 'ALPHA', kind: 'agent' as const }],
  ]);
  test('en: 틀에 한글이 없고 규약 낱말이 영어 · ko 는 예전 그대로', () => {
    const p = { threadTitle: 'T', generation: 1, newMessages: [msg(1, 'master', 'hi')], triggerSeq: 1, participants, selfId: 'alpha' };
    const en = buildPrompt({ ...p, lang: 'en' });
    assert.ok(!HANGUL.test(en), en);
    assert.match(en, /`hold: reason`/);
    assert.match(en, /`request→ name`/);
    assert.match(en, /Miracle \(master\) · instruction/);
    const ko = buildPrompt(p);
    assert.match(ko, /`보류: 사유`/);
    assert.ok(ko.includes(requestRule('ko')));
  });
  test('대면 틀: en 은 ```agreement 블록', () => {
    const f = renderFace(
      { round_id: 'r', turn: 2, role: 'reviewer', other: { id: 'a', name: 'A' }, base_turns: 4, max_turns: 6, doc: 'X', rev: 1, changed_by_other: [], open_issues: [], resumed_question: null },
      'en',
    );
    assert.ok(!HANGUL.test(f), f);
    assert.match(f, /```agreement\nX\n```/);
  });
});

describe('서버 언어 설정', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup({ modules: ['requests'] });
  });
  after(async () => {
    await ctx.close();
  });

  test('기본 ko · /api/me 에 lang·langs', async () => {
    const r = await ctx.master('GET', '/api/me');
    assert.equal(r.json.lang, 'ko');
    assert.ok(r.json.langs.some((l: { code: string; name: string }) => l.code === 'en' && l.name === 'English'));
  });

  test('마스터만 바꾼다 · 모르는 언어 400 · 감사 settings.lang', async () => {
    assert.equal((await ctx.agent('alpha', 'PUT', '/api/settings/lang', { lang: 'en' })).status, 403);
    const bad = await ctx.master('PUT', '/api/settings/lang', { lang: 'xx' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'bad_lang');
    const ok = await ctx.master('PUT', '/api/settings/lang', { lang: 'en-US' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.lang, 'en');
    assert.equal((await ctx.master('GET', '/api/me')).json.lang, 'en');
    const audit = ctx.app.db.prepare("SELECT result FROM audit_log WHERE action = 'settings.lang'").all() as { result: string }[];
    assert.ok(audit.some((a) => a.result === 'ok'));
  });

  test('claim 에 lang — 어댑터가 그 언어로 프롬프트를 싣는다', async () => {
    const th = await newThread(ctx, 'lang', 'alpha', ['alpha']);
    await post(ctx, th, 'hello');
    const c = await waitFor(async () => {
      const r = await ctx.agent('alpha', 'POST', '/api/adapter/claim', { worker: 't' });
      return r.status === 200 && r.json?.claim ? r.json.claim : null;
    });
    assert.equal(c.lang, 'en');
  });

  test('오류 안내는 요청 언어(X-BS-Lang) · 없으면 서버 언어', async () => {
    const room = (ctx.app.db.prepare("SELECT id FROM threads WHERE kind = 'room'").get() as { id: string }).id;
    const call = (lang?: string) =>
      fetch(`${ctx.base}/api/threads/${room}/rename`, {
        method: 'POST',
        headers: { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/json', ...(lang ? { 'X-BS-Lang': lang } : {}) },
        body: JSON.stringify({ title: 'x' }),
      }).then((r) => r.json() as Promise<{ error: string; message: string }>);
    assert.equal((await call('ko')).message, '메인 채팅방은 이름을 바꿀 수 없다');
    assert.equal((await call('en')).message, 'The main room cannot be renamed');
    assert.equal((await call()).message, 'The main room cannot be renamed'); // 서버 언어 en
  });

  test('/i18n-dict.js 에 모든 언어', async () => {
    const r = await fetch(`${ctx.base}/i18n-dict.js`);
    assert.equal(r.status, 200);
    const s = await r.text();
    assert.match(s, /^window\.BS_I18N=/);
    assert.ok(s.includes('"English"') && s.includes('"한국어"'));
  });
});
