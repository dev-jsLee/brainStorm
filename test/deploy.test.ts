// 설치 파일 — node 자리를 박지 않는다 · install.sh 가 멈출 때 까닭을 보인다 · README 어댑터 절은 적힌 순서대로 된다.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const deploy = path.join(repoRoot, 'deploy');
const read = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf8');
const files = (fs.readdirSync(deploy, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(deploy, f)).isFile());
const units = files.filter((f) => f.endsWith('.service'));

describe('설치 — node 자리', () => {
  test('deploy/ 어디에도 /usr/bin/node 가 없다', () => {
    assert.ok(units.length >= 5);
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(deploy, f), 'utf8'), /\/usr\/bin\/node/, f);
  });

  test('유닛의 node 는 /usr/bin/env node 로 시작하고 install.sh 치환으로 실제 경로가 된다', () => {
    let seen = 0;
    for (const f of units) {
      const s = fs.readFileSync(path.join(deploy, f), 'utf8');
      const line = s.split('\n').find((l) => l.startsWith('ExecStart='))!;
      if (!/\.js\b/.test(line)) continue;
      seen++;
      assert.match(line, /^ExecStart=\/usr\/bin\/env node /, f);
      const out = s.replaceAll('/usr/bin/env node', '/opt/n/bin/node');
      assert.match(out, /^ExecStart=\/opt\/n\/bin\/node /m, f);
    }
    assert.ok(seen >= 5);
    assert.match(read('deploy/install.sh'), /sed "s#\/usr\/bin\/env node#\$NODE#"/);
  });

  test('brainstorm-admin 도 env node 를 쓴다(root·일반 두 길)', () => {
    assert.equal(read('deploy/bin/brainstorm-admin').match(/\/usr\/bin\/env node /g)?.length, 2);
  });
});

describe('install.sh — 시스템을 건드리기 전에 멈춘다', () => {
  const tmp: string[] = [];
  after(() => {
    for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  });
  /** dist/ 만 있는 가짜 소스. PATH 를 좁혀 돌린다 */
  function run(pathVar: string) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-install-'));
    tmp.push(src);
    fs.mkdirSync(path.join(src, 'dist/src'), { recursive: true });
    fs.writeFileSync(path.join(src, 'dist/src/server.js'), '');
    return spawnSync('/bin/bash', [path.join(deploy, 'install.sh'), src], { encoding: 'utf8', env: { PATH: pathVar } });
  }
  test('node 가 PATH 에 없으면 까닭을 말하고 멈춘다', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-empty-'));
    tmp.push(empty);
    const r = run(empty);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /node 가 PATH 에 없다/);
  });

  const home = os.homedir();
  test('홈 아래 node 는 거절한다(서비스가 ProtectHome)', { skip: /^\/(home|root)\//.test(home + '/') ? false : '홈이 /home·/root 밖' }, () => {
    const bin = fs.mkdtempSync(path.join(home, '.bs-test-'));
    tmp.push(bin);
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    const r = run(`${bin}:/usr/bin:/bin`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /홈 아래/);
  });

  test('init 오류를 버리지 않는다', () => {
    const s = read('deploy/install.sh');
    assert.doesNotMatch(s, /brainstorm-admin init[^\n]*2>\/dev\/null/);
    assert.match(s, /cat "\$ERR" >&2/);
  });
});

describe('README 어댑터 절', () => {
  for (const f of ['README.md', 'README.en.md']) {
    for (const [name, sec] of [['claude', '### Claude Code'], ['codex', '### Codex']] as const) {
      test(`${f} ${name}: 폴더 → 토큰 → env → 유닛 → env 읽기 → check → 켜기 순서`, () => {
        const s = read(f);
        const start = s.indexOf(sec);
        const body = s.slice(start, s.indexOf('\n### ', start + 5));
        const steps = ['token create', 'mkdir -p ~/.config/brainstorm ~/.config/systemd/user', `install -m 600 ~/${name}.token`, `> ~/.config/brainstorm/${name}.env`, `> ~/.config/systemd/user/brainstorm-agent-${name}.service`, `. ~/.config/brainstorm/${name}.env`, `${name}-cli-adapter.js check`, `enable --now brainstorm-agent-${name}`];
        let at = -1;
        for (const step of steps) {
          const i = body.indexOf(step, at + 1);
          assert.ok(i > at, step);
          at = i;
        }
      });
    }
    test(`${f} herdr: 폴더 → 토큰 → env → 유닛 템플릿 → env 읽기 → check → 인스턴스 켜기 순서 · 서버 외부 공개 세 값`, () => {
      const s = read(f);
      const start = s.indexOf('### herdr');
      assert.ok(start > 0);
      const body = s.slice(start, s.indexOf('\n### ', start + 5));
      for (const k of ['BRAINSTORM_ALLOW_EXTERNAL=1', 'BRAINSTORM_LISTEN=127.0.0.1:8080,', 'BRAINSTORM_ORIGINS=https://']) assert.ok(body.includes(k), k);
      const steps = ['token create', 'mkdir -p ~/.config/brainstorm ~/.config/systemd/user', 'install -m 600 ~/herdr-track-a.token', 'deploy/herdr/herdr.env.example > ~/.config/brainstorm/herdr-track-a.env', '> ~/.config/systemd/user/brainstorm-agent-herdr@.service', '. ~/.config/brainstorm/herdr-track-a.env', 'herdr-adapter.js check', 'enable --now brainstorm-agent-herdr@track-a'];
      let at = -1;
      for (const step of steps) {
        const i = body.indexOf(step, at + 1);
        assert.ok(i > at, step);
        at = i;
      }
    });
  }
});

describe('herdr 유닛 템플릿', () => {
  test('인스턴스 이름으로 env 를 고르고 · env 본보기의 이름 자리가 sed 로 바뀐다', () => {
    const u = read('deploy/herdr/brainstorm-agent-herdr@.service');
    assert.match(u, /^EnvironmentFile=%h\/\.config\/brainstorm\/herdr-%i\.env$/m);
    assert.match(u, /herdr-adapter\.js run$/m);
    const e = read('deploy/herdr/herdr.env.example');
    assert.match(e.replaceAll('NAME', 'track-a'), /^BRAINSTORM_TOKEN_FILE=\/home\/you\/\.config\/brainstorm\/herdr-track-a\.token$/m);
    for (const k of ['HERDR_SESSION=', 'HERDR_PANE=']) assert.match(e, new RegExp(`^${k}`, 'm'));
  });
});
