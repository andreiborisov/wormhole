function load_modules
  echo "Loading modules"

  modprobe tcp_hybla
  or return 1
end

function start_amneziawg
  echo "Starting AmneziaWG"

  awg-quick down /opt/amnezia/awg/awg-in.conf
  awg-quick up /opt/amnezia/awg/awg-in.conf
  or return 1
end

load_modules
and start_amneziawg
and sleep infinity
