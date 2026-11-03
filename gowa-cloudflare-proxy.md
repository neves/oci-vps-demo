# GOWA behind a Cloudflare proxy on OCI

This documents the current setup for `gowa.byh.dpdns.org` pointing to the GOWA VM (`129.80.228.205`). Cloudflare terminates browser HTTPS; the origin connection from Cloudflare to the VM is plain HTTP on port 80. The VM redirects port 80 to GOWA's HTTP listener on port 3000. No additional web server or proxy process is running on the VM.

> **Security:** Cloudflare Flexible mode encrypts browser-to-Cloudflare traffic only. Cloudflare-to-origin traffic is unencrypted HTTP. Basic Auth protects GOWA, but credentials and requests on the origin leg are not protected by TLS. Port 80 is currently open to all IPv4 sources, so direct requests can bypass Cloudflare. Use an origin certificate with Full (strict), or restrict the origin firewall to Cloudflare IP ranges, for stronger security.

## 1. Create a proxied Cloudflare DNS record

The active Cloudflare zone is `byh.dpdns.org`. The `cf` CLI obtains its API token and zone ID from the `mise` environment; run it with `mise exec` so these are available:

```bash
mise exec -- cf auth whoami
mise exec -- cf dns records list --zone byh.dpdns.org
```

Create a proxied A record for the hostname:

```bash
mise exec -- cf dns records create \
  --zone byh.dpdns.org \
  --body '{"type":"A","name":"gowa.byh.dpdns.org","content":"129.80.228.205","proxied":true,"ttl":1,"comment":"GOWA server proxied via Cloudflare"}'
```

A proxied record is indicated by `"proxied": true`; visitors resolve to Cloudflare edge addresses rather than directly to the VM IP.

## 2. Set Cloudflare SSL mode to Flexible

GOWA does not terminate TLS. Flexible mode lets visitors use HTTPS to Cloudflare while Cloudflare connects to the HTTP origin on port 80:

```bash
mise exec -- cf zones settings get ssl --zone byh.dpdns.org
mise exec -- cf zones settings edit ssl \
  --zone byh.dpdns.org \
  --body '{"value":"flexible"}'
mise exec -- cf zones settings get ssl --zone byh.dpdns.org
```

The setting should report `"value": "flexible"`. Flexible is a deliberate security tradeoff; do not use it when end-to-end encryption is required.

## 3. Redirect VM port 80 to GOWA port 3000

GOWA continues running as the existing `gowa.service` on port 3000. Linux iptables redirects inbound TCP port 80 to that local listener:

```bash
sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3000 2>/dev/null \
  || sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3000
sudo netfilter-persistent save
```

The `-C` test makes the command safe to repeat without adding duplicate rules. `netfilter-persistent save` persists the NAT rule across reboots. The existing host INPUT rule permits the redirected connection to GOWA's port 3000.

## 4. Update the OCI subnet security list

The VM's VNIC has no attached NSG; its subnet uses the OCI security list **Default Security List for vcn**. With OCI CLI profile `ei2`, retrieve the existing ingress rules, retain them, remove the GOWA-specific public TCP/3000 rule, and add public TCP/80:

```bash
SL=ocid1.securitylist.oc1.iad.aaaaaaaa5snjz5rir66x2klgsmmvh5holphr2igu5rolmegnist6j5novjba
TMP=$(mktemp)
oci --profile ei2 network security-list get \
  --security-list-id "$SL" \
  --query 'data."ingress-security-rules"' --output json |
python3 -c 'import json,sys
rules=json.load(sys.stdin)
def port(r):
    d=((r.get("tcp-options") or {}).get("destination-port-range") or {})
    return d.get("min"),d.get("max")
# Remove only the prior GOWA public rule for TCP/3000.
rules=[r for r in rules if not (r.get("protocol")=="6" and r.get("source")=="0.0.0.0/0" and port(r)==(3000,3000) and "GOWA REST, MCP and UI" in (r.get("description") or ""))]
if not any(r.get("protocol")=="6" and r.get("source")=="0.0.0.0/0" and port(r)==(80,80) for r in rules):
    rules.append({"description":"HTTP origin from Cloudflare proxy (GOWA)","isStateless":False,"protocol":"6","source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}})
json.dump(rules,sys.stdout)' > "$TMP"
oci --profile ei2 network security-list update \
  --security-list-id "$SL" \
  --ingress-security-rules "file://$TMP" --force
rm -f "$TMP"
```

The script submits the complete ingress-rule list, preserving unrelated rules. Review the security-list OCID and proposed changes before running it. The source is `0.0.0.0/0` so Cloudflare can reach the VM; this also permits direct origin access.

## 5. Verify

Check the proxied record and SSL mode:

```bash
mise exec -- cf dns records list --zone byh.dpdns.org --name gowa.byh.dpdns.org
mise exec -- cf zones settings get ssl --zone byh.dpdns.org
```

Check the HTTPS endpoint from a machine outside the VM:

```bash
curl -sSI https://gowa.byh.dpdns.org/
```

An HTTP `401` with `WWW-Authenticate: Basic` is expected when requesting GOWA without credentials; it confirms the request reached the authenticated application through Cloudflare. Port 3000 should no longer have a public OCI ingress rule, while port 80 does.
