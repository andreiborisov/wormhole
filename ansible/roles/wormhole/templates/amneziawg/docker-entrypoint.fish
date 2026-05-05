#!/usr/bin/fish

function start_amneziawg
  echo "Starting AmneziaWG"

  set confs /opt/amnezia/awg/awg-in-*.conf
  if test (count $confs) -eq 0
    echo "No awg-in-*.conf found"
    return 1
  end

  for conf in $confs
    awg-quick down $conf >/dev/null 2>&1
    awg-quick up $conf
    or return 1
  end
end

start_amneziawg
and sleep infinity
