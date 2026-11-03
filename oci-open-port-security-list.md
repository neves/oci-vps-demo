# Open a port in an OCI subnet security list

This documents how to add an ingress rule using OCI CLI profile `ei2`. The example opens TCP/3000 to the internet (`0.0.0.0/0`). Public ingress is broad; restrict `SOURCE_CIDR` whenever possible.

## Requirements

- OCI CLI configured with profile `ei2` in `~/.oci/config`.
- Permissions to list the instance/VNIC/subnet and update the security list.
- Python 3 for safely retaining and appending to the current rule list.

Check the profile:

```bash
oci --profile ei2 iam region list --output table
```

Make sure the configured region matches the instance's region. `--region <region>` can override it per command.

## Find the security list

Set the tenancy or compartment OCID. List instances and identify the target instance:

```bash
COMPARTMENT_ID=ocid1.tenancy.oc1..example
oci --profile ei2 compute instance list \
  --compartment-id "$COMPARTMENT_ID" --all --output table
INSTANCE_ID=ocid1.instance.oc1.iad.example
```

Find its attached VNIC and subnet:

```bash
oci --profile ei2 compute vnic-attachment list \
  --compartment-id "$COMPARTMENT_ID" --instance-id "$INSTANCE_ID" --all \
  --query 'data[].{"vnic":"vnic-id","subnet":"subnet-id"}' --output json

VNIC_ID=ocid1.vnic.oc1.iad.example
oci --profile ei2 network vnic get --vnic-id "$VNIC_ID" \
  --query 'data.{nsg:"nsg-ids",subnet:"subnet-id"}' --output json
```

If the VNIC has NSGs, check their ingress rules as well. Then get the subnet's security-list OCIDs:

```bash
SUBNET_ID=ocid1.subnet.oc1.iad.example
oci --profile ei2 network subnet get --subnet-id "$SUBNET_ID" \
  --query 'data.{security:"security-list-ids",vcn:"vcn-id"}' --output json
SECURITY_LIST_ID=ocid1.securitylist.oc1.iad.example
```

## Add the ingress rule

The update API takes the full ingress-rule list. Fetch the current list, append the desired rule, and submit the complete list so existing rules remain intact. The following command avoids duplicating an identical TCP port/source rule:

```bash
PORT=3000
SOURCE_CIDR=0.0.0.0/0
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

oci --profile ei2 network security-list get \
  --security-list-id "$SECURITY_LIST_ID" \
  --query 'data."ingress-security-rules"' --output json |
PORT="$PORT" SOURCE_CIDR="$SOURCE_CIDR" python3 -c 'import json, os, sys
rules = json.load(sys.stdin)
p, source = int(os.environ["PORT"]), os.environ["SOURCE_CIDR"]
def same(r):
    d = ((r.get("tcp-options") or {}).get("destination-port-range") or {})
    return r.get("protocol") == "6" and r.get("source") == source and d.get("min") == p and d.get("max") == p
if not any(same(r) for r in rules):
    rules.append({"description": f"TCP {p} ingress", "isStateless": False,
                  "protocol": "6", "source": source, "sourceType": "CIDR_BLOCK",
                  "tcpOptions": {"destinationPortRange": {"min": p, "max": p}}})
json.dump(rules, sys.stdout)' > "$TMP"

oci --profile ei2 network security-list update \
  --security-list-id "$SECURITY_LIST_ID" \
  --ingress-security-rules "file://$TMP" --force --output table
```

Review the security-list OCID, port, and source range before updating. `--force` bypasses the interactive confirmation prompt.

## Verify

Inspect the rules after updating:

```bash
oci --profile ei2 network security-list get \
  --security-list-id "$SECURITY_LIST_ID" \
  --query 'data."ingress-security-rules"' --output json
```

A security-list rule may not be sufficient by itself. Check VNIC NSGs and the instance OS firewall, make sure the application is listening on the port, and test from outside the VCN.

## Applied for GOWA

For the VM `whatsapp` (`129.80.228.205`), the subnet's **Default Security List for vcn** was updated with TCP/3000 from `0.0.0.0/0`. The rule description is `GOWA REST, MCP and UI (public; Basic Auth protected)`. Existing ingress rules were retained.

The VM firewall also rejected the port, so an allow rule was added and saved persistently:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```
