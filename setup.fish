#!/usr/bin/env fish

set -l red (set_color red)
set -l yellow (set_color yellow)
set -l green (set_color green)
set -l bold (set_color --bold)
set -l reset (set_color normal)

function info
    echo "$bold==>$reset $argv"
end

function warn
    echo "$yellow warning:$reset $argv"
end

function die
    echo "$red error:$reset $argv" >&2
    exit 1
end

# ── Prerequisites ──────────────────────────────────────────────────────────────

if not command -q ansible-playbook
    info "Installing dependencies via Homebrew..."
    brew bundle
    or die "brew bundle failed"
end

# ── Inventory ──────────────────────────────────────────────────────────────────

if not test -f ansible/inventory/hosts.local.yml
    warn "ansible/inventory/hosts.local.yml not found."
    echo "      Copy the example and fill in your details:"
    echo ""
    echo "        cp ansible/inventory/hosts.local.yml.example ansible/inventory/hosts.local.yml"
    echo "        \$EDITOR ansible/inventory/hosts.local.yml"
    echo ""
    die "create hosts.local.yml before continuing"
end

# ── Vault password ─────────────────────────────────────────────────────────────

if not test -f .vault-password
    warn ".vault-password not found."
    read -P "      Enter a vault password to create it: " -s vault_pass
    echo ""
    echo $vault_pass > .vault-password
    chmod 600 .vault-password
    echo "$green      created$reset .vault-password"
end

# ── Vault secrets ──────────────────────────────────────────────────────────────

# Check if vault.yml is still plaintext (unencrypted files don't start with $ANSIBLE_VAULT)
if not grep -q '^\$ANSIBLE_VAULT' ansible/inventory/group_vars/all/vault.yml
    warn "ansible/inventory/group_vars/all/vault.yml is not encrypted."
    echo "      Edit it to fill in real secrets, then it will be encrypted automatically."
    echo ""

    read -P "      Open vault.yml in \$EDITOR now? [Y/n] " open_editor
    if test "$open_editor" != n -a "$open_editor" != N
        set -q EDITOR; or set EDITOR vi
        $EDITOR ansible/inventory/group_vars/all/vault.yml
    end

    info "Encrypting vault.yml..."
    ansible-vault encrypt ansible/inventory/group_vars/all/vault.yml
    or die "failed to encrypt vault.yml"
end

# ── Ansible collections ────────────────────────────────────────────────────────

info "Installing Ansible collections..."
ansible-galaxy collection install -r ansible/requirements.yml
or die "failed to install Ansible collections"

# ── Bootstrap SSH keys ─────────────────────────────────────────────────────────

info "Bootstrapping SSH key authentication on all hosts..."
ansible-playbook ansible/bootstrap.yml
or die "bootstrap playbook failed"

# ── Full provisioning ──────────────────────────────────────────────────────────

info "Provisioning all nodes..."
ansible-playbook ansible/site.yml
or die "site playbook failed"

echo ""
echo "$green$bold All done.$reset wormhole is running on all nodes."
