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
set -g POLL_INTERVAL 2

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

echo "Waiting for $AWG_IF and $TUN_IF..."
while true
  sync
  sleep $POLL_INTERVAL
end
