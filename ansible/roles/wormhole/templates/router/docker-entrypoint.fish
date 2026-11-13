#!/usr/bin/fish

# Divert decrypted AWG client traffic into sing-box's TUN.
#
# nftables matches iifname awg-in (stable across ifindex changes) and sets
# mark 100. The fwmark ip rule is not ifindex-bound, but systemd-networkd
# still deletes it on restart (ManageForeignRoutingPolicyRules=yes).
# Table 100 routes bind to ifindex and die when awg-in or sb-awg-in is
# recreated. A single poll loop repairs whatever is missing.
#
# Table 100 is longest-prefix:
#   AWG connected prefixes -> awg-in  (LAN / client-to-client)
#   default                -> sb-awg-in
# DNS to .1 is local and never hits this table; nftables prerouting DNATs
# it to the TUN /30 peer so hijack-dns still sees the query.
#
# The first poll loads nftables so the healthcheck can pass. amneziawg
# and sing-box wait on that, then create the interfaces later polls
# wait for — do not require those ifaces for healthy or compose
# deadlocks.

set -g AWG_IF awg-in
set -g TUN_IF sb-awg-in
set -g TABLE 100
set -g PREF 100
set -g MARK 100
# A full sync forks nft and ip several times (~40 ms of CPU, which a
# single-vCPU node feels), so once converged it runs every FULL_EVERY polls.
# In between, a fork-free sysfs read of both ifindexes catches the common
# breakage (a container recreating awg-in or sb-awg-in) within one poll.
set -g POLL_INTERVAL 2
set -g FULL_EVERY 5

function nft_ok
  nft list table ip wormhole >/dev/null 2>&1
end

function apply_nftables
  echo "Applying nftables rules..."
  nft -f /etc/nftables/ruleset.nft
  or return 1
  echo "nftables applied."
end

function policy_ok
  string match -q "*fwmark*lookup $TABLE*" (ip -4 rule show pref $PREF)
end

function apply_policy
  echo "Installing fwmark $MARK lookup $TABLE pref $PREF..."
  while ip -4 rule del pref $PREF 2>/dev/null
  end
  ip -4 rule add fwmark $MARK lookup $TABLE pref $PREF
  or return 1
  echo "Policy applied:"
  ip -4 rule show pref $PREF
end

function interface_up --argument-names iface
  string match -qr '[,<]UP[,>]' (ip -o link show $iface 2>/dev/null)
end

function tun_up
  interface_up $AWG_IF; and interface_up $TUN_IF
end

function awg_lan_cidrs
  string split -f1 -- ' ' (ip -4 route show proto kernel dev $AWG_IF)
end

function routes_ok
  test (count (awg_lan_cidrs)) -gt 0
  or return 1
  string match -q "*default*dev $TUN_IF*" (ip -4 route show table $TABLE 2>/dev/null)
  or return 1
  for cidr in (awg_lan_cidrs)
    string match -q "*$cidr*dev $AWG_IF*" (ip -4 route show table $TABLE 2>/dev/null)
    or return 1
  end
end

function apply_routes
  set -l cidrs (awg_lan_cidrs)
  if test (count $cidrs) -eq 0
    echo "No LAN prefixes on $AWG_IF yet..."
    return 1
  end

  echo "Installing AWG divert (LAN $AWG_IF, else $TUN_IF table $TABLE)..."
  ip route flush table $TABLE 2>/dev/null

  for cidr in $cidrs
    ip route replace $cidr dev $AWG_IF table $TABLE
    or return 1
  end
  ip route replace default dev $TUN_IF table $TABLE
  or return 1
  echo "Routes applied:"
  ip -4 route show table $TABLE
end

function sync
  nft_ok; or apply_nftables
  policy_ok; or apply_policy
  tun_up; or return
  routes_ok; or apply_routes
end

# "<awg ifindex> <tun ifindex>" from sysfs; builtins only, no fork.
function ifindexes
  for iface in $AWG_IF $TUN_IF
    set -l idx -
    set -l f /sys/class/net/$iface/ifindex
    test -r $f; and read idx <$f
    printf '%s ' $idx
  end
end

# The table survives a container restart, so the loop's missing-table check
# alone would never load an updated ruleset (it waited for a reboot). Load
# it once up front: the file flushes and redefines the table in one atomic
# transaction, so live traffic never sees a half-applied ruleset.
apply_nftables

echo "Waiting for $AWG_IF and $TUN_IF..."
set -l seen ''
set -l polls 0
while true
  set -l now (ifindexes)
  if test $polls -le 0; or test "$now" != "$seen"
    if sync
      set seen $now
      set polls $FULL_EVERY
    else
      set seen ''
      set polls 0
    end
  end
  set polls (math $polls - 1)
  sleep $POLL_INTERVAL
end
