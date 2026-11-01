#!/usr/bin/env python3
"""Validate Sankey data without external dependencies. Exit 0 when valid, 1 otherwise."""
import argparse
from collections import deque
import json
import math
from pathlib import Path
import sys


def validate(data, tolerance=1e-6):
    errors = []
    if not isinstance(data, dict):
        return {"valid": False, "errors": ["Root must be an object."]}
    nodes, links = data.get("nodes"), data.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        return {"valid": False, "errors": ["nodes and links must be arrays."]}
    ids = []
    for number, node in enumerate(nodes):
        identifier = node.get("id") if isinstance(node, dict) else None
        if not isinstance(identifier, str) or not identifier.strip():
            errors.append(f"Node {number}: id must be a nonempty string.")
        elif identifier in ids:
            errors.append(f"Duplicate node id: {identifier}")
        else:
            ids.append(identifier)
    if not ids:
        errors.append("At least one node is required.")
    incoming, outgoing = {i: 0.0 for i in ids}, {i: 0.0 for i in ids}
    indegree, adjacency = {i: 0 for i in ids}, {i: [] for i in ids}
    positive_links = 0
    seen_pairs = set()
    for number, link in enumerate(links):
        if not isinstance(link, dict):
            errors.append(f"Link {number}: must be an object.")
            continue
        source, target, value = link.get("source"), link.get("target"), link.get("value")
        if not isinstance(source, str) or not isinstance(target, str) or source not in incoming or target not in incoming:
            errors.append(f"Link {number}: unknown or invalid endpoint.")
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(f"Link {number}: value must be numeric.")
            continue
        try:
            finite = math.isfinite(value)
        except (OverflowError, ValueError):
            finite = False
        if not finite or value < 0:
            errors.append(f"Link {number}: value must be finite and nonnegative.")
            continue
        pair = (source, target)
        if pair in seen_pairs:
            errors.append(f"Link {number}: duplicate source/target pair; aggregate or model distinct categories explicitly.")
        seen_pairs.add(pair)
        # Zero links still affect topology in common Sankey engines.
        adjacency[source].append(target)
        indegree[target] += 1
        outgoing[source] += value
        incoming[target] += value
        positive_links += value > 0
    if not positive_links:
        errors.append("At least one positive link is required to render useful widths.")
    if any(not math.isfinite(v) for v in (*incoming.values(), *outgoing.values())):
        errors.append("Accumulated node totals overflowed; rescale the units.")
    queue = deque(i for i in ids if indegree[i] == 0)
    visited = 0
    while queue:
        node = queue.popleft()
        visited += 1
        for target in adjacency[node]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if visited != len(ids):
        errors.append("Graph contains a cycle; the selected acyclic Sankey layout cannot render it.")
    allowed = data.get("allow_imbalance", {})
    if not isinstance(allowed, dict):
        errors.append("allow_imbalance must map node IDs to nonempty explanations.")
        allowed = {}
    for identifier, reason in allowed.items():
        if identifier not in incoming or not isinstance(reason, str) or not reason.strip():
            errors.append(f"Invalid imbalance allowance for {identifier!r}.")
    balances = []
    for identifier in ids:
        in_value, out_value = incoming[identifier], outgoing[identifier]
        difference = in_value - out_value
        if in_value > 0 and out_value > 0 and abs(difference) > tolerance:
            if identifier not in allowed:
                errors.append(f"Unexplained intermediate imbalance at {identifier}: in={in_value}, out={out_value}.")
            balances.append({"node": identifier, "incoming": in_value, "outgoing": out_value,
                             "difference": difference, "explanation": allowed.get(identifier)})
    totals = {"source_total": sum(outgoing[i] for i in ids if incoming[i] == 0),
              "sink_total": sum(incoming[i] for i in ids if outgoing[i] == 0)}
    expected = data.get("expected_total")
    if expected is not None:
        if isinstance(expected, bool) or not isinstance(expected, (int, float)):
            errors.append("expected_total must be finite and nonnegative.")
        else:
            try:
                acceptable = math.isfinite(expected) and expected >= 0
            except (OverflowError, ValueError):
                acceptable = False
            if not acceptable:
                errors.append("expected_total must be finite and nonnegative.")
            elif abs(totals["source_total"] - expected) > tolerance:
                errors.append(f"Source total {totals['source_total']} differs from expected_total {expected}.")
    return {"valid": not errors, "errors": errors, "node_count": len(ids),
            "link_count": len(links), **totals, "imbalances": balances,
            "tolerance": tolerance, "unit": data.get("unit"), "period": data.get("period")}


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Example: {"nodes":[{"id":"A"},{"id":"B"}],"links":[{"source":"A","target":"B","value":100}],"expected_total":100,"unit":"USD millions"}')
    parser.add_argument("path", type=Path)
    parser.add_argument("--tolerance", type=float, default=1e-6, help="Absolute tolerance in the stated units")
    args = parser.parse_args()
    if not math.isfinite(args.tolerance) or args.tolerance < 0:
        parser.error("--tolerance must be finite and nonnegative")
    try:
        data = json.loads(args.path.read_text(encoding="utf-8"))
        result = validate(data, args.tolerance)
    except (OSError, ValueError, OverflowError) as exc:
        result = {"valid": False, "errors": [str(exc)]}
    print(json.dumps(result, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
