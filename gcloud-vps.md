# gcloud-vps.md — Low-Memory Service Removal Runbook (GCP VPS shape)

Executed change-set on:

- **SSH:** `ssh marcos.neves@gcloud.mora-tilapia.ts.net`
- **Host:** `us-east1-2vcpu-1gb-30gb` — GCP `e2-micro` (Debian 13, ~964 MB RAM, 2 vCPU burst)
- **Guide inspiration:** `oci-vps.md` (Oracle Cloud 1GB VPS low-memory guide)

Target VPS shape for re-run: small Linux VPS (~1 GB RAM), Debian/Ubuntu-like, running a similar set of background services (cloud guest agent, mail daemon, policykit, network dispatcher, unattended-upgrades, tailscaled, systemd user manager, journald).

Each change below was applied and followed by a before/after memory measurement.

---

## Baseline measurement commands (run before any change)

```bash
free -m
swapon --show
systemctl list-units --type=service --state=running

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
for pss, pid, comm in procs[:25]:
    print(f"{pid:>6}  {comm:<40} {pss/1024:>6.1f} MB")
'
```

**Baseline result:** Used **361 MB**, Available **602 MB**, Total User-Space **PSS 344.5 MB**, Swap **0**, Running services **22**.

---

## Change 1 — Stop/disable Google guest agent stack

(Adapted from `oci-vps.md` §1 — stop cloud agent; on this Debian/GCP host the agent is the Google guest stack.)

```bash
sudo systemctl stop google-guest-agent-manager.service \
                    google-guest-compat-manager.service \
                    google-osconfig-agent.service \
                    google-shutdown-scripts.service || true

sudo systemctl disable --now \
  google-guest-agent-manager.service \
  google-guest-compat-manager.service \
  google-osconfig-agent.service \
  google-shutdown-scripts.service || true
```

**Measured after:** Used **299 MB**, PSS **176.2 MB**, services **19**.

**Delta:** **−168.3 MB PSS** freed.

---

## Change 2 — Stop & purge exim4 mail daemon

```bash
sudo systemctl stop exim4.service
sudo apt-get purge -y exim4 exim4-base
```

**Measured after:** PSS **158.6 MB**.

**Delta:** **−17.6 MB PSS** freed.

---

## Change 3 — Cap systemd-journald memory/disk usage + vacuum

(Adapted from `oci-vps.md` §4.)

```bash
sudo mkdir -p /etc/systemd/journald.conf.d

sudo bash -c "cat << EOF > /etc/systemd/journald.conf.d/size.conf
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=20M
EOF"

sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=30M
```

**Measured after:** journald RSS **15.0 → 9.6 MB**; journal disk usage **32.5M → 27.5M**.

**Delta:** **−5.3 MB PSS** freed.

---

## Change 4 — Disable & kill unattended-upgrades

(Adapted from `oci-vps.md` §2 — disable unattended-upgrades.)

```bash
sudo systemctl disable --now unattended-upgrades.timer unattended-upgrades.service || true
sudo systemctl stop unattended-upgrades.service 2>/dev/null || true
sudo pkill -f 'unattended-upgr[o]p' 2>/dev/null || true
```

**Measured after:** PSS **140.4 MB** (the `unattended-upgrade` python process had ballooned to ~97 MB before being killed).

**Delta:** **−12.9 MB PSS** freed.

---

## Change 5 — Tune tailscaled Go garbage collector

(Adapted from `oci-vps.md` §7 — `GOGC=30`.)

```bash
sudo mkdir -p /etc/systemd/system/tailscaled.service.d

sudo bash -c "cat << EOF > /etc/systemd/system/tailscaled.service.d/mem.conf
[Service]

Environment=\"GOGC=30\"
EOF"

sudo systemctl daemon-reload
sudo systemctl restart tailscaled
```

**Measured after:** tailscaled RSS **47.5 → 40.3 MB**; PSS **133.9 MB**.

**Delta:** **−6.5 MB PSS** freed.

---

## Change 6 — Disable polkit

(Adapted from `oci-vps.md` §2 — disable PolicyKit on a headless server.)

```bash
sudo systemctl disable --now polkit.service || true
```

**Measured after:** PSS **132.8 MB**.

**Delta:** **−1.1 MB PSS** freed.

---

## Change 7 — Disable networkd-dispatcher

```bash
sudo systemctl disable --now networkd-dispatcher.service || true
```

**Measured after:** PSS **116.0 MB**.

**Delta:** **−16.8 MB PSS** freed.

---

## Change 8 — Harden sshd against bot memory spikes

(Adapted from `oci-vps.md` §8 — low `MaxStartups`, `LoginGraceTime`, `MaxAuthTries`, no X11, etc. Adjusted `AllowUsers` to the actual user: `marcos.neves`.)

```bash
sudo bash -c "cat << EOF > /etc/ssh/sshd_config.d/99-hardening-lowmem.conf
MaxStartups 2:50:4
LoginGraceTime 15
MaxAuthTries 3
PermitRootLogin no
AllowUsers marcos.neves
X11Forwarding no
UseDNS no
ClientAliveInterval 120
ClientAliveCountMax 2
EOF"

sudo sshd -t && sudo systemctl reload ssh
```

**Applied and validated** (`sshd -t` OK, reload OK, SSH connectivity re-verified OK).

No direct process-memory delta attributable to sshd itself (config-only hardening); final-state measurement stands at PSS **112.0 MB**.

---

---

## Change 9 — Mask systemd user manager instance

(Adapted from `oci-vps.md` §3 — no `systemd --user` services in use, so mask the instance.)

```bash
sudo systemctl stop user@1001.service 2>/dev/null || true
sudo systemctl disable user@1001.service 2>/dev/null || true
sudo systemctl mask user@1001.service 2>/dev/null || true
```

**Measured after:** systemd `--user` process terminated; PSS **112.0 MB** (down from **116.0 MB** post-Change 7).

**Delta:** **−4.0 MB PSS** freed.

---

## Change 10 — Tiered ZRAM + 2GB disk swap & kernel tuning

(Adapted from `oci-vps.md` §5 — two-tier swap + kernel watermarks. Executed on request after the service-removal pass.)

```bash
# 1. Install and configure ZRAM (Tier 1, Priority 100)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y zram-tools
sudo bash -c "cat << EOF > /etc/default/zramswap
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF"
sudo systemctl restart zramswap

# 2. Create 2GB Swapfile (Tier 2, Priority 10)
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon -p 10 /swapfile
fi
grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw,pri=10 0 0' | sudo tee -a /etc/fstab >/dev/null

# 3. Tune swappiness and kernel free memory watermarks
sudo bash -c "cat << EOF > /etc/sysctl.d/99-memory-tuning.conf
vm.swappiness=10
vm.min_free_kbytes=16384
EOF"
sudo sysctl -p /etc/sysctl.d/99-memory-tuning.conf
```

**Executed result:**
- ZRAM: `/dev/zram0` — 482.3M (zstd, priority 100)
- Disk swap: `/swapfile` — 2G (priority 10)
- `vm.swappiness=10`, `vm.min_free_kbytes=16384`
- `free -m` → Swap: **2530 MB** total

**Measured after:** Used **204 MB**, Available **760 MB**, Swap **2530 MB**, PSS **125.9 MB**.

**Caveat:** PSS rose ~14 MB versus the 112.0 MB post-Change-9 reading. Cause: installing `zram-tools` pulled in dependencies (notably `bc`) and **re-activated `polkit.service`** via D-Bus socket activation — `systemctl disable` does not prevent D-Bus activation, so `polkitd` (PID 4734) is running again at ~5.2 MB. The swap itself costs no resident RAM (ZRAM compresses into the pages it swaps).

---

## Change 11 — Generate `en_US.UTF-8` locale (fix bash setlocale warning)

New SSH sessions printed `bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8): No such file or directory`. The `deb13-cloud` image ships **without** the `locales` package, so no locale data existed while the client sent `LC_ALL=en_US.UTF-8`.

```bash
# 1. Install the locales infrastructure (provides /etc/locale.gen, locale-gen, update-locale)
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y locales

# 2. Uncomment en_US.UTF-8 and generate it
sudo sed -i 's/^# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
sudo locale-gen

# 3. Make it the system default
sudo update-locale LANG=en_US.UTF-8

# 4. Verify from a fresh session (expect: no warnings, locale -a lists en_US.utf8)
locale -a | grep -i en_US
locale
```

**Measured after:** warning eliminated on fresh SSH login; `LANG=en_US.UTF-8` resolves cleanly. PSS **119.4 MB** on the final re-read (the 125.9 → 119.4 MB swing is normal measurement variance from `journald`/`polkitd` settling, **not** attributable to this config-only change).

---

## Final verification

```bash
free -m
swapon --show
systemctl list-units --type=service --state=running

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
for pss, pid, comm in procs[:25]:
    print(f"{pid:>6}  {comm:<40} {pss/1024:>6.1f} MB")
'
```

**Final result:** Used **189 MB**, Available **774 MB**, Total User-Space **PSS 119.4 MB**, Swap **2530 MB** (482.3M ZRAM + 2G disk), Running services **15**.

---

## Final report (executed on the GCP VPS)

| Metric | Baseline | Final | Delta |
| :--- | ---: | ---: | ---: |
| Used RAM | 361 MB | **189 MB** | **−172 MB (−48%)** |
| Available RAM | 602 MB | **774 MB** | **+172 MB** |
| Total User-Space PSS | 344.5 MB | **119.4 MB** | **−225.1 MB (−65%)** |
| Swap | 0 MB | **2530 MB** | **+2530 MB** |
| Running services | 22 | **15** | **−7** |

### Per-change memory deltas (PSS)

| Change | Description | Before | After | Δ |
|---|---|---:|---:|---:|
| 0 | Baseline | 344.5 MB | — | — |
| 1 | Google guest agent stack | 344.5 → 176.2 MB | — | **−168.3 MB** |
| 2 | exim4 mail daemon purged | 176.2 MB | 158.6 MB | **−17.6 MB** |
| 3 | journald capped + vacuumed | 158.6 MB | 153.3 MB | **−5.3 MB** |
| 4 | unattended-upgrades killed | 153.3 MB | 140.4 MB | **−12.9 MB** |
| 5 | tailscaled GOGC=30 | 140.4 MB | 133.9 MB | **−6.5 MB** |
| 6 | polkit disabled | 133.9 MB | 132.8 MB | **−1.1 MB** |
| 7 | networkd-dispatcher disabled | 132.8 MB | 116.0 MB | **−16.8 MB** |
| 8 | sshd hardened (config-only) | 116.0 MB | 116.0 MB | ~0 (no proc delta) |
| 9 | user manager masked | 116.0 MB | 112.0 MB | **−4.0 MB** |
| 10 | ZRAM + 2G swap + sysctl | 112.0 MB | 125.9 MB | **+13.9 MB** (zram-tools deps; polkit re-activated) |
| 11 | locale fix `en_US.UTF-8` | 125.9 MB | 119.4 MB | ~0 (config-only; variance) |

**Overall: −225.1 MB PSS (−65%) and −172 MB used RAM released; 7 services removed (22 → 15 running); +2530 MB swap added.**

### Final top processes (PSS)

1. tailscaled — 42.4 MB
2. systemd-journald — 12.2 MB
3. python3 — 8.3 MB
4. systemd (PID 1) — 7.2 MB
5. systemd-resolved — 5.5 MB
6. polkitd — 5.2 MB *(returned via D-Bus activation)*
7. systemd-networkd — 4.5 MB
8. sshd-session — 4.3 MB
9. haveged — 3.6 MB
10. systemd-udevd — 3.5 MB

### Final running services (15)

cron, dbus, getty@tty1, haveged, **polkit**, rsyslog, serial-getty@ttyS0, ssh, systemd-journald, systemd-logind, systemd-networkd, systemd-resolved, systemd-timesyncd, systemd-udevd, tailscaled.

> Plus **zramswap.service** (enabled; one-shot `active (exited)`, holds no resident memory, so it does not appear in `--state=running`).

### Swap tiers (final)

```
NAME       TYPE      SIZE USED PRIO
/dev/zram0 partition 482.3M 512K 100
/swapfile  file       2G     0B   10
```

---

## Notes / adaptations for other VPS with the same shape

- No `snapd`/Oracle agent on this host; the cloud agent to remove is the **Google guest agent** stack instead.
- Package/unit names differ slightly by distro; on Ubuntu use the exact unit/package names from `oci-vps.md`.
- `AllowUsers` was set to the real login user (`marcos.neves`); adjust to your user on the target VPS.
- `unattended-upgrades` kill may require a follow-up `systemctl stop` + process kill if the unit respawns.
- Swap was added during this session (see Change 10): ZRAM 482.3M + 2G disk swap, `vm.swappiness=10`, `vm.min_free_kbytes=16384`.
- **`swapon` is in `/sbin`, not the default non-login PATH** — use `sudo swapon --show` or `$PATH=/usr/sbin:/sbin:$PATH`. `free -m` is the reliable cross-check.
- **`polkit.service` is D-Bus socket-activated**, so `systemctl disable --now polkit.service` only holds until something talks to it again. To keep it dead, mask it: `sudo systemctl mask polkit.service` (verify nothing on the box needs it first).
- The `deb13-cloud` image has no `locales` package; if your client sends `LC_ALL`, apply Change 11 or the bash setlocale warning repeats on every login.
- `zram-tools` pulls in `bc` — expect a small PSS increase that offsets part of the savings from Change 10.

---

## Change 12 — Second-pass audit: timers, THP, haveged, rsyslog, polkit, tty1 getty

(Executed on request as a final RAM squeeze. Same before/after measurement method as above.)

**Before:** Used 189 MB (page-cache quiesced) / Available 774 MB / PSS **119.4 MB** / 15 services.

```bash
# A. MASK THE apt TIMERS — the 97 MB regression landmine
#    unattended-upgrade had ballooned to 97 MB (PID 2774); apt-daily-upgrade.timer
#    was still enabled and would have re-spawned it.
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer google-oslogin-cache.timer
sudo systemctl mask apt-daily.service apt-daily-upgrade.service google-oslogin-cache.service

# B. MASK polkit (plain `disable` does NOT survive D-Bus socket activation)
sudo systemctl mask polkit.service
sudo systemctl stop polkit.service

# C. MASK rsyslog (journald is already persistent in /var/log/journal, capped at 50M)
sudo systemctl disable --now rsyslog.service

# D. MASK the virtual-console getty (keep serial-getty@ttyS0 for GCP serial console)
sudo systemctl mask getty@tty1.service
sudo systemctl stop getty@tty1.service

# E. PURGE haveged — redundant: virtio_rng is loaded and "random: crng init done"
cat /proc/sys/kernel/random/entropy_avail   # expect 256 (full pool)
sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y haveged

# F+G. Transparent hugepages: always -> madvise (runtime + persisted as a unit)
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
sudo bash -c "cat << EOF > /etc/systemd/system/thp-madvise.service
[Unit]
Description=Set transparent hugepage mode to madvise
After=systemd-tmpfiles-setup.service
Wants=systemd-tmpfiles-setup.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c \"echo madvise > /sys/kernel/mm/transparent_hugepage/enabled; echo madvise > /sys/kernel/mm/transparent_hugepage/defrag || true\"
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF"
sudo systemctl daemon-reload
sudo systemctl enable thp-madvise.service
```

**After:** PSS **112.3 MB** (−7.1 MB), services **15 → 11**, steady used **~228 MB** / available **~736 MB** with `buff/cache` quiesced.

**Measurement caveat:** immediately after this batch `free` reported used 259 MB — that was **page-cache noise from the apt purge I/O**, not a regression (Slab/AnonPages/VmallocUsed were flat or down). `drop_caches` confirmed it: used 259 → 223 MB, cache 371 → 73 MB. **Use PSS or a post-`drop_caches` reading when comparing.**

### Audit findings that were NOT worth acting on

- **Kernel module blacklisting (`oci-vps.md` §6) is pointless on this image:** all 69 loaded modules total only **3.0 MB**. The GCP `deb13-cloud` kernel already ships a minimal module set — none of the Wi-Fi/iSCSI/sound/HID bloat the OCI guide removes is present.
- `systemd-udevd` (3.6 MB) can be stopped post-boot but breaks device hot-plug (GCP disk attach) — not recommended.
- `systemd-logind` + `dbus` (4.8 MB) are on the SSH/PAM session path — not recommended.

### Remaining opt-in wins (need approval — they touch the SSH transport / DNS)

| Target | Current | Action | Expected | Risk |
| :--- | ---: | :--- | ---: | :--- |
| `tailscaled` | **44.4 MB** | add `Environment="GOMEMLIMIT=32MiB"` to the existing drop-in, restart | −5 to −12 MB | restarts the Tailscale tunnel you are SSH'd through |
| `systemd-resolved` | 5.6 MB | disable + write a static `/etc/resolv.conf` | −5.6 MB | breaks DNS if the replacement file is wrong; `/etc/resolv.conf` is currently a symlink into `/run/systemd/resolve/` |
| `systemd-journald` | 12.7 MB | `Seal=no`, `Storage=volatile` | −2 to −4 MB | loses tamper-proof/`journalctl -b` persistence |
| Google/cloud packages | 0 MB (already stopped) | purge `google-guest-agent`, `google-osconfig-agent`, `google-compute-engine`, `google-compute-engine-oslogin`, `unattended-upgrades`, `networkd-dispatcher`, `google-cloud-cli` | 0 MB now; **locks in Change 1** and prevents ~168 MB respawning after reboot | verify nothing depends on OSLogin PAM/NSS before purging `google-compute-engine-oslogin` |

**Do not** purge `google-disk-expand.service` / keep it enabled — it is what grows the root filesystem on a new instance.

Safe pattern for the `tailscaled` change (survives the SSH session dropping) — run the restart and rollback guard detached:

```bash
sudo systemd-run --quiet --uid=root --collect -p Type=exec bash -c '
  sleep 5
  if ! /usr/sbin/tailscale status >/dev/null 2>&1; then
    rm -f /etc/systemd/system/tailscaled.service.d/gomemlimit.conf
    systemctl restart tailscaled
  fi'
```

---

## Change 13 — Bound `tailscaled` heap with `GOMEMLIMIT` (guarded trial)

`tailscaled` was the last large consumer (**43.3 MB PSS**). Because the SSH session rides the Tailscale tunnel, a bad value means lockout — so this was run as a **detached, self-rolling-back trial** rather than a direct restart.

**Before:** tailscaled RSS 44.4 MB / PSS 43.3 MB · total PSS **112.3 MB**

### 1. Rollback guard (survives the SSH session dropping)

`/usr/local/bin/ts_memtrial.sh` — restarts the unit, health-checks for up to 60 s, and **removes the drop-in + restarts again** if unhealthy:

```bash
#!/bin/bash
DROPIN=/etc/systemd/system/tailscaled.service.d/gomemlimit.conf
LOG=/root/ts-memtrial.log
exec >>"$LOG" 2>&1
echo "=== $(date -u) trial start: $(cat $DROPIN 2>/dev/null | tr -d '\n') ==="
healthy() {
  systemctl is-active --quiet tailscaled || return 1
  local out
  out=$(tailscale status 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  echo "$out" | grep -q "100\." || return 1
  return 0
}
systemctl daemon-reload
systemctl restart tailscaled
for i in $(seq 1 15); do
  sleep 4
  if healthy; then echo "HEALTHY after $((i*4))s -- keeping GOMEMLIMIT"; exit 0; fi
  echo "  not healthy yet ($((i*4))s)"
done
echo "UNHEALTHY after 60s -- ROLLING BACK"
rm -f "$DROPIN"
systemctl daemon-reload
systemctl restart tailscaled
sleep 6
if healthy; then echo "ROLLBACK OK: tailscaled healthy without GOMEMLIMIT"; else echo "CRITICAL: still unhealthy after rollback -- needs console access"; fi
```

Launch it **via `systemd-run`, not in the foreground** — a foreground restart kills the tunnel under your own SSH session and SIGHUPs the rollback logic with it:

```bash
sudo chmod +x /usr/local/bin/ts_memtrial.sh
sudo systemd-run --quiet --uid=root --collect -p Type=exec \
  -p Description="tailscaled GOMEMLIMIT trial + rollback guard" \
  /usr/local/bin/ts_memtrial.sh
sudo tail -f /root/ts-memtrial.log     # read the verdict from the log, not the tunnel
```

### 2. Tuning progression (measured)

| GOMEMLIMIT | tailscaled RSS | tailscaled PSS | CPU time / 40 s | Verdict |
| :--- | ---: | ---: | ---: | :--- |
| none (GOGC=30 only) | 44.4 MB | 43.3 MB | 7 s / 32 min | baseline |
| **40 MiB** | 39.1 MB | 38.2 MB | 0 s | −5.1 MB, healthy in 4 s |
| 32 MiB | 39.0 MB | 38.1 MB | 0 s | **no further gain** |
| **40 MiB (final)** | **38.2 MB** | **37.4 MB** | 0 s | −6.0 MB |

**Key insight:** `32MiB` bought nothing over `40MiB` because tailscaled's *live* working set is ~37–38 MB — `GOMEMLIMIT` is a soft floor-ish bound, so setting it **below** the live set just forces permanent max-effort GC (rising CPU risk under load) without shrinking RSS. Pick a value **just above** the observed live set.

```bash
# final drop-in (coexists with the GOGC=30 mem.conf; systemd merges drop-ins)
printf '[Service]\nEnvironment=GOMEMLIMIT=40MiB\n' | sudo tee /etc/systemd/system/tailscaled.service.d/gomemlimit.conf
sudo systemctl daemon-reload && sudo systemctl restart tailscaled   # prefer the guarded script
```

**After:** tailscaled **37.4 MB PSS** · total user-space PSS **105.4 MB** (−6.9 MB) · all 8 peers connected · `tailscale ping` OK · `0 failed units`.

> Note: `oci-br-pi` traffic goes via **DERP relay** both before and after — unrelated to this change.

## Session totals (all 13 changes)

| Metric | Original baseline | Final | Delta |
| :--- | ---: | ---: | ---: |
| Total User-Space PSS | 344.5 MB | **105.4 MB** | **−239.1 MB (−69%)** |
| Running services | 22 | **11** | **−11** |
| Used RAM | 361 MB | **~228 MB** (quiesced) | −133 MB |
| Available RAM | 602 MB | **~736 MB** | +134 MB |
| Swap | 0 MB | **2530 MB** | +2530 MB |

**Remaining unclaimed:** `systemd-resolved` 5.6 MB (DNS-risky), journald 13.1 MB (loses persistent logs), `systemd-udevd` 3.6 MB (breaks disk hot-plug). Everything else is load-bearing.
