#!/usr/bin/fish

if test (count $argv) -eq 0
  echo "Usage: docker-entrypoint.fish <interface> [interface2 ...]"
  exit 1
end

set interfaces $argv

function wait_for_interfaces
  echo "Waiting for interfaces:" $interfaces

  for interface in $interfaces
    while not ip link show $interface &> /dev/null
      sleep 5
    end
    echo "Interface $interface is up."
  end
end

function apply_rules
  echo "Applying rules..."
  echo "Loading netfilter modules..."
  modprobe nft_tproxy
  or return 1

  modprobe nft_socket
  or return 1

  echo "Setting up TPROXY policy routing..."
  if not ip rule show | string match -q "*fwmark 0x100/0x100*lookup 100*"
    ip rule add fwmark 0x100/0x100 table 100
  end
  ip route replace local default dev lo table 100

  echo "Applying nftables rules..."
  nft -f /etc/nftables/ruleset.nft
  or return 1

  echo "Done."
end

function monitor_interfaces
  echo "Monitoring interfaces:" $interfaces

  ip monitor link | while read -l line
    for interface in $interfaces
      if string match -q "Deleted*$interface*" $line
        echo "Interface $interface removed."
        # Drain the pipe to let ip monitor exit cleanly
        kill (pgrep -n ip) 2> /dev/null
        return 1
      end
    end
  end
end

while true
  wait_for_interfaces
  and apply_rules
  and monitor_interfaces
end
