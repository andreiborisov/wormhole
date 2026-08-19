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
- [sing-box](https://sing-box.sagernet.org) on the Ansible controller (compiles the profile rule-set)
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

- `include` / `exclude` — capture catalog (FakeIP + split `AllowedIPs`)
- `direct` — subset of `include`; local-exit under auto/direct client modes; GL.iNet `{entry}-{exit}-direct.txt`
- `always_direct` — never captured by split clients or GL.iNet (ISP). Disjoint from `include`. If a `0.0.0.0/0` phone still delivers the packet, the node exits it locally.

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

**Domains** in `include` are a sing-box rule-set compiled on the Ansible controller and copied onto the node (`type: local`). They FakeIP-hijack DNS. Hop and `always_direct` compile to additional rule-sets used for routing. Edit a file under `rules/domain/ru/` or `rules/domain/international/`, then re-run the playbook.

**CIDRs** in `include` are composed at deploy time into Tailscale `advertise_routes` and split-mode WireGuard / AmneziaWG `AllowedIPs`. Hop CIDRs also go into the hop rule-set. Edit a file under `rules/cidr/` (same relative path as the matching domain set when both exist), then re-run the playbook. A GitHub refresh of JSON does not update advertised routes.

Upstream CIDR lists are defined in `rules/cidr/sources.json`. Refresh the compressed JSON locally, or via the daily GitHub Action. GL.iNet `.txt` maps are local-only (`extract_rules_to_txt.mjs`). These endpoints are public; do not commit `.env` or secrets. The Node script is the source of truth; `act` checks the workflow wrapper. `--bind` keeps generated JSON on the host. Apple Silicon may need `--container-architecture linux/arm64`. Fetch needs network (`act`'s default Docker network is enough).

```fish
node scripts/compose_rules.mjs --profile ru
node scripts/compose_rules.mjs --self-check
node scripts/extract_rules_to_txt.mjs   # writes rules/paths/<entry>-<exit>-{direct,full}.txt
node scripts/update_cidr_rules.mjs
act workflow_dispatch -W .github/workflows/update-cidr-rules.yml --bind
```

Four AmneziaWG / WireGuard configs per entry-exit (`wormhole-{entry}-{exit}-{mode}.conf`):

- **auto** — split catch (`include`); remainder exits this node; hop set goes to the peer
- **strict** — split catch (`include`); remainder goes to the peer (`always_direct` still exits this node if it arrives)
- **direct** — `0.0.0.0/0`; same remainder policy as auto (phones that do not trust the ISP; GL.iNet ru-default tunnel)
- **full** — `0.0.0.0/0`; same remainder policy as strict (foreign default; GL.iNet hop tunnel)

auto and direct share a VPN key and IP; strict and full share another. GL.iNet does not send DNS through the tunnel: load `{entry}-{exit}-direct.txt` on the direct tunnel and `{entry}-{exit}-full.txt` on the full tunnel. `always_direct` is omitted from both files so the router leaves those dests on the ISP. VLESS emits only `direct` and `full` URIs.

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
    {entry}-{exit}-direct.txt   # GL.iNet catch for the ru-default tunnel
    {entry}-{exit}-full.txt     # GL.iNet catch for the hop-default tunnel

scripts/
  compose_rules.mjs             # profile → include/direct/hop/always_direct; writes sing-box JSON
  assign_vpn_addresses.mjs      # deterministic AWG/WG subnets, client IPs, FakeIP slices
  pack_user_configs.mjs         # AES-256 zip per user config tree
  check_site.mjs                # client-vantage miniooni probe
  extract_rules_to_txt.mjs      # flatten paths to GL.iNet -direct.txt and -full.txt
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
    rulesets/{host}/            # Compiled include / hop / always_direct rule-sets
  roles/wormhole/
    tasks/main.yml              # Installs Docker, TLS certs, deploys sing-box
    tasks/assign-vpn-subnets.yml # Localhost Node allocator for AWG/WG and FakeIP
    tasks/expand-vpn-users.yml  # user_devices × users → vpn_clients
    tasks/compose-rules.yml     # Localhost Node compose for this host
    templates/sing-box/         # Jinja2 config template
```
