#!/usr/bin/fish

# Divert decrypted AWG client traffic into sing-box's TUN.
# Table/pref 100 is ours; iif rules bind to ifindex and must be refreshed
# whenever awg-in or sb-awg-in is recreated (container restart, reboot).
#
# Table 100 is longest-prefix:
#   AWG connected prefixes -> awg-in  (LAN / client-to-client)
#   advertised DNS .53/32  -> sb-awg-in (sing-box hijack-dns)
#   default                -> sb-awg-in
#
# nftables is applied first so the healthcheck can pass. amneziawg and
# sing-box wait on that healthcheck, then create the interfaces this
# loop waits for — do not require those ifaces for healthy or compose
# deadlocks.
#
# One long-lived `ip monitor` pipeline: subscribe, snapshot, then sync
# on link/address/route events. Do not `read` a single event and exit —
# fish waits for the writer, and `ip monitor` never exits.

set -g AWG_IF awg-in
set -g TUN_IF sb-awg-in
set -g TABLE 100
set -g PREF 100

function apply_nftables
  echo "Applying nftables rules..."
  nft -f /etc/nftables/ruleset.nft
  or return 1
  echo "nftables applied."
end

function interface_up --argument-names iface
  string match -qr '[,<]UP[,>]' (ip -o link show $iface 2>/dev/null)
end

function all_up
  interface_up $AWG_IF; and interface_up $TUN_IF
end

function awg_lan_cidrs
  string split -f1 -- ' ' (ip -4 route show proto kernel dev $AWG_IF)
end

function awg_dns_ips
  for ip in (string replace -rf '.*inet ([0-9.]+)/.*' '$1' (ip -4 -o addr show dev $AWG_IF))
    set -l o (string split . $ip)
    echo $o[1].$o[2].$o[3].53
  end
end

function routes_ok
  test (count (awg_lan_cidrs)) -gt 0
  or return 1
  string match -q "*iif $AWG_IF lookup $TABLE*" (ip rule show pref $PREF)
  or return 1
  string match -q "*default*dev $TUN_IF*" (ip -4 route show table $TABLE)
  or return 1
  for cidr in (awg_lan_cidrs)
    string match -q "*$cidr*dev $AWG_IF*" (ip -4 route show table $TABLE)
    or return 1
  end
  for dns in (awg_dns_ips)
    string match -q "*$dns*dev $TUN_IF*" (ip -4 route show table $TABLE)
    or return 1
  end
end

function apply_routes
  set -l cidrs (awg_lan_cidrs)
  set -l dns_ips (awg_dns_ips)
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
  for dns in $dns_ips
    ip route replace $dns/32 dev $TUN_IF table $TABLE
    or return 1
  end
  ip route replace default dev $TUN_IF table $TABLE
  or return 1
  ip rule del pref $PREF 2>/dev/null
  ip rule add iif $AWG_IF lookup $TABLE pref $PREF
  or return 1
  echo "Routes applied:"
  ip rule show pref $PREF
  ip -4 route show table $TABLE
end

function sync_routes
  all_up; or return
  routes_ok; or apply_routes
end

function our_event --argument-names line
  string match -q "*$AWG_IF*" $line; or string match -q "*$TUN_IF*" $line
end

apply_nftables
or exit 1

ip -o monitor link address route | begin
  all_up; or echo "Waiting for $AWG_IF and $TUN_IF..."
  sync_routes </dev/null
  while read -l line
    our_event $line; or continue
    sync_routes </dev/null
  end
end
