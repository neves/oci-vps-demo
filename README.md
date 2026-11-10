# oci-vps

Runbooks for squeezing RAM out of **1 GB cloud VPSes**. Two hand-optimized guides, each with
before/after memory measurements for every change, so they can be replayed on a fresh instance
of the same shape.

## Contents

| File | Target | What it is |
| :--- | :--- | :--- |
| [`oci-vps.md`](oci-vps.md) | Oracle Cloud 1 GB · **Ubuntu** | The original reference guide: ~408 MB → ~205 MB used, 22 → 11 services, +2.5 GB tiered swap. |
| [`gcloud-vps.md`](gcloud-vps.md) | Google Cloud `e2-micro` 1 GB · **Debian 13** | The applied port — 13 numbered changes, each with measured deltas. The one to run on a GCP box. |
| [`hermes-remote-backend.md`](hermes-remote-backend.md) | OCI `hermes` · **Ubuntu** | Tailscale-only Hermes Desktop backend, auth, systemd service, gateway setup, and memory/security notes. |

## Results on the GCP instance (`us-east1-2vcpu-1gb-30gb`, `e2-micro`)

| Metric | Baseline | Final | Delta |
| :--- | ---: | ---: | ---: |
| Total user-space PSS | 344.5 MB | **105.4 MB** | **−239 MB (−69%)** |
| Running services | 22 | **11** | −11 |
| Used RAM | 361 MB | ~228 MB (quiesced) | −133 MB |
| Available RAM | 602 MB | ~736 MB | +134 MB |
| Swap | 0 MB | **2530 MB** (482 MB ZRAM + 2 GB disk) | +2530 MB |

## How to use

1. Read `gcloud-vps.md` end to end before running anything — several steps are **conditional on
   the distro and on how you log in**.
2. Take a baseline with the measurement block at the top of the file.
3. Apply changes in order. Re-measure after each one.
4. `AllowUsers` in the sshd step and the `user@NNNN` instance in the user-manager step must be
   edited to match the target box — both are hardcoded to what was on this host.

## What actually moved the needle

* **Cloud vendor agent stack** — one change, −168 MB PSS. By far the biggest win on both images
  (Oracle Cloud Agent on OCI, Google guest agent + OSConfig on GCP).
* **`apt-daily-upgrade.timer`** — `unattended-upgrade` ballooned to **97 MB**. Masking the timers
  keeps that spike from coming back; this is protection, not a steady-state saving.
* Small daemons that are redundant on a headless single-disk VM: `exim4` (−18 MB),
  `networkd-dispatcher` (−17 MB), `haveged` (−4 MB), `rsyslog` (−3 MB), `polkit` (−5 MB).
* **`GOMEMLIMIT=40MiB` on `tailscaled`** (−6 MB) — see the tuning section; picking a value below
  the live heap buys nothing but CPU risk.

## Gotchas learned the hard way

These are what separate a working VPS from an unreachable one.

* **`free`'s `used` column lies.** Page-cache churn from `apt` I/O swung it by ~30 MB and briefly
  looked like a regression. **Measure PSS** (`smaps_rollup`), or `drop_caches` before comparing.
* **`systemctl disable polkit` does not stop polkit.** It is D-Bus socket-activated and came back
  on its own. Use `mask`.
* **Kernel-module blacklisting does not transfer.** `oci-vps.md` claims ~8 MB from blacklisting
  Wi-Fi/iSCSI/sound modules; on the GCP `deb13-cloud` kernel **all 69 loaded modules total 3 MB**.
  Skip that section on a minimal cloud kernel.
* **If you SSH over Tailscale, `tailscaled` is your lifeline.** Restarting it unguarded kills your
  own session *and* the rollback logic with it. The runbook has a `systemd-run` detached
  health-check-and-revert pattern — use it for anything touching the tunnel.
* **`swapon` lives in `/sbin`**, which is not on the default non-login `PATH`.
* **Fresh `deb13-cloud` images ship without the `locales` package**, so a client sending `LC_ALL`
  triggers a `setlocale` warning on every login. Fix is Change 11.
* **Don't purge `google-disk-expand`** — it is what grows the root filesystem on a new instance.
* **Keep `serial-getty@ttyS0`** for console recovery if you lock yourself out. `getty@tty1` is safe
  to mask; the serial one is your escape hatch.

## Honest leftovers

Not worth the risk: `systemd-resolved` (5.6 MB, breaks DNS if the replacement `resolv.conf` is
wrong), `systemd-journald` (13 MB, costs persistent logs), `systemd-udevd` (3.6 MB, breaks GCP
disk hot-plug). Everything else running is load-bearing.
