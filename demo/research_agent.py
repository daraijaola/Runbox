#!/usr/bin/env python3
"""
Agent-to-Agent Demo: Research agent uses RunBox for computation.

Demonstrates RunBox as infrastructure — a research agent autonomously
pays for and executes code to answer a user's question.

Flow:
  1. User asks a question requiring computation
  2. Research agent discovers RunBox via .well-known/runbox.json
  3. Agent rents a session (pays 0.01 USDC on Stellar)
  4. Agent writes and sends Python code to RunBox
  5. Agent gets the computed result back
  6. Agent returns the answer to the user
"""

import json
import sys
import os
import urllib.request

RUNBOX_SERVER = os.environ.get("RUNBOX_SERVER", "http://46.101.74.170:4001")


def discover():
    """Discover RunBox capabilities."""
    url = f"{RUNBOX_SERVER}/api/exec/.well-known/runbox.json"
    print(f"[agent] Discovering RunBox at {url}")
    with urllib.request.urlopen(url, timeout=10) as resp:
        manifest = json.loads(resp.read())
    print(f"[agent] RunBox v{manifest['version']} | {len(manifest['supportedLanguages'])} languages")
    print(f"[agent] Price: {manifest['payment']['pricePerSession']} USDC/session")
    return manifest


def rent_session(tx_hash):
    """Pay for a RunBox session."""
    url = f"{RUNBOX_SERVER}/api/exec/rent"
    print(f"\n[agent] Renting session with tx: {tx_hash[:16]}...")
    req = urllib.request.Request(url, method="POST")
    req.add_header("X-Payment-Hash", tx_hash)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    print(f"[agent] Session: {data['session_id']} | Expires: {data['expires_at']}")
    return data["session_token"]


def execute_code(token, language, code):
    """Execute code in RunBox sandbox."""
    url = f"{RUNBOX_SERVER}/api/exec/run"
    print(f"\n[agent] Executing {language} ({len(code)} chars)...")
    payload = json.dumps({"language": language, "code": code}).encode()
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    print(f"[agent] Exit: {result['exitCode']} | Time: {result['executionMs']}ms")
    return result


def research_agent(question, tx_hash):
    """Research agent that uses RunBox for computation."""
    print(f"{'='*60}")
    print(f"Research Agent")
    print(f"Question: {question}")
    print(f"{'='*60}")

    manifest = discover()
    token = rent_session(tx_hash)

    analysis_code = """
import json
data = {
    "Brazil":       {"2020": -3.3, "2021": 5.0, "2022": 2.9, "2023": 2.9},
    "Russia":       {"2020": -2.7, "2021": 5.6, "2022": -2.1, "2023": 3.6},
    "India":        {"2020": -5.8, "2021": 9.1, "2022": 7.2, "2023": 7.8},
    "China":        {"2020": 2.2, "2021": 8.4, "2022": 3.0, "2023": 5.2},
    "South Africa": {"2020": -6.0, "2021": 4.9, "2022": 1.9, "2023": 0.6},
}
results = {}
for country, years in data.items():
    results[country] = round(sum(years.values()) / len(years), 2)
brics_avg = round(sum(results.values()) / len(results), 2)
print(json.dumps({
    "per_country": results,
    "brics_average": brics_avg,
    "top_performer": max(results, key=results.get),
}, indent=2))
"""

    result = execute_code(token, "python", analysis_code)
    if result["exitCode"] == 0:
        answer = json.loads(result["stdout"])
        print(f"\n{'='*60}")
        print(f"BRICS Average GDP Growth (2020-2023): {answer['brics_average']}%")
        for country, avg in answer["per_country"].items():
            print(f"  {country}: {avg}%")
        print(f"Top performer: {answer['top_performer']}")
    return result


if __name__ == "__main__":
    print("RunBox Agent-to-Agent Demo\n")
    manifest = discover()
    print(f"\n[demo] Agent would pay {manifest['payment']['pricePerSession']} USDC, run code, return answer")
    if len(sys.argv) > 1:
        research_agent("Average GDP growth of BRICS nations 2020-2023?", sys.argv[1])
