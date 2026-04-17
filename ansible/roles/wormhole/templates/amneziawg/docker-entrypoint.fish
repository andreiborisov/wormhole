function start_amneziawg
  echo "Starting AmneziaWG"

  awg-quick down /opt/amnezia/awg/awg-in.conf
  awg-quick up /opt/amnezia/awg/awg-in.conf
  or return 1
end

start_amneziawg
and sleep infinity
