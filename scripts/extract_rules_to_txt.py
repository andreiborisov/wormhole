#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path


def iter_rule_values(rule: object) -> list[str]:
    if not isinstance(rule, dict):
        return []

    values: list[str] = []
    for field_value in rule.values():
        if isinstance(field_value, list):
            for item in field_value:
                if isinstance(item, (str, int, float, bool)):
                    values.append(str(item))
    return values


def extract_values_from_file(json_path: Path) -> list[str]:
    with json_path.open("r", encoding="utf-8") as file:
        payload = json.load(file)

    rules = payload.get("rules", [])
    if not isinstance(rules, list):
        return []

    extracted: list[str] = []
    for rule in rules:
        extracted.extend(iter_rule_values(rule))
    return extracted


def find_inventory_file(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        inventory_file = candidate / "ansible" / "inventory" / "hosts.local.yml"
        if inventory_file.is_file():
            return inventory_file
    raise FileNotFoundError("Could not find ansible/inventory/hosts.local.yml")


def _strip_yaml_scalar(value: str) -> str:
    scalar = value.strip()
    if (scalar.startswith("'") and scalar.endswith("'")) or (
        scalar.startswith('"') and scalar.endswith('"')
    ):
        return scalar[1:-1]
    return scalar


def _parse_hosts_inventory(inventory_file: Path) -> dict[str, dict[str, object]]:
    hosts: dict[str, dict[str, object]] = {}
    current_host: str | None = None
    in_hosts = False
    in_dns = False
    in_peers = False
    in_local_domains = False

    for raw_line in inventory_file.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()

        if line == "hosts:" and indent == 2:
            in_hosts = True
            current_host = None
            in_dns = in_peers = in_local_domains = False
            continue

        if not in_hosts:
            continue

        if indent == 4 and line.endswith(":"):
            current_host = line[:-1]
            hosts[current_host] = {
                "restricted": False,
                "peers": [],
                "local_domains": [],
            }
            in_dns = in_peers = in_local_domains = False
            continue

        if current_host is None:
            continue

        if indent <= 4:
            current_host = None
            in_dns = in_peers = in_local_domains = False
            continue

        if indent == 6 and line.startswith("restricted:"):
            value = _strip_yaml_scalar(line.split(":", 1)[1]).lower()
            hosts[current_host]["restricted"] = value in {"true", "yes", "on", "1"}
            continue

        if indent == 6 and line == "dns:":
            in_dns = True
            in_peers = False
            in_local_domains = False
            continue

        if indent == 6 and line == "peers:":
            in_peers = True
            in_dns = False
            in_local_domains = False
            continue

        if indent == 8 and in_dns and line == "local_domains:":
            in_local_domains = True
            continue

        if indent == 8 and line.endswith(":"):
            in_local_domains = False
            continue

        if indent == 8 and line.startswith("- ") and in_peers:
            peer_name = _strip_yaml_scalar(line[2:])
            if peer_name:
                hosts[current_host]["peers"].append(peer_name)
            continue

        if indent == 10 and line.startswith("- ") and in_dns and in_local_domains:
            domain = _strip_yaml_scalar(line[2:])
            if domain:
                hosts[current_host]["local_domains"].append(domain)
            continue

    return hosts


def get_peer_local_domains_by_restriction(inventory_file: Path) -> dict[bool, list[str]]:
    hosts = _parse_hosts_inventory(inventory_file)
    domains_by_restriction: dict[bool, list[str]] = {True: [], False: []}

    for host_data in hosts.values():
        restricted = bool(host_data.get("restricted", False))
        peers = host_data.get("peers", [])
        if not isinstance(peers, list):
            continue

        for peer_name in peers:
            peer_data = hosts.get(str(peer_name), {})
            local_domains = peer_data.get("local_domains", [])
            if isinstance(local_domains, list):
                for domain in local_domains:
                    if isinstance(domain, str):
                        domains_by_restriction[restricted].append(domain)

    return {k: list(dict.fromkeys(v)) for k, v in domains_by_restriction.items()}


def find_rules_dir(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        rules_dir = candidate / "rules"
        if rules_dir.is_dir():
            return rules_dir
    raise FileNotFoundError("Could not find the rules directory")


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    rules_dir = find_rules_dir(script_dir)
    inventory_file = find_inventory_file(script_dir)
    peer_domains_by_restriction = get_peer_local_domains_by_restriction(inventory_file)

    for json_file in sorted(rules_dir.glob("*.json")):
        extracted_values = extract_values_from_file(json_file)
        if json_file.stem == "restricted":
            extracted_values.extend(peer_domains_by_restriction.get(True, []))
        elif json_file.stem == "unrestricted":
            extracted_values.extend(peer_domains_by_restriction.get(False, []))
        output_file = json_file.with_suffix(".txt")
        output_text = "\n".join(extracted_values)
        if output_text:
            output_text += "\n"
        output_file.write_text(output_text, encoding="utf-8")
        print(f"Wrote {len(extracted_values)} entries to {output_file.name}")


if __name__ == "__main__":
    main()
