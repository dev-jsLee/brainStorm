// 외부 공개는 기본 꺼짐(마스터 #1175): 루프백 밖 주소는 BRAINSTORM_ALLOW_EXTERNAL=1 이 있을 때만 듣는다
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertListenAllowed, isLoopback, parseListen } from '../src/config.js';

describe('외부 공개 기본 꺼짐', () => {
  test('루프백 판정', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.equal(isLoopback(h), true, h);
    for (const h of ['0.0.0.0', '203.0.113.5', '::', 'example.com']) assert.equal(isLoopback(h), false, h);
  });
  test('기본값(127.0.0.1)은 그대로 통과', () => {
    assert.doesNotThrow(() => assertListenAllowed(parseListen('127.0.0.1:8080'), {}));
  });
  test('루프백 밖 주소는 허용 없이 거절 · 허용이면 통과', () => {
    const l = parseListen('127.0.0.1:8080,0.0.0.0:8080');
    assert.throws(() => assertListenAllowed(l, {}), /BRAINSTORM_ALLOW_EXTERNAL/);
    assert.throws(() => assertListenAllowed(l, { BRAINSTORM_ALLOW_EXTERNAL: '0' }), /루프백 밖/);
    assert.doesNotThrow(() => assertListenAllowed(l, { BRAINSTORM_ALLOW_EXTERNAL: '1' }));
  });
});
