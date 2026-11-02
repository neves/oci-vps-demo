# OCI VPS inventory

Observed 2026-11-02. Memory values are snapshots and will vary with workload. No credentials or private keys belong here.

## `ubuntu@150.136.110.75`

- Hostname: `ubuntu`
- OS: Ubuntu 26.04.1 LTS
- Kernel: `7.0.0-1015-oracle`
- RAM: 951 MiB total; about 767 MiB available at inspection
- Swap: 2 GiB disk swapfile (priority 10) + 475.7 MiB ZRAM (priority 100)
- ZRAM: available and running with `zstd`
- SSH: active; `MaxStartups 2:50:4`, `LoginGraceTime 15`; accepts `LANG`, not arbitrary `LC_*`
- mise: `2026.10.25`; requested tool set installed for the `ubuntu` user
- Notes: stale invalid Oracle Cloud Agent sudoers drop-in removed; locale warning fixed by generating `en_US.UTF-8` and restricting forwarded SSH environment.

## `ubuntu@129.213.78.0` (`vnic2`)

- OS: Ubuntu 24.04.4 LTS
- Kernel: `6.17.0-1018-oracle`
- RAM: 954 MiB total; about 770 MiB available at inspection
- Swap: 2 GiB disk swapfile (priority 10)
- ZRAM: unavailable with the running kernel; kernel config enables it as a module (`CONFIG_ZRAM=m`), but `zram.ko` is absent from `/lib/modules/6.17.0-1018-oracle`. The setup script leaves ZRAM disabled and uses disk swap.
- SSH: active; `MaxStartups 2:50:4`, `LoginGraceTime 15`; currently accepts `LC_*` as well as `LANG` (the updated script removes the `LC_*` wildcard on rerun).
- mise: `2026.10.25`; requested tool set installed for the `ubuntu` user
- Notes: stale Oracle Cloud Agent sudoers drop-in removed; locale `en_US.UTF-8` generated. The remaining OCA VSS sudoers drop-in reports unused-alias warnings under `visudo -c` but parses successfully.

## Shared setup

Both hosts have the apt utility set and mise-managed tools from `oci-vps-optimize.sh`, including Node, Bun, Python, uv, HTTPie, gcloud, GitHub CLI, OCI CLI, `cf`, pi, and terminal utilities. `libatomic1` is installed for Node's runtime dependency. `eza` has been added to the script since the last run and is not yet verified on either host. Tailscale was not modified. SSH, `sshd -t`, and fresh logins were validated after the setup runs.
