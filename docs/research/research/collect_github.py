"""Collect public repository metadata without credentials or local configuration.

This research helper performs only public HTTPS GET requests. It never reads
environment variables, auth files, user settings, or credentials. It does not
install, clone, execute upstream code, or deploy anything.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import json
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
REPOS = [
    "Infisical/agent-vault",
    "jlowin/fastmcp", "IBM/mcp-context-forge", "BerriAI/litellm",
    "QuantumNous/new-api", "songquanpeng/one-api", "maximhq/bifrost",
    "NangoHQ/nango", "ComposioHQ/composio", "PipedreamHQ/pipedream",
    "Infisical/infisical", "hashicorp/vault", "unkeyed/unkey",
    "gravitational/teleport", "openssh/openssh-portable",
]

def get(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "api-call-hub-public-research",
        "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as res:
            return {"url": url, "status": res.status, "data": json.load(res)}
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        return {"url": url, "error": str(exc)}

def collect(repo):
    base = "https://api.github.com/repos/" + repo
    record = {"repository": repo, "checked_at_utc": datetime.now(timezone.utc).isoformat()}
    for name, suffix in [("metadata", ""), ("license", "/license"), ("latest_release", "/releases/latest"), ("head_commit", "/commits?per_page=1")]:
        record[name] = get(base + suffix)
    (ROOT / "github" / (repo.replace("/", "__") + ".json")).write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    data = record["metadata"].get("data", {})
    release = record["latest_release"].get("data", {})
    commits = record["head_commit"].get("data", [])
    commit = commits[0] if isinstance(commits, list) and commits else {}
    return {
        "repository": repo, "url": data.get("html_url"),
        "archived": data.get("archived"), "default_branch": data.get("default_branch"),
        "pushed_at": data.get("pushed_at"),
        "license_detected": (data.get("license") or {}).get("spdx_id"),
        "license_url": record["license"].get("data", {}).get("html_url"),
        "latest_release": release.get("tag_name"), "release_published_at": release.get("published_at"),
        "release_url": release.get("html_url"), "head_sha": commit.get("sha"),
        "head_commit_at": commit.get("commit", {}).get("committer", {}).get("date"),
        "errors": {name: result["error"] for name, result in record.items() if isinstance(result, dict) and "error" in result},
    }

if __name__ == "__main__":
    (ROOT / "github").mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        summary = list(pool.map(collect, REPOS))
    (ROOT / "github-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
