import crypto from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function randomToken(prefix = 'bst'): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

/** 토큰은 무작위 32바이트라 느린 해시가 필요 없다 — sha256 으로 조회한다. */
export function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export function hashPassphrase(pass: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pass, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassphrase(pass: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(pass, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** 사람이 옮겨 적기 쉬운 패스프레이즈: 헷갈리는 글자를 뺀 20자, 4자씩 끊음 */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) {
    s += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 19) s += '-';
  }
  return s;
}
