#!/usr/bin/fish

# Divert decrypted AWG client traffic into sing-box's TUN.
# Table/pref 100 is ours; iif rules bind to ifindex and must be refreshed
# whenever awg-in or sb-awg-in is recreated (container restart, reboot).
#
# nftables is applied first so the healthcheck can pass. amneziawg and
# sing-box wait on that healthcheck, then create the interfaces this
# loop waits for — do not require those ifaces for healthy or compose
# deadlocks.
#
# One long-lived `ip monitor` pipeline: subscribe, snapshot, then sync
# on link events. Do not `read` a single event and exit — fish waits
# for the writer, and `ip monitor` never exits.

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

function routes_ok
  string match -q "*iif $AWG_IF lookup $TABLE*" (ip rule show pref $PREF)
  and string match -q "*dev $TUN_IF*" (ip -4 route show table $TABLE)
end

function apply_routes
  echo "Installing AWG divert (iif $AWG_IF -> $TUN_IF table $TABLE)..."
  ip route flush table $TABLE 2>/dev/null
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

function our_link_event --argument-names line
  string match -qr ": ($AWG_IF|$TUN_IF):" $line
end

apply_nftables
or exit 1

ip -o monitor link | begin
  all_up; or echo "Waiting for $AWG_IF and $TUN_IF..."
  sync_routes </dev/null
  while read -l line
    our_link_event $line; or continue
    sync_routes </dev/null
  end
end
