# 🪱🕳️ Wormhole

> Ever been stuck behind a restrictive network that blocks the tools you rely on every day?

> Wormhole burrows a tunnel through the wall. Connect your devices to a Tailscale network, and blocked sites open as if the wall was never there — while everything else continues to go direct.

## 🧠 How it works

Wormhole runs [sing-box](https://sing-box.sagernet.org) on two or more nodes, with [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-go) providing the encrypted, obfuscated transport between them:

- **Restricted nodes** — sit inside censored networks. They intercept DNS, return fake IPs for proxied domains, and forward matching traffic to their peers over an AmneziaWG tunnel that resists deep packet inspection.
- **Unrestricted nodes** — sit in open networks. They receive tunnel traffic and send it out to the internet.

Clients connect to the Tailscale network and route through the nearest restricted node transparently — no per-app configuration needed.

The setup is fully symmetric: every node runs the same configuration and can peer with any other, so you can deploy as many nodes in as many regions as you need.

## 💾 Installation

### Requirements

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html)
- At least two fresh VPS instances with root access (one restricted, one unrestricted)

#### For automatic setup

- [fish](https://fishshell.com) 3.2+

### 1. Install dependencies (macOS only)

```fish
brew bundle
```

### 2. Configure your inventory

```fish
cp ansible/inventory/hosts.local.yml.example ansible/inventory/hosts.local.yml
```

Edit `hosts.local.yml` and fill in your server IPs, Tailscale hostnames, and the GitHub raw URL for your rules.

### 3. Fill in secrets

Edit `ansible/inventory/group_vars/all/vault.yml` with a real Tailscale auth key and a strong AmneziaWG pre-shared key:

```yaml
vault_tailscale_auth_key: "tskey-auth-..."
vault_awg_psk: "<output of: docker run --rm amneziavpn/amneziawg-go:latest awg genpsk>"
```

```fish
# Get a Tailscale auth key:
# https://login.tailscale.com/admin/settings/keys
```

### 4. Run setup

```fish
fish setup.fish
```

This will bootstrap SSH key authentication on all nodes, encrypt your secrets, install Ansible collections, and provision everything end to end.

## ⚙️ Configuration

### Adding a domain to proxy

Edit `rules/restricted.json` and add the domain suffix:

```json
{
  "version": 4,
  "rules": [{ "domain_suffix": ["example.com"] }]
}
```

Then commit and push — nodes refresh the rule set from GitHub every 15 minutes automatically.

### Adding a node

Add a new host to `hosts.local.yml` with its IP, Tailscale hostname, peer list, and `restricted` flag, then re-run:

```fish
ansible-playbook ansible/site.yml
```

### Updating sing-box

Pin a new version in `ansible/roles/wormhole/files/docker-compose.yml` and re-run the playbook.

## 🗂️ Structure

```
rules/                          # Remote rule sets (hosted on GitHub)
  restricted.json               # Domains proxied on restricted nodes
  unrestricted.json             # Domains proxied on unrestricted nodes

ansible/
  site.yml                      # Full provisioning playbook
  bootstrap.yml                 # One-time SSH key setup
  inventory/
    hosts.local.yml.example     # Template — copy and fill in
    group_vars/all/
      vars.yml                  # Shared config
      vault.yml                 # Encrypted secrets
  roles/wormhole/
    tasks/main.yml              # Installs Docker, generates AWG keys, deploys services
    templates/sing-box/         # Jinja2 config template for sing-box
    templates/awg/              # Jinja2 templates for AmneziaWG config and start script
    files/docker-compose.yml    # Container definitions (sing-box + amneziawg)
    files/awg/Dockerfile        # AmneziaWG container image
```
