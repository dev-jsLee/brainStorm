// 백업 → 복원 왕복
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { backup, restore } from '../src/backup.js';
import { newThread, post, setup } from './helpers.js';

describe('백업·복원', () => {
  test('왕복: 메시지·첨부가 보존되고, 대기 작업은 자동으로 다시 돌지 않는다', async () => {
    const ctx = await setup();
    const th = await newThread(ctx, '백업', 'alpha');
    const m1 = await post(ctx, th, '첫째', { recipients: [] });
    await post(ctx, th, '둘째 — 한글·emoji 🙂', { recipients: [] });
    const payload = Buffer.from('첨부 내용 bytes \x00\x01');
    const up = await fetch(`${ctx.base}/api/threads/${th}/messages/${m1.message.seq}/attachments?name=note.txt`, {
      method: 'POST',
      headers: { Cookie: ctx.cookie, Origin: ctx.base, 'Content-Type': 'application/octet-stream' },
      body: payload,
    });
    assert.equal(up.status, 201);
    const attId = (await up.json()).attachment.id;
    // 대기 중 전달 하나 + 실행 중 run 하나
    await post(ctx, th, '대기 중 요청');
    const c = (await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim;
    await ctx.agent('alpha', 'POST', `/api/adapter/deliveries/${c.delivery.id}/ack`, { lease_token: c.delivery.lease_token });
    await ctx.agent('alpha', 'POST', `/api/adapter/runs/${c.run.id}/start`, { run_token: c.run.run_token });
    const th2 = await newThread(ctx, '백업2', 'beta');
    await post(ctx, th2, '아직 안 가져간 요청');

    const before = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages;
    const tar = await backup(ctx.cfg);
    assert.ok(fs.existsSync(tar));

    // 백업 뒤 변경
    await post(ctx, th, '백업 뒤', { recipients: [] });
    await ctx.close();

    const r = restore(ctx.cfg, tar);
    assert.equal(r.messages, 4);
    assert.ok(r.movedAside);
    assert.equal(r.held.runs, 1);
    assert.equal(r.held.deliveries, 1);

    await ctx.restart();
    const after = (await ctx.master('GET', `/api/threads/${th}/messages`)).json.messages;
    assert.deepEqual(after, before);
    const dl = await fetch(`${ctx.base}/api/attachments/${attId}`, { headers: { Cookie: ctx.cookie } });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), payload);
    // 복원 직후 대기 작업을 다시 돌리지 않는다
    const runs = (await ctx.master('GET', `/api/threads/${th}/runs`)).json.runs;
    assert.equal(runs[0].state, 'unknown');
    assert.equal(runs[0].error, 'restored_from_backup');
    assert.equal((await ctx.agent('beta', 'POST', '/api/adapter/claim', {})).json.claim, null);
    assert.equal((await ctx.agent('alpha', 'POST', '/api/adapter/claim', {})).json.claim, null);
    await ctx.close();
  });
});
