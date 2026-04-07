FROM amneziavpn/amneziawg-go:latest

RUN apk add --no-cache bash iptables dumb-init

ENTRYPOINT [ "dumb-init", "/opt/amnezia/start.sh" ]
CMD [ "" ]
