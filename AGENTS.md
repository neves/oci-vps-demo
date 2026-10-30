# AGENTS.md

Repo of memory-optimization runbooks for 1 GB cloud VPSes. `gcloud-vps.md` is the live one
(Debian 13 / GCP); `oci-vps.md` is the Oracle Cloud / Ubuntu reference it was ported from.

## Remote targets

* **GCP (current):** `ssh marcos.neves@gcloud.mora-tilapia.ts.net` — host `us-east1-2vcpu-1gb-30gb`
* **OCI (reference):** see `oci-vps.md`

**The SSH session rides Tailscale.** `tailscaled` is load-bearing: anything that restarts or
reconfigures it can lock you out of the box. Same for `sshd` config and `AllowUsers`.

## Before changing anything on a remote host

1. Confirm the distro — commands from `oci-vps.md` are Ubuntu-flavoured and do **not** all apply
   to the Debian host (no `snapd`/Oracle agent; package and unit names differ).
2. Take a baseline measurement, apply one change, re-measure. Never batch blind.
3. For remote execution, pipe scripts over stdin: `cat script.sh | ssh host 'sudo bash -s'`.
   Files written to `/tmp` locally do **not** exist on the server.

## Measurement discipline

**Use PSS, not `free`'s `used` column.** Page-cache churn (especially right after `apt` runs)
moves `used` by tens of MB and looks like a regression that isn't. Trust `smaps_rollup` sums, or
`sync; echo 3 > /proc/sys/vm/drop_caches` before comparing. The measurement block at the top of
`gcloud-vps.md` is the standard one.

`swapon` is in `/sbin` and absent from the non-login `PATH` — use `sudo swapon` or `free -m`.

## Things that bite

* `polkit` is **D-Bus socket-activated**: `disable` won't hold, use `mask`.
* `apt-daily-upgrade.timer` re-spawns `unattended-upgrade`, which once ballooned to **97 MB**.
  Mask the timers, don't just kill the process.
* Kernel-module blacklisting (oci-vps.md §6) is worthless here — 69 modules total **3 MB** on the
  cloud kernel. Don't re-apply it.
* `GOMEMLIMIT` below a Go process's live heap gains no memory and adds CPU risk. Set it just
  **above** the observed live set (`tailscaled` ≈ 38 MB → `40MiB`).
* Restart `tailscaled` only via the detached `systemd-run` guard + rollback in `gcloud-vps.md`
  (Change 13), so recovery survives your own session dropping.
* Never mask `serial-getty@ttyS0` (console escape hatch) or purge `google-disk-expand` (grows the
  root FS on new instances).
* Validate sshd changes with `sudo sshd -t` before reload, and keep a second session open to
  confirm a fresh login still works.

## After any host change

Update `gcloud-vps.md` with the command, the before/after numbers, and any correction to earlier
claims in the file. It is the artifact that gets replayed on the next VPS — stale or optimistic
numbers in it are a real cost.
