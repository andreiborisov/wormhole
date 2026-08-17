# 🪱🕳️ Wormhole

> Ever been stuck behind a restrictive network that blocks the tools you rely on every day?

> Wormhole burrows a tunnel through the wall. Connect your devices to a Tailscale network, and blocked sites open as if the wall was never there — while everything else continues to go direct.

## 🧠 How it works

Wormhole runs [sing-box](https://sing-box.sagernet.org) on two or more nodes. Every node hijacks DNS and hairpins matching traffic the same way; only **which** domains and CIDRs it owns comes from its profile.

- **ru nodes** — sit inside networks that block foreign services. They FakeIP-hijack DNS for selected domain sets, advertise matching CIDRs via Tailscale, and forward that traffic through an encrypted tunnel to a peer.
- **non-ru nodes** — sit in open networks. They receive tunnel traffic and send it out, and can hijack a smaller catalog (typically Russian services) for clients that need those from abroad.

Clients join the Tailscale network and route matching prefixes through the nearest node — no per-app configuration needed.

The setup is fully symmetric: every node runs the same configuration and can peer with any other, so you can deploy as many nodes in as many regions as you need.

## 💾 Installation

### Requirements

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html)
- Node.js on the Ansible controller (used to compose rule sets at deploy time)
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

Edit `ansible/inventories/production/hosts.local.yml` and fill in your server IPs, Tailscale hostnames, GitHub raw URL for rules, and each host's `rules.profile` (`ru` or `non-ru`).

### 3. Fill in secrets

Edit `ansible/inventories/production/group_vars/all/vault.yml` with a real Tailscale auth key and a strong Hysteria2 password:

```fish
# Generate a password:
openssl rand -base64 32

# Get a Tailscale auth key:
# https://login.tailscale.com/admin/settings/keys
```

### 4. Run setup

```fish
fish setup.fish production
```

The inventory name is required and must match a directory under `ansible/inventories/`. This will bootstrap SSH key authentication on all nodes, encrypt your secrets, install Ansible collections, and provision everything end to end.

## ⚙️ Configuration

### Rule catalog

Named sets are paths under `rules/domain/` and `rules/cidr/` (no `.json`). The same path on both trees is one set (domains + CIDRs). A profile entry may be a file or a folder: `international` loads every international domain and CIDR, `international/social` only that subtree. Profiles `rules/profiles/ru.json` and `rules/profiles/non-ru.json` list which paths a node loads. A host can add or drop paths:

```yaml
rules:
  profile: ru
  include: [] # extra paths (file or folder)
  exclude: [] # drop a path or subtree from the profile
```

Missing `rules.profile` fails the playbook.

**Domains** are sing-box remote rule-sets (`update_interval: 5m`) and only affect FakeIP DNS. Edit a file under `rules/domain/ru/` or `rules/domain/international/`, commit, and push — nodes pick the change up on the next refresh.

**CIDRs** are composed at deploy time into Tailscale `advertise_routes` and WireGuard / AmneziaWG `AllowedIPs`. Edit a file under `rules/cidr/` (same relative path as the matching domain set when both exist), then re-run the playbook. A GitHub refresh of JSON does not update advertised routes.

```fish
node scripts/compose_rules.mjs --profile ru
node scripts/extract_rules_to_txt.mjs   # writes rules/profiles/ru.txt and non-ru.txt
```

From a client (not a mesh node), probe a site against a profile:

```fish
node scripts/check_site.mjs https://brew.sh/
node scripts/check_site.mjs --profile non-ru --json https://ozon.ru/
```

### Adding a node

Add a host to that inventory's `hosts.local.yml` with its IP, Tailscale hostname, peer list, and `rules.profile`, then re-run:

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
    ru.json                     # paths loaded on ru nodes
    non-ru.json                 # paths loaded on non-ru nodes
  domain/
    ru/                         # Russian services (non-ru profile)
    international/              # international (ru profile)
      social/
  cidr/
    international/              # same tree as domain/; CIDR-only sets live here too
      social/

scripts/
  compose_rules.mjs             # profile → domain sets + CIDR union
  check_site.mjs                # client-vantage miniooni probe
  extract_rules_to_txt.mjs      # flatten profiles to .txt

ansible/
  site.yml                      # Full provisioning playbook
  bootstrap.yml                 # One-time SSH key setup
  inventories.example/          # Template — copy to inventories/<name>
    hosts.local.yml
    group_vars/all/
      vars.yml                  # Per-deployment config
      vault.yml                 # Secrets (encrypted after setup)
  inventories/<name>/           # Live inventories (gitignored)
  local/<name>/                 # Generated keys and client configs
  roles/wormhole/
    tasks/main.yml              # Installs Docker, TLS certs, deploys sing-box
    tasks/compose-rules.yml     # Localhost Node compose for this host
    templates/sing-box/         # Jinja2 config template
```
