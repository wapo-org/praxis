"""Read-only Linear access: the in-sandbox `linear-read` tool and the server-side fetch used to verify quotes."""

from __future__ import annotations

import re
from typing import Any

import httpx

LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
LINEAR_READONLY_MCP_URL = "https://mcp.linear.app/mcp/readonly"
LINEAR_TEAM_KEY = "PRA"
LINEAR_FETCH_TIMEOUT_SECONDS = 20.0
# Bounds the number of server-side Linear calls one review can trigger.
LINEAR_ISSUES_PER_RUN_MAX = 10
ISSUE_ID_PATTERN = re.compile(r"^PRA-(\d+)$")

ISSUE_TEXT_QUERY = """
query($num: Float!) {
  issues(first: 1, filter: { team: { key: { eq: "PRA" } }, number: { eq: $num } }) {
    nodes {
      identifier title description
      comments(first: 50) { nodes { body } }
    }
  }
}
"""

LINEAR_READ_SCRIPT = """#!/usr/bin/env python3
import json
import os
import sys
import urllib.request

key = os.environ.get("LINEAR_API_KEY", "").strip()
if not key:
    print("LINEAR_API_KEY is not set", file=sys.stderr)
    sys.exit(1)

args = sys.argv[1:]
if not args or args[0] in ("-h", "--help"):
    print("Usage: linear-read <PRA-123 | list [limit] | search <text> | graphql <query>>")
    sys.exit(0)

cmd = args[0]
if cmd.upper().startswith("PRA-"):
    num = int(cmd.split("-", 1)[1])
    query = '''
    query($num: Float!) {
      issues(first: 1, filter: { team: { key: { eq: "PRA" } }, number: { eq: $num } }) {
        nodes {
          identifier title priority state { name type }
          labels { nodes { name } }
          parent { identifier title }
          children(first: 20) { nodes { identifier title state { name } } }
          description
          comments(first: 20) { nodes { body user { name } createdAt } }
        }
      }
    }'''
    variables = {"num": num}
elif cmd == "list":
    limit = int(args[1]) if len(args) > 1 else 30
    query = f'''
    query {{
      issues(first: {limit}, orderBy: updatedAt, filter: {{ team: {{ key: {{ eq: "PRA" }} }} }}) {{
        nodes {{ identifier title state {{ name }} labels {{ nodes {{ name }} }} parent {{ identifier }} }}
      }}
    }}'''
    variables = {}
elif cmd == "search" and len(args) > 1:
    term = " ".join(args[1:])
    query = '''
    query($term: String!) {
      issueSearch(query: $term, first: 20) {
        nodes { identifier title state { name } description }
      }
    }'''
    variables = {"term": term}
elif cmd == "graphql" and len(args) > 1:
    query = args[1]
    if "mutation" in query.lower():
        print("Read-only tool: mutations are forbidden.", file=sys.stderr)
        sys.exit(2)
    variables = json.loads(args[2]) if len(args) > 2 else {}
else:
    print("Unknown command. Run linear-read --help", file=sys.stderr)
    sys.exit(2)

req = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
    headers={"Authorization": key, "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=20) as resp:
    print(resp.read().decode("utf-8"))
"""


def issue_text_from_response(payload: dict[str, Any]) -> str:
    """Title, description and comments as one text blob; empty when the issue does not exist."""
    nodes = (((payload.get("data") or {}).get("issues") or {}).get("nodes")) or []
    if not nodes:
        return ""
    issue = nodes[0]
    comments = ((issue.get("comments") or {}).get("nodes")) or []
    parts = [issue.get("title") or "", issue.get("description") or ""]
    parts.extend(comment.get("body") or "" for comment in comments)
    return "\n\n".join(part for part in parts if part)


def fetch_issue_texts(
    client: httpx.Client,
    api_key: str,
    issue_ids: list[str],
) -> dict[str, str]:
    """Fetch the text of each cited issue; an issue that cannot be fetched is simply absent (quotes then fail)."""
    texts: dict[str, str] = {}
    if not api_key:
        return texts
    for issue_id in issue_ids[:LINEAR_ISSUES_PER_RUN_MAX]:
        match = ISSUE_ID_PATTERN.match(issue_id)
        if not match:
            continue
        response = client.post(
            LINEAR_GRAPHQL_URL,
            json={"query": ISSUE_TEXT_QUERY, "variables": {"num": int(match.group(1))}},
            headers={"Authorization": api_key, "Content-Type": "application/json"},
            timeout=LINEAR_FETCH_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            continue
        text = issue_text_from_response(response.json())
        if text:
            texts[issue_id] = text
    return texts
