if test (count $argv) -eq 0
  echo "Usage: docker-entrypoint.fish <interface> [interface2 ...]"
  exit 1
end

set interfaces $argv

function apply_rules
  echo "Loading netfilter modules..."
  modprobe nft_tproxy
  or return 1

  modprobe nft_socket
  or return 1

  echo "Setting up TPROXY policy routing..."
  ip rule add fwmark 1 table 100 2> /dev/null; or true
  ip route add local default dev lo table 100 2> /dev/null; or true

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
        echo "Interface $interface removed — exiting for Docker restart."
        return 1
      end
    end
  end
end

apply_rules
and monitor_interfaces
