#!/usr/bin/env bash
# Idempotent low-memory setup for Ubuntu OCI 1 GiB VPSes.
# Tailscale is intentionally not modified or restarted.
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || { echo "Unsupported distro: ${PRETTY_NAME:-unknown}" >&2; exit 1; }

# Install CLI utilities. mise is bootstrapped with its upstream installer because it
# is not available from the Ubuntu apt sources on these hosts.
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y btop htop wget curl vim git unzip sqlite3 iotop iftop nethogs ncdu locales libatomic1
# SSH forwards LC_ALL=en_US.UTF-8; generate it to avoid the remote shell warning.
sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
locale-gen en_US.UTF-8
# The Oracle agent snap is removed below; drop its stale/invalid sudoers rules before
# installing mise tools such as the OCI CLI, whose installer invokes sudo.
rm -f /etc/sudoers.d/100-oracle-cloud-agent-users
runuser -u ubuntu -- env HOME=/home/ubuntu bash -euo pipefail -c '
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v mise >/dev/null 2>&1; then curl -fsSL https://mise.run | sh; fi
  export PATH="$HOME/.local/bin:$PATH"
  activation="eval \"\$(~/.local/bin/mise activate bash)\""
  grep -Fqx "$activation" "$HOME/.bashrc" || printf "%s\\n" "$activation" >> "$HOME/.bashrc"
  mise --version
  mise use --global uv@latest
  mise use --global bun node python fzf pypi:httpie gcloud gh oci fd dust ripgrep bat eza npm:cf@1.0.0-beta.26 pi
'

snapshot() {
  echo "--- $(date -Is) memory ---"
  free -h
  echo '--- swap ---'
  swapon --show
}
snapshot

# Remove snapd and OCI agent snaps only when installed; never stop/reconfigure Tailscale.
for unit in snap.oracle-cloud-agent.oracle-cloud-agent.service snap.oracle-cloud-agent.oracle-cloud-agent-updater.service snapd.service snapd.socket snapd.seeded.service; do
  systemctl stop "$unit" 2>/dev/null || true
done
if command -v snap >/dev/null 2>&1; then
  for name in oracle-cloud-agent core18 core20 core22 core24 snapd; do snap remove --purge "$name" 2>/dev/null || true; done
fi
DEBIAN_FRONTEND=noninteractive apt-get purge -y snapd multipath-tools || true
if apt-cache show snapd >/dev/null 2>&1; then apt-mark hold snapd || true; fi
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd /home/ubuntu/snap
snapshot

# iSCSI has been checked for active sessions before deployment; purge as described in runbook.
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y systemd-timesyncd zram-tools
for unit in fwupd.service fwupd-refresh.timer udisks2.service ModemManager.service unattended-upgrades.service iscsid.service iscsid.socket open-iscsi.service rpcbind.service rpcbind.socket motd-news.timer; do
  systemctl disable --now "$unit" 2>/dev/null || true
done
DEBIAN_FRONTEND=noninteractive apt-get purge -y fwupd udisks2 modemmanager open-iscsi rpcbind chrony polkitd apport ubuntu-pro-client ubuntu-advantage-tools || true
DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y
apt-get clean
systemctl enable --now systemd-timesyncd
# polkit can be D-Bus socket-activated, so masking is stronger than disabling.
systemctl mask polkit.service 2>/dev/null || true
systemctl stop polkit.service 2>/dev/null || true
snapshot

# Keep user manager if a user service is active; otherwise mask it.
uid=$(id -u ubuntu)
if runuser -u ubuntu -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user list-units --type=service --state=running --no-legend 2>/dev/null | grep -q .; then
  systemctl unmask user@.service "user@${uid}.service" || true
  loginctl enable-linger ubuntu
  systemctl start "user@${uid}.service" || true
  grep -q 'XDG_RUNTIME_DIR' /home/ubuntu/.bashrc || echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u)' >> /home/ubuntu/.bashrc
else
  systemctl mask user@.service "user@${uid}.service"
  systemctl stop "user@${uid}.service" 2>/dev/null || true
fi
snapshot

install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/size.conf <<'EOF'
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=20M
EOF
systemctl restart systemd-journald
journalctl --vacuum-size=30M
snapshot

cat > /etc/default/zramswap <<'EOF'
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF
if modinfo -k "$(uname -r)" zram >/dev/null 2>&1; then
  systemctl enable zramswap
  if ! systemctl restart zramswap; then
    echo 'zram module exists but zramswap failed; disabling it and continuing with disk swap.' >&2
    systemctl disable --now zramswap || true
  fi
else
  echo "zram module is unavailable for kernel $(uname -r); leaving zramswap disabled and using disk swap." >&2
  systemctl disable --now zramswap 2>/dev/null || true
fi
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
if ! grep -qE '^/swapfile\s' /etc/fstab; then echo '/swapfile none swap sw,pri=10 0 0' >> /etc/fstab; fi
swapon --priority 10 /swapfile 2>/dev/null || true
cat > /etc/sysctl.d/99-memory-tuning.conf <<'EOF'
vm.swappiness=10
vm.min_free_kbytes=16384
EOF
sysctl -p /etc/sysctl.d/99-memory-tuning.conf
snapshot

cat > /etc/modprobe.d/blacklist-vps.conf <<'EOF'
blacklist cfg80211
blacklist kvm_amd
blacklist kvm
blacklist floppy
blacklist psmouse
blacklist usbhid
blacklist hid_generic
blacklist hid
blacklist be2iscsi
blacklist bnx2i
blacklist cnic
blacklist cxgb4i
blacklist cxgb3i
blacklist libcxgbi
blacklist cxgb4
blacklist cxgb3
blacklist qla4xxx
blacklist iscsi_tcp
blacklist libiscsi_tcp
blacklist libiscsi
blacklist scsi_transport_iscsi
blacklist sunrpc
blacklist auth_rpcgss
blacklist soundcore
blacklist joydev
blacklist qrtr
EOF
umount /run/rpc_pipefs 2>/dev/null || true
modprobe -r cfg80211 kvm_amd kvm floppy psmouse usbhid hid_generic hid be2iscsi bnx2i cnic cxgb4i cxgb3i libcxgbi cxgb4 cxgb3 qla4xxx iscsi_tcp libiscsi_tcp libiscsi scsi_transport_iscsi auth_rpcgss sunrpc soundcore joydev qrtr 2>/dev/null || true
snapshot

install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-hardening-lowmem.conf <<'EOF'
# Lock down unauthenticated SSH connection memory use.
MaxStartups 2:50:4
LoginGraceTime 15
MaxAuthTries 3
PermitRootLogin no
AllowUsers ubuntu
X11Forwarding no
UseDNS no
ClientAliveInterval 120
ClientAliveCountMax 2
EOF
# Do not accept arbitrary LC_* from SSH clients: malformed values such as
# LC_CTYPE=UTF-8 trigger repeated shell locale warnings. LANG remains accepted.
sed -i '/^[[:space:]]*AcceptEnv[[:space:]]/s/LC_\*//g' /etc/ssh/sshd_config
sshd -t
systemctl reload ssh
snapshot

echo '--- final validation ---'
systemctl is-active systemd-timesyncd
sshd -t
swapon --show
systemctl --no-pager --type=service --state=running | head -30
