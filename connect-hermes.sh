#!/usr/bin/env bash
# Create an OCI Bastion SSH session and connect interactively to hermes.
set -Eeuo pipefail

PROFILE="${OCI_PROFILE:-mneves}"
BASTION_ID="${OCI_BASTION_ID:-ocid1.bastion.oc1.sa-vinhedo-1.amaaaaaa5t3p3riazjpgffiun2gdmx3ovzliulqwuyrkyauk37fu34e2bk7q}"
INSTANCE_ID="${OCI_INSTANCE_ID:-ocid1.instance.oc1.sa-vinhedo-1.an3ggljr5t3p3rictwmgbpbc2ssre3f6x4jzrbvaxhnqhsuoldss7g7bxsfq}"
TARGET_IP="${OCI_TARGET_PRIVATE_IP:-10.0.0.210}"
REMOTE_USER="${OCI_REMOTE_USER:-ubuntu}"
TTL="${OCI_SESSION_TTL:-10800}"
PORT="${OCI_LOCAL_PORT:-2222}"
BASTION_HOST="host.bastion.sa-vinhedo-1.oci.oraclecloud.com"

for bin in oci ssh ssh-add ssh-agent python3; do
  command -v "$bin" >/dev/null || { echo "Missing required command: $bin" >&2; exit 1; }
done

PRIVATE_KEY="$HOME/.ssh/id_rsa"
[[ -f "$PRIVATE_KEY" ]] || { echo "SSH private key not found: $PRIVATE_KEY" >&2; exit 1; }

TMP_DIR=$(mktemp -d)
TUNNEL_PID=""
STARTED_AGENT=0
cleanup() {
  if [[ -n "$TUNNEL_PID" ]]; then kill "$TUNNEL_PID" 2>/dev/null || true; wait "$TUNNEL_PID" 2>/dev/null || true; fi
  if [[ "$STARTED_AGENT" == 1 && -n "${SSH_AGENT_PID:-}" ]]; then kill "$SSH_AGENT_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

# Use an isolated agent: the tunnel runs in the background and cannot prompt
# for a key passphrase. Derive the session public key from the loaded private
# key, so a stale or mismatched id_rsa.pub cannot cause Bastion auth failures.
eval "$(ssh-agent -s)" >/dev/null
STARTED_AGENT=1
ssh-add "$PRIVATE_KEY"
ssh-add -L | head -n 1 >"$TMP_DIR/id_rsa.pub"
[[ -s "$TMP_DIR/id_rsa.pub" ]] || { echo 'Could not derive the public key from id_rsa.' >&2; exit 1; }
PUBLIC_KEY="$TMP_DIR/id_rsa.pub"

# A new session is created on every run because Bastion sessions expire.
echo "Creating Bastion session for ${TARGET_IP}:22..."
oci --profile "$PROFILE" bastion session create-port-forwarding \
  --bastion-id "$BASTION_ID" \
  --display-name "hermes-ssh-$(date +%s)" \
  --target-resource-id "$INSTANCE_ID" \
  --target-private-ip "$TARGET_IP" \
  --target-port 22 \
  --ssh-public-key-file "$PUBLIC_KEY" \
  --session-ttl "$TTL" \
  --wait-for-state SUCCEEDED >"$TMP_DIR/create.json"
SESSION_ID=$(python3 - "$TMP_DIR/create.json" <<'PY'
import json, sys
obj = json.load(open(sys.argv[1]))
try:
    print(obj['data']['resources'][0]['identifier'])
except (KeyError, IndexError, TypeError):
    raise SystemExit('Could not find the created session OCID in OCI CLI response')
PY
)

ssh -i "$PRIVATE_KEY" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -N -L "127.0.0.1:${PORT}:${TARGET_IP}:22" -p 22 \
  "${SESSION_ID}@${BASTION_HOST}" >"$TMP_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!

ready=0
for _ in $(seq 1 40); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo 'Bastion tunnel exited unexpectedly:' >&2; cat "$TMP_DIR/tunnel.log" >&2; exit 1
  fi
  if python3 - "$PORT" <<'PY' >/dev/null 2>&1
import socket, sys
s=socket.socket(); s.settimeout(.3)
try: s.connect(('127.0.0.1', int(sys.argv[1])))
except OSError: raise SystemExit(1)
finally: s.close()
PY
  then ready=1; break; fi
  sleep .5
done
[[ "$ready" == 1 ]] || { echo 'Timed out waiting for Bastion tunnel.' >&2; cat "$TMP_DIR/tunnel.log" >&2; exit 1; }

echo "Bastion tunnel ready. Connecting to ${REMOTE_USER}@hermes (${TARGET_IP})..."
echo 'Press Ctrl-D (or type exit) to disconnect; the tunnel will close automatically.'
set +e
ssh -tt -i "$PRIVATE_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  -p "$PORT" "${REMOTE_USER}@127.0.0.1"
SSH_STATUS=$?
set -e
exit "$SSH_STATUS"
