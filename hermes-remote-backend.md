# Hermes on an OCI VPS: Tailscale + Remote Desktop Backend

Runbook distilled from setting up the `hermes` OCI VM so Hermes Desktop on a Mac uses the VPS as its backend. The Mac runs only the client; agent sessions, tools, credentials, and files stay on the VPS.

> **Do not store passwords, API keys, or Telegram bot tokens in this file.** Use a private secret prompt or a secure password manager. The current backend password is stored on the VPS only as a scrypt hash.

## Current host facts

| Item | Current value |
|---|---|
| OCI profile | `mneves` |
| Region | `sa-vinhedo-1` (Vinhedo) |
| Instance | `hermes`, Ubuntu 26.04.1 LTS, 1 GiB RAM |
| Private IPv4 | `10.0.0.210` |
| Current ephemeral public IPv4 | `167.126.13.243` — may change; use Tailscale for the backend |
| Tailscale MagicDNS | `hermes.mora-tilapia.ts.net` |
| Tailscale IPv4 observed | `100.67.245.7` — re-check after reinstall/re-enrollment |
| Remote Hermes Desktop URL | `http://hermes.mora-tilapia.ts.net:9119` |
| Backend unit | `hermes-serve.service` (system scope, enabled at boot) |
| Messaging unit | `hermes-gateway.service` (separate user-scope service) |

## Architecture: do not confuse the two Hermes processes

- **`hermes serve`** is the remote HTTP/WebSocket backend used by Hermes Desktop. It listens on port `9119` on the Tailscale interface.
- **`hermes gateway`** is the separate always-on messaging process (Telegram, Discord, etc.). It is not the Desktop remote backend.
- For a Mac acting as a “dumb client,” choose **Settings → Gateways → Remote gateway** and connect to `http://hermes.mora-tilapia.ts.net:9119`. Do not choose the SSH connection mode.
- The remote backend can execute agent tools and access VPS files/credentials. Keep it on the tailnet and require authentication.

## 1. Install and join Tailscale

Confirm the distro before installing:

```bash
cat /etc/os-release
```

Install using Tailscale’s official installer:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

Join the server to the intended tailnet and approve the login URL printed by:

```bash
sudo tailscale up
```

Check that it is online and resolve its MagicDNS name:

```bash
sudo tailscale status
sudo tailscale ip -4
getent ahostsv4 hermes.mora-tilapia.ts.net
```

The backend service binds to the Tailscale IPv4 only, not `0.0.0.0`. No OCI ingress rule is needed for port `9119`; traffic is encrypted inside Tailscale. The Mac must also be signed into the same tailnet, and tailnet ACLs must allow it to reach the server on TCP/9119.

## 2. Prepare backend authentication

For a private tailnet, Hermes Basic Auth is suitable. For a backend reachable over the public Internet, use HTTPS and OAuth/another identity provider instead; do not expose a Basic-auth-only HTTP endpoint publicly.

Choose a unique password of at least 16 characters. Generate a scrypt hash interactively so the plaintext is not written into shell history:

```bash
python3 - <<'PY'
import base64, getpass, hashlib, secrets
password = getpass.getpass("Hermes Desktop backend password: ").encode()
if len(password) < 16:
    raise SystemExit("Use at least 16 characters")
salt = secrets.token_bytes(16)
digest = hashlib.scrypt(password, salt=salt, n=2**14, r=8, p=1, dklen=32, maxmem=0)
print("scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode())
PY
```

Store the generated hash and the settings below in `/home/ubuntu/.hermes/remote-backend.env`, owned by `ubuntu`, mode `600`. Keep the password hash (not the plaintext) in the file:

```dotenv
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hermes-desktop
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=<scrypt-hash-from-command>
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<unique-random-hex-secret>
HERMES_DASHBOARD_PUBLIC_URL=http://hermes.mora-tilapia.ts.net:9119
```

Generate the stable signing secret locally on the VPS with `openssl rand -hex 32`. Set file permissions:

```bash
chmod 600 /home/ubuntu/.hermes/remote-backend.env
chown ubuntu:ubuntu /home/ubuntu/.hermes/remote-backend.env
```

The exact `HERMES_DASHBOARD_PUBLIC_URL` matters. It declares the trusted Host/Origin hostname. Without it, a request using the MagicDNS hostname can fail with:

```text
Invalid Host header. Dashboard requests must use the bound hostname or the configured public hostname.
```

Keep the scheme, hostname, and port consistent with the URL entered in Desktop.

## 3. Run `hermes serve` as a boot-time service

`hermes serve` has `run/status/stop` options but no dedicated `install` command. The messaging command `hermes gateway install` installs only the messaging service. Manage the remote backend separately with a system-level unit. Example (`TAIL_IP` must be the current value from `tailscale ip -4`):

```ini
# /etc/systemd/system/hermes-serve.service
[Unit]
Description=Hermes Remote Desktop Backend
After=network-online.target tailscaled.service
Wants=network-online.target
Requires=tailscaled.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/.hermes
Environment=HOME=/home/ubuntu
Environment=HERMES_HOME=/home/ubuntu/.hermes
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/home/ubuntu/.hermes/remote-backend.env
ExecStart=/home/ubuntu/.hermes/hermes-agent/.hermes/bin/hermes serve --host <TAIL_IP> --port 9119
Restart=on-failure
RestartSec=10
TimeoutStartSec=90

[Install]
WantedBy=multi-user.target
```

Enable/start and verify:

```bash
sudo systemd-analyze verify /etc/systemd/system/hermes-serve.service
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-serve.service
systemctl status hermes-serve.service --no-pager
sudo ss -lntp | grep 9119
```

The listener should be on the Tailscale IP only, e.g. `100.67.245.7:9119`. On this instance the service took about 15–30 seconds to finish startup; a brief absence of a listener immediately after `systemctl start` was not a failure. Check logs:

```bash
journalctl -u hermes-serve.service -n 50 --no-pager
```

## 4. Validate backend/auth and connect Hermes Desktop

From the VPS, `/api/status` should report `auth_required: true` and `auth_providers: ["basic"]`:

```bash
curl -fsS http://<TAIL_IP>:9119/api/status
```

For the hostname Host-header check:

```bash
curl -fsS -H 'Host: hermes.mora-tilapia.ts.net:9119' \
  http://<TAIL_IP>:9119/api/status
```

In Hermes Desktop on the Mac:

1. Ensure Tailscale is connected to the same tailnet.
2. Open **Settings → Gateways → Remote gateway**.
3. Set URL to `http://hermes.mora-tilapia.ts.net:9119` (use **HTTP**, not HTTPS; Tailscale encrypts the transport).
4. Sign in with username `hermes-desktop` and the password chosen during setup.

A TLS attempt against this plain-HTTP listener produces `Invalid HTTP request received` in the VPS logs. A MagicDNS request without the configured `HERMES_DASHBOARD_PUBLIC_URL` produces the Host-header error above. If the hostname keeps failing, test using `http://<TAIL_IP>:9119` to distinguish DNS/Host config from Tailscale reachability.

## 5. Gateway user-service recovery and install

If `hermes gateway install` reports a missing user D-Bus/session bus, check whether `user@<uid>.service` was masked by a memory optimization. This instance has UID `1001`, and the earlier mask caused `systemctl --user` to fail even though linger was enabled.

Restore the user manager, then use Hermes’s installer rather than hand-writing its gateway unit:

```bash
sudo systemctl unmask user@.service user@1001.service
sudo systemctl start user@1001.service
sudo loginctl enable-linger ubuntu

export XDG_RUNTIME_DIR=/run/user/1001
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus
export HOME=/home/ubuntu HERMES_HOME=/home/ubuntu/.hermes
export PATH=/home/ubuntu/.local/bin:$PATH
hermes gateway install --start-now --start-on-login
```

Use `--force` only when intentionally replacing an existing service unit. The official installer confirmed the existing unit, enabled linger, and started it. Linger itself is only a policy; the persistent user manager was measured at about **8 MiB PSS** here (roughly 6.3 MiB for `systemd --user` plus 2 MiB for `sd-pam`).

Telegram setup is separate. At inspection, the gateway was running but logged **“No messaging platforms enabled.”** Configure a bot with `hermes gateway setup` and provide its token directly to the CLI/dashboard; never put bot tokens in this runbook.

## 6. Memory and security observations

These are snapshots, not guarantees; Hermes workload changes memory substantially. Measure PSS with `smaps_rollup`, not `free`’s `used` column alone.

| Snapshot | Total user-space PSS | Notable process PSS | Available RAM |
|---|---:|---|---:|
| Before `hermes serve` backend setup | ~234 MiB | Hermes gateway ~130 MiB; `tailscaled` ~34 MiB | ~562 MiB |
| After backend startup | ~393–398 MiB | `hermes serve` ~211–213 MiB; gateway ~78–83 MiB; `tailscaled` ~33–35 MiB | ~402–414 MiB |

The additional `hermes serve` backend is sizable on a 1 GiB VPS; monitor memory/swap and reduce other work if pressure grows. Do not assume the gateway and backend are one process.

Other access facts:

- SSH through Bastion works with a fresh time-limited session; the OCI Bastion itself is reused. The Mac uses `~/.ssh/id_rsa` for the admin SSH connection.
- The direct OCI public IPv4 `167.126.13.243` is **ephemeral**. Tailscale MagicDNS is the stable backend address.
- The OCI subnet’s observed security list allowed TCP/22 from `0.0.0.0/0`; restrict SSH ingress to trusted source IPs if continuing to use direct public SSH. Port 9119 should remain Tailscale-only.
- No API key, Telegram token, Basic Auth password, or private key belongs in this Markdown file.
