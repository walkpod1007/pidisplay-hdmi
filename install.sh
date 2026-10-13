#!/bin/bash
# Raspberry Pi OS Bookworm/Trixie, with NetworkManager, X11 kiosk on HDMI.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run: sudo bash install.sh'; exit 1; }
[[ -f /etc/rpi-issue ]] || { echo 'This installer requires Raspberry Pi OS.'; exit 1; }
[[ $(uname -m) == aarch64 ]] || { echo 'This build requires 64-bit Raspberry Pi OS. Original Zero W/WH (ARMv6) is not supported; no changes made.'; exit 1; }
command -v nmcli >/dev/null || { echo 'NetworkManager is required; current network setup has not been changed.'; exit 1; }
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/var/backups/pidisplay/$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
backup() { if [[ -e "$1" ]]; then cp -a --parents "$1" "$BACKUP/"; fi; }
for f in /etc/systemd/system/pidisplay.service /etc/systemd/system/pidisplay-kiosk.service /etc/sudoers.d/pidisplay /usr/local/libexec/pidisplay-network /boot/firmware/config.txt /boot/firmware/cmdline.txt; do backup "$f"; done
if [[ -d /opt/pidisplay ]]; then cp -a /opt/pidisplay "$BACKUP/application"; fi
apt-get update
apt-get install -y --no-install-recommends nodejs npm python3 python3-pygame network-manager avahi-daemon xserver-xorg xinit x11-xserver-utils openbox fonts-noto-cjk sudo curl git
id pidisplay >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/pidisplay --shell /usr/sbin/nologin pidisplay
usermod -aG video,render,input,tty pidisplay
install -d -m 755 /opt/pidisplay /usr/local/libexec
cp -a "$SRC/." /opt/pidisplay/
# No source folder node_modules or state should be copied from the Mac (use the release tarball).
cd /opt/pidisplay
npm ci --ignore-scripts --omit=dev
chown -R root:root /opt/pidisplay
install -m 755 network-helper.py /usr/local/libexec/pidisplay-network
printf 'pidisplay ALL=(root) NOPASSWD: /usr/local/libexec/pidisplay-network\n' > /etc/sudoers.d/pidisplay
chmod 440 /etc/sudoers.d/pidisplay
visudo -cf /etc/sudoers.d/pidisplay
cat > /etc/systemd/system/pidisplay.service <<'UNIT'
[Unit]
Description=PiDisplay HDMI web and music service
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
User=pidisplay
Group=pidisplay
WorkingDirectory=/var/lib/pidisplay
Environment=PIDISPLAY_STATE=/var/lib/pidisplay/state
ExecStart=/usr/bin/node /opt/pidisplay/server.js
Restart=on-failure
RestartSec=5
UMask=0077
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/pidisplay-kiosk.service <<'UNIT'
[Unit]
Description=PiDisplay HDMI fullscreen kiosk
After=pidisplay.service systemd-user-sessions.service getty@tty1.service
Wants=pidisplay.service
Conflicts=getty@tty1.service
[Service]
User=pidisplay
Group=pidisplay
PAMName=login
WorkingDirectory=/var/lib/pidisplay
Environment=HOME=/var/lib/pidisplay
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
ExecStart=/usr/bin/startx /opt/pidisplay/kiosk.sh -- :0 vt1 -keeptty -nolisten tcp -nocursor
Restart=always
RestartSec=5
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
UNIT
# Existing desktop must be considered before enabling a competing X server.
if systemctl is-active --quiet display-manager; then
  echo 'An existing desktop is running. Web service will start; kiosk activation requires choosing how to replace the desktop.'
  systemctl daemon-reload
  systemctl enable --now pidisplay.service
  exit 2
fi
python3 - <<'PY'
from pathlib import Path
p=Path('/boot/firmware/config.txt')
s=p.read_text()
if '# PiDisplay HDMI' not in s:
    p.write_text(s+'\n[all]\n# PiDisplay HDMI: prevent auto-enabling a DSI panel\ndisplay_auto_detect=0\n')
PY
systemctl daemon-reload
systemctl enable --now avahi-daemon pidisplay.service pidisplay-kiosk.service
systemctl is-active --quiet pidisplay.service
curl --fail --retry 10 --retry-delay 2 --retry-connrefused http://127.0.0.1:8787/api/status
printf '\nInstalled. Backup: %s\nA reboot may be required for display configuration.\n' "$BACKUP"
