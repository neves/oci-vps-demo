# OCI MySQL public Network Load Balancers

Findings from checking the five profiles in `~/.oci/config` with the OCI CLI. This records observed configuration; it does not change any OCI resources.

## Matches

| Profile | NLB | State | Public IP | Private IP | Listener | Backend | Health check |
|---|---|---|---|---|---|---|---|
| `raise` | `mysql-public-nlb` | ACTIVE | `132.145.203.252` | `10.0.0.161` | `mysql_3306`, TCP :3306 | `10.0.0.185:3306` | TCP :3306 |
| `atos6` | `network-load-balancer` | ACTIVE | `150.136.231.185` | `10.0.0.123` | `listener`, TCP_AND_UDP :0 | `10.0.0.130` (backend port 0) | TCP :3306 |

The DB backends are MySQL DB Systems: `raise`'s DB System is `MySql`; `atos6`'s is `mysql`.

## Other profiles checked

No NLBs were found in the tenancy/root compartments for `neves`, `ei`, or `ei2`. The compartment enumeration for `ei2` did not complete successfully in the cross-profile scan, so this is a root-compartment finding, not a claim that every nested compartment was verified.

## How to find them

The OCI CLI service namespace for Network Load Balancers is `oci nlb` (not `oci network nlb`). List NLBs in a tenancy/root compartment with:

```bash
oci --profile PROFILE nlb network-load-balancer list \
  --compartment-id TENANCY_OCID --all --output json
```

The result is under `data.items` (not `data[]`). Inspect each NLB's `display-name`, `lifecycle-state`, `ip-addresses`, `listeners`, and `backend-sets`. Those include the public/private IPs, listener protocol/port, backend IP/port, and health-check settings.

If an NLB may be in a child compartment, enumerate accessible compartments and run the list command for each:

```bash
oci --profile PROFILE iam compartment list \
  --compartment-id TENANCY_OCID \
  --compartment-id-in-subtree true \
  --access-level ACCESSIBLE --all \
  --query 'data[].id' --output json
```

Check the regular OCI Load Balancer service separately with `oci lb load-balancer list`; it is distinct from the NLB service.

## Security observation

The `atos6` NLB's subnet security list was observed with a TCP ingress rule from `0.0.0.0/0` and no port range, so it permits TCP ingress broadly. This was not modified during the NLB discovery. Review listener/backend exposure and narrow ingress to required ports and source IPs where possible.
