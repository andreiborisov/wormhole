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


def find_rules_dir(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        rules_dir = candidate / "rules"
        if rules_dir.is_dir():
            return rules_dir
    raise FileNotFoundError("Could not find the rules directory")


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    rules_dir = find_rules_dir(script_dir)

    for json_file in sorted(rules_dir.glob("*.json")):
        extracted_values = extract_values_from_file(json_file)
        output_file = json_file.with_suffix(".txt")
        output_text = "\n".join(extracted_values)
        if output_text:
            output_text += "\n"
        output_file.write_text(output_text, encoding="utf-8")
        print(f"Wrote {len(extracted_values)} entries to {output_file.name}")


if __name__ == "__main__":
    main()
