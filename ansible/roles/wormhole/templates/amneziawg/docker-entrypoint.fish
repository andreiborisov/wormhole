#!/usr/bin/fish

function start_amneziawg
  echo "Starting AmneziaWG"

  set conf /opt/amnezia/awg/awg-in.conf
  if not test -f $conf
    echo "No awg-in.conf found"
    return 1
  end

  awg-quick down $conf >/dev/null 2>&1

  for iface in (ls /sys/class/net | string match 'awg-in*')
    ip link delete $iface >/dev/null 2>&1
  end

  awg-quick up $conf
  or return 1
end

start_amneziawg
and sleep infinity
