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

function list_inventories
  set -l found 0
  if test -d ansible/inventories
    for d in ansible/inventories/*
      if test -d "$d"
        if test $found -eq 0
          echo "Available inventories:"
          set found 1
        end
        echo "  "(basename $d)
      end
    end
  end
  if test $found -eq 0
    echo "No inventories found. Create one from the example:"
    echo ""
    echo "  cp -R ansible/inventories.example ansible/inventories/production"
    echo "  \$EDITOR ansible/inventories/production/hosts.local.yml"
  end
end

function usage
  echo "Usage: fish setup.fish <inventory>"
  echo ""
  echo "  inventory  Directory name under ansible/inventories/"
  echo ""
  echo "Examples:"
  echo "  fish setup.fish production"
  echo "  fish setup.fish development"
  echo ""
  list_inventories
end

# ── Prerequisites ──────────────────────────────────────────────────────────────

if not command -q ansible-playbook
  info "Installing dependencies via Homebrew..."
  brew bundle
  or die "brew bundle failed"
end

# ── Inventory ──────────────────────────────────────────────────────────────────

if test (count $argv) -lt 1; or contains -- $argv[1] -h --help
  usage
  exit 1
end

set -l inventory $argv[1]

if not string match -qr '^[A-Za-z0-9._-]+$' -- $inventory
  die "inventory must be a directory name under ansible/inventories/ (not a path)"
end

set -l inventory_dir ansible/inventories/$inventory
set -l hosts_file $inventory_dir/hosts.local.yml
set -l vault_file $inventory_dir/group_vars/all/vault.yml

if not test -d $inventory_dir
  warn "ansible/inventories/$inventory not found."
  echo ""
  echo "      Copy the example and fill in your details:"
  echo ""
  echo "        cp -R ansible/inventories.example ansible/inventories/$inventory"
  echo "        \$EDITOR ansible/inventories/$inventory/hosts.local.yml"
  echo ""
  list_inventories
  echo ""
  die "create ansible/inventories/$inventory before continuing"
end

if not test -f $hosts_file
  die "missing $hosts_file"
end

if not test -f $vault_file
  die "missing $vault_file"
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
if not grep -q '^\$ANSIBLE_VAULT' $vault_file
  warn "$vault_file is not encrypted."
  echo "      Edit it to fill in real secrets, then it will be encrypted automatically."
  echo ""

  read -P "      Open vault.yml in \$EDITOR now? [Y/n] " open_editor
  if test "$open_editor" != n -a "$open_editor" != N
    $EDITOR $vault_file
  end

  info "Encrypting vault.yml..."
  # Run from ansible/ so ansible.cfg (and its vault_password_file path) is found correctly
  cd ansible
  ansible-vault encrypt inventories/$inventory/group_vars/all/vault.yml
  or die "failed to encrypt vault.yml"
  cd ..
end

# ── Run ansible from its directory so ansible.cfg paths resolve correctly ──────

cd ansible

# ── Ansible collections ────────────────────────────────────────────────────────

info "Installing Ansible collections..."
ansible-galaxy collection install -r requirements.yml
or die "failed to install Ansible collections"

# ── Bootstrap SSH keys ─────────────────────────────────────────────────────────

info "Bootstrapping SSH key authentication on all hosts..."
ansible-playbook -i inventories/$inventory bootstrap.yml
or die "bootstrap playbook failed"

# ── Full provisioning ──────────────────────────────────────────────────────────

info "Provisioning all nodes..."
ansible-playbook -i inventories/$inventory site.yml
or die "site playbook failed"

cd ..

echo ""
echo "$green$bold All done.$reset Wormhole is running on all nodes."
