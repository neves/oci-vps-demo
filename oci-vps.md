# Oracle Cloud 1GB VPS (Ubuntu) — Low-Memory Optimization Guide

This guide reproduces all memory, swap, kernel, and service optimizations applied to `oci-br-neves` (Oracle Cloud 1GB RAM Ubuntu instance), cutting baseline RAM usage by **50%** (from **~408 MB** down to **~205 MB** used, freeing **~745 MB** available) and adding **2.5 GB of tiered ZRAM + Disk Swap**.

---

## Results Overview

| Metric | Default OCI Ubuntu | Optimized | Improvement |
| :--- | :--- | :--- | :--- |
| **Used RAM** | ~408 MB | **~205 MB** | **-203 MB (-50%)** |
| **Available RAM** | ~542 MB | **~745 MB** | **+203 MB** |
| **Swap (ZRAM + Disk)** | 0 MB | **2,523 MB** (476 MB ZRAM + 2 GB disk) | **+2.5 GB** |
| **Running Services** | 22 | **11** | **-11 services** |
| **Snap Loop Mounts** | 5 | **0** | Cleaned |

---

## 1. Remove `oracle-cloud-agent` & Purge `snapd` (~100 MB saved)

Oracle Cloud Agent and `snapd` consume ~100–200 MB of RAM and mount multiple squashfs loop devices.

```bash
# Stop Oracle Cloud Agent services
sudo systemctl stop snap.oracle-cloud-agent.oracle-cloud-agent.service \
                    snap.oracle-cloud-agent.oracle-cloud-agent-updater.service || true

# Purge installed snaps
sudo snap remove --purge oracle-cloud-agent || true
sudo snap remove --purge core18 core20 core22 core24 || true
sudo snap remove --purge snapd || true

# Stop and purge snapd & multipath-tools via apt
sudo systemctl stop snapd.service snapd.socket snapd.seeded.service || true
sudo apt-get purge -y snapd multipath-tools

# Prevent Ubuntu from reinstalling snapd on future updates
sudo apt-mark hold snapd

# Clean leftover snap directories
sudo rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd ~/snap
```

---

## 2. Disable & Purge Unneeded Background Services (~90 MB saved)

Single-disk cloud VMs do not need firmware updaters (`fwupd`), desktop disk managers (`udisks2`), cellular modem managers (`ModemManager`), resident crash reporters (`apport`), PolicyKit (`polkitd`), or iSCSI/NFS daemons (`open-iscsi`, `rpcbind` — **only remove `open-iscsi` if you have no extra OCI iSCSI block volumes attached; verify with `sudo iscsiadm -m session` first**).

```bash
# Stop and disable unneeded services and timers
sudo systemctl disable --now \
  fwupd.service fwupd-refresh.timer \
  udisks2.service \
  ModemManager.service \
  unattended-upgrades.service \
  iscsid.service iscsid.socket open-iscsi.service \
  rpcbind.service rpcbind.socket \
  motd-news.timer || true

# Install lightweight systemd-timesyncd to replace chrony, then purge bloat
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y systemd-timesyncd
sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y \
  fwupd udisks2 modemmanager open-iscsi rpcbind \
  chrony polkitd apport ubuntu-pro-client ubuntu-advantage-tools

# Remove orphaned dependencies and clean apt cache
sudo DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y
sudo apt-get clean

# Enable systemd-timesyncd
sudo systemctl enable --now systemd-timesyncd
```

---

## 3. Systemd User Manager (`user@.service`)

- **If you DO NOT use `t3 service install` (or other `systemctl --user` services)**: You can mask `user@.service` to save ~13 MB of RAM on SSH login:
  ```bash
  sudo systemctl mask user@.service user@1000.service user@1001.service
  sudo systemctl stop user@1000.service user@1001.service 2>/dev/null || true
  ```
- **If you DO use `t3 service install` (which runs as a `systemd --user` service)**: Keep `user@.service` unmasked and enable lingering so your user service stays running in the background after you log out:
  ```bash
  sudo systemctl unmask user@.service user@1000.service user@1001.service
  sudo loginctl enable-linger ubuntu
  sudo systemctl start user@$(id -u).service
  grep -q 'XDG_RUNTIME_DIR' ~/.bashrc || echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u)' >> ~/.bashrc
  ```

---

## 4. Cap `systemd-journald` Memory & Disk Usage (~15 MB saved)

Limit `systemd-journald` so its memory-mapped journal files don't grow unbounded in `/run` and `/var/log`.

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
cat << 'EOF' | sudo tee /etc/systemd/journald.conf.d/size.conf >/dev/null
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=20M
EOF

sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=30M
```

---

## 5. Configure Tiered ZRAM + 2GB Disk Swap & Kernel Watermarks

This sets up a two-tier swap architecture:
1. **Tier 1 — ZRAM (`priority 100`)**: 50% of RAM (~476 MB) compressed in-memory using `zstd` (~3:1 compression ratio) for fast, zero-disk-I/O swapping.
2. **Tier 2 — Disk Swapfile (`priority 10`)**: 2 GB `/swapfile` on disk as an overflow safety net against OOM killer spikes.
3. **Kernel Memory Tuning (`vm.min_free_kbytes=16384` & `vm.swappiness=10`)**: Ubuntu's Oracle kernel defaults to `vm.min_free_kbytes=43060` (locking ~65 MB in kernel watermarks). Lowering it to 16 MB immediately frees **~40 MB** of usable RAM.

```bash
# 1. Install and configure ZRAM (Tier 1, Priority 100)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y zram-tools
cat << 'EOF' | sudo tee /etc/default/zramswap >/dev/null
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF
sudo systemctl restart zramswap

# 2. Create 2GB Swapfile (Tier 2, Priority 10)
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon -p 10 /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw,pri=10 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 3. Tune swappiness and kernel free memory watermarks
cat << 'EOF' | sudo tee /etc/sysctl.d/99-memory-tuning.conf >/dev/null
vm.swappiness=10
vm.min_free_kbytes=16384
EOF
sudo sysctl -p /etc/sysctl.d/99-memory-tuning.conf
```

---

## 6. Unload & Blacklist Unused Kernel Modules (~8 MB Kernel Slab saved)

Oracle Cloud kernels load modules for Wi-Fi (`cfg80211`), nested KVM virtualization (`kvm_amd`, `kvm`), enterprise iSCSI HBAs (`cxgb4`, `qla4xxx`, `bnx2i`, `be2iscsi`), floppy drives, sound, and USB HID devices.

```bash
cat << 'EOF' | sudo tee /etc/modprobe.d/blacklist-vps.conf >/dev/null
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

# Unload immediately without waiting for a reboot
sudo umount /run/rpc_pipefs 2>/dev/null || true
sudo modprobe -r cfg80211 kvm_amd kvm floppy psmouse usbhid hid_generic hid \
  be2iscsi bnx2i cnic cxgb4i cxgb3i libcxgbi cxgb4 cxgb3 qla4xxx \
  iscsi_tcp libiscsi_tcp libiscsi scsi_transport_iscsi auth_rpcgss sunrpc \
  soundcore joydev qrtr 2>/dev/null || true
```

---

## 7. Tune Tailscale Go Garbage Collector (`GOGC=30`)

If running `tailscaled`, setting `GOGC=30` instructs the Go runtime to run garbage collection more aggressively, saving ~5–8 MB of resident heap memory.

```bash
sudo mkdir -p /etc/systemd/system/tailscaled.service.d
cat << 'EOF' | sudo tee /etc/systemd/system/tailscaled.service.d/mem.conf >/dev/null
[Service]
Environment="GOGC=30"
EOF

sudo systemctl daemon-reload
sudo systemctl restart tailscaled
```

---

## 8. Lock Down `sshd` Against Bot Memory Spikes

Internet bots constantly brute-force port 22. Default `MaxStartups 10:30:100` and `LoginGraceTime 120` allow up to 100 concurrent unauthenticated SSH handshakes, which can spike RAM usage by 50–150 MB.

```bash
cat << 'EOF' | sudo tee /etc/ssh/sshd_config.d/99-hardening-lowmem.conf >/dev/null
# Lock down SSH for minimal RAM footprint & bot protection
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

sudo sshd -t && sudo systemctl reload ssh
```

---

## 9. Verification Commands

Run the following to verify memory, swap tiers, and running services:

```bash
# Check memory and swap tiers
free -m
swapon --show

# List all active services
systemctl list-units --type=service --state=running

# Measure true per-process Proportional Set Size (PSS) memory
sudo python3 -c '
import glob
procs = []
for p in glob.glob("/proc/[0-9]*/smaps_rollup"):
    try:
        pid = p.split("/")[2]
        comm = open(f"/proc/{pid}/comm").read().strip()
        pss = sum(int(l.split()[1]) for l in open(p) if l.startswith("Pss:"))
        procs.append((pss, pid, comm))
    except Exception:
        pass
procs.sort(reverse=True)
print(f"Total User-Space PSS: {sum(x[0] for x in procs)/1024:.1f} MB")
for pss, pid, comm in procs[:15]:
    print(f"{pid:>6}  {comm:<18} {pss/1024:>6.1f} MB")
'
```
