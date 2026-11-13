# 🪱🕳️ Wormhole

> Ever been stuck behind a restrictive network that blocks the tools you rely on every day?

> Wormhole burrows a tunnel through the wall. Connect your devices to a Tailscale network, and blocked sites open as if the wall was never there — while everything else continues to go direct.

## 🧠 How it works

Wormhole runs [sing-box](https://sing-box.sagernet.org) on two or more nodes. Every node hijacks DNS the same way; **which** domains and CIDRs it captures, and **whether** it exits locally or hairpins to a peer, come from its profile and the client mode.

- **ru nodes** — sit inside networks that block foreign services. They FakeIP-hijack DNS for the include catalog, advertise matching CIDRs via Tailscale, exit known-good destinations locally, and forward the rest through an encrypted tunnel to a peer.
- **non-ru nodes** — sit in open networks. They receive tunnel traffic and send it out, and can hijack a smaller catalog (typically Russian services) for clients that need those from abroad.

Clients join the Tailscale network and route matching prefixes through the nearest node — no per-app configuration needed.

The setup is fully symmetric: every node runs the same configuration and can peer with any other, so you can deploy as many nodes in as many regions as you need.

## 💾 Installation

### Requirements

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html)
- Node.js on the Ansible controller (used to compose rule sets and pack client zips)
- [7-Zip](https://www.7-zip.org) (`7zz`) on the Ansible controller (AES-256 client zips)
- [sing-box](https://sing-box.sagernet.org) on the Ansible controller (compiles profile, include, and direct rule-sets)
- At least two fresh VPS instances with root access (one `ru`, one `non-ru`)

#### For automatic setup

- [fish](https://fishshell.com) 3.2+

### 1. Install dependencies (macOS only)

```fish
brew bundle
```

### 2. Configure an inventory

Each deployment is a directory under `ansible/inventories/` (gitignored). Copy the example and name it after the deployment:

```fish
cp -R ansible/inventories.example ansible/inventories/production
```

Edit `ansible/inventories/production/hosts.local.yml` and fill in your server IPs, each host's `rules.profile` (`ru` or `non-ru`), and the per-host `users:` allow list. Map people to devices in `group_vars/all/user_devices.yml`. Tailscale nodes are named `{{ tailscale.base_hostname }}-<entry>-<exit>` (default base `wormhole`), advertise the profile CIDRs, and advertise themselves as exit nodes.

### 3. Fill in secrets

Edit `ansible/inventories/production/group_vars/all/vault.yml` with a real Tailscale auth key, a strong Hysteria2 password, and per-user `vault_zip_passwords` (AES-256 zip for that person's config folder):

```fish
# Generate a password:
openssl rand -base64 32

# Get a Tailscale auth key:
# https://login.tailscale.com/admin/settings/keys
```

`vault_zip_passwords` is a map of user name → zip password, one entry per key in `user_devices`.

### 4. Run setup

```fish
fish setup.fish production
```

The inventory name is required and must match a directory under `ansible/inventories/`. This will bootstrap SSH key authentication on all nodes, encrypt your secrets, install Ansible collections, and provision everything end to end.

Playbooks probe every inventory host over SSH. If the controller cannot reach a node, they jump through another key-reachable host (shortest path, then inventory order — max two hops). You do not set `ProxyJump` in inventory. `--limit` still probes the whole inventory so a limited host can use another node as a bastion.

## ⚙️ Configuration

### Rule catalog

Named sets are paths under `rules/domain/` and `rules/cidr/` (no `.json`). The same path on both trees is one set (domains + CIDRs). A profile entry may be a file or a folder: `international` loads every international domain and CIDR, `international/social` only that subtree. Profiles `rules/profiles/ru.json` and `rules/profiles/non-ru.json` list which paths a node loads:

- `include` / `exclude` — capture catalog (FakeIP DNS + split `AllowedIPs` + GL.iNet `{entry}-{exit}.txt`)
- `direct` — subset of `include`; local-exit dest match on auto/direct client modes only
- `always_direct` — disjoint from `include`. Split clients never catch it (ISP). GL.iNet `{entry}-{exit}-always-direct.txt` keeps those dests on the ISP. DNS uses real IPs (never FakeIP). **direct** `0.0.0.0/0` unmatched stays this node. **full** (hop-policy) sniffs real-IP TLS/HTTP/QUIC and dest-matches `always_direct.srs` to this node; other unmatched still goes to the peer.

Hop is `include` minus `direct`. A host can add or drop paths:

```yaml
rules:
  profile: ru
  include: [] # extra capture paths (file or folder)
  exclude: [] # drop a path or subtree from the profile
  direct: [] # extra local-exit paths (must already be in include)
  always_direct: [] # extra ISP-only paths (must not overlap include)
```

Missing `rules.profile` fails the playbook.

**Domains** in `include` are a sing-box rule-set compiled on the Ansible controller (`profile.srs`). They FakeIP-hijack DNS. Include dest (`include.srs`: domains **or** CIDRs) hairpins to the peer. Direct dest (`direct.srs`) local-exits, but only for auto/direct clients — and **before** include, because `direct ⊂ include`. `always_direct` stays real-IP DNS; hop-policy sources sniff non-FakeIP dests and local-exit `always_direct.srs` (auto/direct are not sniffed). Edit a file under `rules/domain/ru/` or `rules/domain/international/`, then re-run the playbook.

**CIDRs** in `include` are composed at deploy time into Tailscale `advertise_routes`, split-mode WireGuard / AmneziaWG `AllowedIPs`, and dest rule-sets (orthogonal to FakeIP/domain matches). Edit a file under `rules/cidr/` (same relative path as the matching domain set when both exist), then re-run the playbook. A GitHub refresh of JSON does not update advertised routes.

Upstream CIDR lists are defined in `rules/cidr/sources.json`. Refresh the compressed JSON locally, or via the daily GitHub Action. GL.iNet `.txt` maps are local-only (`extract_rules_to_txt.mjs`). These endpoints are public; do not commit `.env` or secrets. The Node script is the source of truth; `act` checks the workflow wrapper. `--bind` keeps generated JSON on the host. Apple Silicon may need `--container-architecture linux/arm64`. Fetch needs network (`act`'s default Docker network is enough).

A set takes one `source` or merges a `sources` array. `json-ips` collects every address in a JSON document. `"widen": "rdap"` replaces each fetched address with the network it is registered under (RDAP via ARIN, which redirects to the other registries), so a feed of a few rotating addresses still yields a stable block; it refuses networks larger than IPv4 `/12` or IPv6 `/29`. Discord's voice and video servers come from its own ping list (`latency.discord.media/rtc`) this way. The widened block is Cloudflare's registered network, which also holds the CDN ranges in `international/infrastructure/cloudflare`. The overlap is intended: auto/direct clients match `direct` before `include`, so CDN traffic still exits locally and only the rest goes to the peer.

```fish
node scripts/compose_rules.mjs --profile ru
node scripts/compose_rules.mjs --self-check
node scripts/extract_rules_to_txt.mjs   # writes rules/paths/<entry>-<exit>.txt and -always-direct.txt
node scripts/update_cidr_rules.mjs
act workflow_dispatch -W .github/workflows/update-cidr-rules.yml --bind
```

Four AmneziaWG / WireGuard configs per entry-exit (`wormhole-{entry}-{exit}-{mode}.conf`). Catch (what can enter the tunnel) is independent of dest classification:

- **auto** — split catch (`include`); unmatched default is this node; dest **direct then include**
- **strict** — split catch (`include`); unmatched default is the peer; dest **include only** (no `direct.srs`). `always_direct` stays on the ISP
- **direct** — `0.0.0.0/0`; same dest and unmatched default as auto (phones; GL.iNet)
- **full** — `0.0.0.0/0`; dest **include** then unmatched peer, except sniffed `always_direct.srs` local-exits this node

auto and direct share a VPN key and IP; strict and full share another. GL.iNet catch is **not** AllowedIPs: use one **direct** tunnel (`0.0.0.0/0`, VPN DNS), load `{entry}-{exit}.txt` (include domains + CIDRs) as the VPN policy list, and `{entry}-{exit}-always-direct.txt` as ISP-only. VLESS emits only `direct` and `full` URIs.

From a client (not a mesh node), probe a site against a profile:

```fish
node scripts/check_site.mjs https://brew.sh/
node scripts/check_site.mjs --profile non-ru --json https://ozon.ru/
```

### VPN subnets

AmneziaWG and WireGuard `/24`s are computed from the inventory directory name plus each host name (`development|ru-1|awg`, …). Client tunnel IPs are hashed from `user|device|policy` (`direct` or `full`), not from the short config filename. Set reserved LAN ranges in inventory so allocated subnets never overlap them:

```yaml
all:
  vars:
    vpn_reserved_cidrs:
      - 10.0.0.0/16
```

If a host still has `awg.subnet` / `wg.subnet`, those values are kept (production can stay pinned until you delete the keys).

### FakeIP ranges

sing-box FakeIP space (`198.18.0.0/15` and `fc00::/18`) is split across the unique `rules.profile` values in that inventory's `hosts.local.yml`, not per host and not from files under `rules/profiles/`. Names are sorted, then the pools are divided into the next power of two equal CIDRs (two profiles → halves; a third profile would use `/17` and `/20`, with one slice unused). Hosts that share a profile share the slice, so adding or removing a node does not change FakeIP. Adding a **profile** does; re-import auto/strict client configs after that.

People and devices live in `group_vars/all/user_devices.yml`. Each host lists who may connect with `users:`. After render, configs are `configs/{user}/{device}/{protocol}/wormhole-{entry}-{exit}-{mode}.conf` and each person gets one AES-256 `configs/{user}.zip` (password from `vault_zip_passwords` in vault).

```yaml
# group_vars/all/user_devices.yml
user_devices:
  andrei:
    devices: [slate, macbook, ipad, iphone]

# hosts.local.yml (per host)
users: [andrei, karina]
```

### Adding a node

Add a host to that inventory's `hosts.local.yml` with its IP, peer list, `users:` allow list, and `rules.profile`, then re-run. If the new node is not reachable from the controller, the playbook jumps through an already-keyed inventory host automatically.

```fish
cd ansible
ansible-playbook -i inventories/production site.yml
```

### Updating sing-box

Pin a new version in `ansible/roles/wormhole/files/docker-compose.yml` and re-run the playbook.

### Throughput tuning

On a single-vCPU node, the userspace data path (amneziawg-go, the sing-box TUN, QUIC) is the ceiling. Set these per host in `hosts.local.yml`, or for every host in `group_vars`:

- `hysteria2.down_mbps` (default `0`, BBR) — the rate this node asks its Hysteria2 peers to send at. A non-zero value makes the peer use Brutal at that fixed rate and raises `net.core.rmem_default` to 2 MiB. With BBR, a receiver that fell behind lost 70–80% of the QUIC and the peer re-sent up to 4.6× the goodput. Brutal never backs off either, so set it per host to what this node can process under real load, not to the raw link speed. Measure with demand above the rate while AWG clients are active, e.g. a temporary SOCKS inbound on the node's sing-box pulling a fast server with several streams alongside a client download. Find the highest rate whose peer sends ≤ ~1.1× the goodput, then leave headroom below it. On single-vCPU dev nodes that ceiling was 600 both ways, while the link carried over 1.5 Gbit/s: 800 added only overhead, and 2000 collapsed throughput to 238 Mbit/s. They run 500. Upload keeps BBR.
- `awg_tcp_redirect.enabled` (default `true`) — hands AWG client TCP to a sing-box `redirect` inbound through nftables REDIRECT. It then terminates in the kernel with TSO/GRO instead of crossing the TUN packet by packet, using ~20% less CPU per bit on a single-vCPU node. UDP and DNS stay on the TUN. Set it to `false` on a host to keep TCP on the TUN too.
- `kernel_cmdline_extra` (default `[spec_rstack_overflow=off, spectre_v2=off]`) — kernel boot parameters, written to `/etc/default/grub.d` on every node. Some hosts hide the CPU features cheap mitigations need (`/sys/devices/system/cpu/vulnerabilities/spec_rstack_overflow` reports `Safe RET, no microcode`). On a single-vCPU node that fallback costs ~22% more CPU per bit and much of the upload speed. The nodes run only Wormhole's own containers, so the default trades in-guest isolation for faster kernel networking. Set `[]` on a host to keep the distribution defaults. Hosts without `update-grub` are skipped with a warning. After provisioning, the playbook reboots a node only when its kernel parameters actually change. That means a configured parameter isn't running yet, or one the playbook added earlier was removed from the list and is still running. It skips the reboot, with a warning, if GRUB's next boot wouldn't apply the change. It goes one node at a time, nodes reached through an SSH jump before the jump hosts themselves, and waits for each node's tunnel routes before moving on. Any failure stops the remaining reboots. Set `kernel_cmdline_reboot: false` to only print a reminder.

Every node also sets `net.core.rmem_default` to 2 MiB. sing-box's Hysteria2 outbound never sizes its socket, and the kernel's 208 KB overflowed on ordinary bursts.

## 🗂️ Structure

```
rules/
  profiles/
    ru.json                     # include / direct / always_direct on ru nodes
    non-ru.json                 # include / direct / always_direct on non-ru nodes
  domain/
    ru/                         # Russian services (non-ru include; ru always_direct)
    international/              # international (ru include)
      social/
  cidr/
    sources.json                # upstream fetch map for CIDR JSON
    international/              # same tree as domain/; CIDR-only sets live here too
      social/
  paths/
    {entry}-{exit}.txt                 # GL.iNet VPN catch (include domains + CIDRs)
    {entry}-{exit}-always-direct.txt   # GL.iNet ISP-only (do not send through VPN)

scripts/
  compose_rules.mjs             # profile → include/direct/hop/always_direct; writes sing-box JSON
  assign_vpn_addresses.mjs      # deterministic AWG/WG subnets, client IPs, FakeIP slices
  pack_user_configs.mjs         # AES-256 zip per user config tree
  check_site.mjs                # client-vantage miniooni probe
  extract_rules_to_txt.mjs      # flatten paths to GL.iNet include + always-direct txt
  update_cidr_rules.mjs         # fetch + compress CIDR JSON from sources.json
  discover_ssh_paths.mjs        # controller SSH path discovery (direct + jumps)

ansible/
  site.yml                      # Full provisioning playbook
  bootstrap.yml                 # One-time SSH key setup
  discover-ssh.yml              # Probe hosts and inject SSH jump args
  bootstrap-round.yml           # Password prompt + key upload (one pass)
  tasks/                        # Shared bootstrap / discover task lists
  inventories.example/          # Template — copy to inventories/<name>
    hosts.local.yml
    group_vars/all/
      user_devices.yml          # Name → devices map
      vars.yml                  # Per-deployment config
      vault.yml                 # Secrets (encrypted after setup)
  inventories/<name>/           # Live inventories (gitignored)
  local/<name>/                 # Generated artifacts
    configs/{user}/{device}/    # Client configs and per-user AES-256 zips
    keys/                       # Server and client private keys
    rulesets/{host}/            # Compiled profile / include / direct / always_direct rule-sets
  roles/wormhole/
    tasks/main.yml              # Installs Docker, TLS certs, deploys sing-box
    tasks/assign-vpn-subnets.yml # Localhost Node allocator for AWG/WG and FakeIP
    tasks/expand-vpn-users.yml  # user_devices × users → vpn_clients
    tasks/compose-rules.yml     # Localhost Node compose for this host
    tasks/reboot.yml            # Serial reboot when kernel parameters are pending
    templates/sing-box/         # Jinja2 config template
```
