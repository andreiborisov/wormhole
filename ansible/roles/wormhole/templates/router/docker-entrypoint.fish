#!/usr/bin/fish

function apply_rules
  echo "Applying nftables rules..."
  nft -f /etc/nftables/ruleset.nft
  or return 1

  echo "Done."
end

apply_rules
