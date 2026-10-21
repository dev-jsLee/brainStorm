#!/bin/bash
# 서버(Debian/Ubuntu · systemd · Node 22)에서 root 로 실행. 인자: 빌드된 저장소를 풀어 둔 디렉터리(dist/ 포함).
# 여러 번 돌려도 된다(업데이트). 데이터·설정·패스프레이즈는 건드리지 않는다.
set -euo pipefail
SRC=${1:?usage: install.sh <src-dir>}
cd "$SRC"
[ -f dist/src/server.js ] || { echo "dist/ 가 없다 — 먼저 npm run build" >&2; exit 1; }

id brainstorm >/dev/null 2>&1 || useradd --system --home-dir /var/lib/brainstorm --no-create-home --shell /usr/sbin/nologin brainstorm

install -d -o root -g root -m 755 /opt/brainstorm
rm -rf /opt/brainstorm/dist /opt/brainstorm/public /opt/brainstorm/deploy
cp -a dist public deploy package.json package-lock.json README.md /opt/brainstorm/
chown -R root:root /opt/brainstorm
(cd /opt/brainstorm && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

install -d -o brainstorm -g brainstorm -m 750 /var/lib/brainstorm /var/lib/brainstorm/attachments /var/lib/brainstorm/backups
install -d -o root -g root -m 755 /etc/brainstorm
[ -f /etc/brainstorm/brainstorm.env ] || install -o root -g brainstorm -m 640 deploy/brainstorm.env /etc/brainstorm/brainstorm.env

install -m 755 deploy/bin/brainstorm-admin deploy/bin/brainstorm-backup deploy/bin/brainstorm-restore /usr/local/bin/
install -m 644 deploy/systemd/brainstorm.service deploy/systemd/brainstorm-backup.service deploy/systemd/brainstorm-backup.timer /etc/systemd/system/
# 에이전트 어댑터 템플릿 — 유닛만 깐다. 인스턴스는 켜지 않는다(README «에이전트 붙이기»)
install -m 644 deploy/systemd/brainstorm-agent@.service /etc/systemd/system/
install -d -o root -g root -m 700 /etc/brainstorm/agents
systemctl daemon-reload

# 첫 설치: 마스터 등록 + 초기 패스프레이즈를 root 전용 파일로 (화면에 안 찍는다)
PASS=/root/brainstorm-initial-passphrase.txt
TMP=$(mktemp /root/.bs-pass.XXXXXX)
chmod 600 "$TMP"
set +e
/usr/local/bin/brainstorm-admin init >"$TMP" 2>/dev/null
rc=$?
set -e
if [ $rc -eq 0 ]; then
  mv "$TMP" "$PASS"; chmod 600 "$PASS"; chown root:root "$PASS"
  echo "마스터 등록됨. 초기 패스프레이즈: $PASS (root 전용, 600)"
elif [ $rc -eq 3 ]; then
  rm -f "$TMP"; echo "이미 초기화됨 — 패스프레이즈 그대로"
else
  rm -f "$TMP"; echo "init 실패 rc=$rc" >&2; exit 1
fi

chmod 640 /var/lib/brainstorm/brainstorm.db* 2>/dev/null || true

systemctl enable brainstorm.service brainstorm-backup.timer
systemctl restart brainstorm.service
# 켜져 있는 에이전트 어댑터는 새 코드로 다시 띄운다(없으면 아무것도 안 한다)
for u in $(systemctl list-units --plain --no-legend --state=active 'brainstorm-agent@*.service' | awk '{print $1}'); do
  systemctl restart "$u"
done
systemctl start brainstorm-backup.timer
sleep 2
systemctl --no-pager --lines=0 status brainstorm.service | head -5
