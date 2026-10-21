// 백업·복원. DB는 SQLite 온라인 백업 API(.backup 과 같은 것)로 일관된 스냅숏을 뜨고,
// 첨부는 그 뒤에 복사한다. 첨부 파일은 «파일 먼저, 행 나중»으로 쓰이므로
// 스냅숏 속 행이 가리키는 파일은 반드시 이미 있다(남는 파일은 해가 없다).
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { migrate } from './db.js';

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function backup(cfg: Config, outDir = cfg.backupsDir): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o750 });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-backup-'));
  try {
    const src = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
    try {
      await src.backup(path.join(work, 'brainstorm.db'));
    } finally {
      src.close();
    }
    const snap = new Database(path.join(work, 'brainstorm.db'));
    const check = snap.pragma('integrity_check', { simple: true });
    const count = (snap.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const ver = snap.pragma('user_version', { simple: true });
    snap.close();
    if (check !== 'ok') throw new Error(`integrity_check failed: ${check}`);

    fs.mkdirSync(path.join(work, 'attachments'));
    if (fs.existsSync(cfg.attachmentsDir))
      for (const f of fs.readdirSync(cfg.attachmentsDir)) fs.copyFileSync(path.join(cfg.attachmentsDir, f), path.join(work, 'attachments', f));

    fs.writeFileSync(
      path.join(work, 'MANIFEST.json'),
      JSON.stringify({ created_at: new Date().toISOString(), schema: ver, messages: count, host: os.hostname() }, null, 2),
    );
    let name = `brainstorm-${stamp()}.tar.gz`;
    for (let i = 1; fs.existsSync(path.join(outDir, name)); i++) name = `brainstorm-${stamp()}-${i}.tar.gz`;
    const out = path.join(outDir, name);
    execFileSync('tar', ['-czf', out, '-C', work, 'brainstorm.db', 'attachments', 'MANIFEST.json']);
    fs.chmodSync(out, 0o640);
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 복원. 서비스를 멈춘 상태에서 돌린다.
 * 지금 DB는 지우지 않고 옆으로 치운다(pre-restore-<시각>).
 * 복원 직후 옛 대기 작업을 다시 돌리지 않는다:
 *  - 아직 안 나간/빌려 간 전달 → cancelled (last_error=restored)
 *  - queued/running 실행 → unknown (error=restored_from_backup)
 */
export function restore(cfg: Config, tarball: string): { messages: number; movedAside: string | null; held: { deliveries: number; runs: number } } {
  if (!fs.existsSync(tarball)) throw new Error(`no such file: ${tarball}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-restore-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', work, '--no-same-owner']);
    const dbFile = path.join(work, 'brainstorm.db');
    if (!fs.existsSync(dbFile)) throw new Error('tarball has no brainstorm.db');
    const db = new Database(dbFile);
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity_check failed: ${check}`);
    migrate(db);
    const t = Date.now();
    const held = db.transaction(() => {
      const d = db
        .prepare(
          "UPDATE deliveries SET status = 'cancelled', last_error = 'restored', lease_token_hash = NULL, updated_at = ? WHERE status IN ('pending','leased')",
        )
        .run(t).changes;
      const r = db
        .prepare(
          "UPDATE runs SET state = 'unknown', error = 'restored_from_backup', ended_at = ?, run_token_hash = NULL WHERE state IN ('queued','running')",
        )
        .run(t).changes;
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_restore', ?)").run(
        JSON.stringify({ at: new Date(t).toISOString(), from: path.basename(tarball), held_deliveries: d, held_runs: r }),
      );
      // 복원 전 웹 세션은 무효로 — 다시 로그인한다
      db.prepare('DELETE FROM web_sessions').run();
      return { deliveries: d, runs: r };
    })();
    const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    db.pragma('journal_mode = DELETE');
    db.close();

    fs.mkdirSync(cfg.dataDir, { recursive: true });
    let movedAside: string | null = null;
    if (fs.existsSync(cfg.dbPath) || fs.existsSync(cfg.attachmentsDir)) {
      movedAside = path.join(cfg.dataDir, `pre-restore-${stamp()}`);
      fs.mkdirSync(movedAside, { mode: 0o750 });
      for (const f of ['brainstorm.db', 'brainstorm.db-wal', 'brainstorm.db-shm']) {
        const p = path.join(cfg.dataDir, f);
        if (fs.existsSync(p)) fs.renameSync(p, path.join(movedAside, f));
      }
      if (fs.existsSync(cfg.attachmentsDir)) fs.renameSync(cfg.attachmentsDir, path.join(movedAside, 'attachments'));
    }
    fs.copyFileSync(dbFile, cfg.dbPath);
    fs.mkdirSync(cfg.attachmentsDir, { recursive: true, mode: 0o750 });
    const attSrc = path.join(work, 'attachments');
    if (fs.existsSync(attSrc)) for (const f of fs.readdirSync(attSrc)) fs.copyFileSync(path.join(attSrc, f), path.join(cfg.attachmentsDir, f));
    return { messages, movedAside, held };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
