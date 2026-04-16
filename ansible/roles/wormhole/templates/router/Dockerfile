FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  fish \
  iproute2 \
  kmod \
  nftables \
  && rm -rf /var/lib/apt/lists/*

ENTRYPOINT [ "fish", "/docker-entrypoint.fish" ]
