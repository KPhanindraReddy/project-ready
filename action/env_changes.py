"""Compare committed environment templates. Never run checked-out application code."""
import html
import json
import os
import re
import subprocess
from pathlib import Path

def git(*args):
    return subprocess.check_output(["git", *args])

def keys_at(commit, path):
    spec = f"{commit}:{path}"
    exists = subprocess.run(["git", "cat-file", "-e", spec], capture_output=True)
    if exists.returncode:
        return set()
    raw = git("show", spec).decode("utf8", "replace")
    return set(re.findall(r"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)[ \t]*=", raw, re.M))

def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = event.get("pull_request")
    if not pr:
        return "This check runs on pull requests."
    head, base = pr["head"]["sha"], pr["base"]["sha"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", s) for s in [base, head]):
        raise ValueError("Invalid commit identifier")
    try:
        ancestor = git("merge-base", base, head).decode().strip()
    except subprocess.CalledProcessError:
        raise SystemExit("Cannot find the comparison commits. Use actions/checkout with fetch-depth: 0.")
    paths = git("diff", "--no-renames", "--name-only", "-z", ancestor, head, "--").split(b"\0")
    rows = []
    for raw in paths:
        if raw.split(b"/")[-1] != b".env.example":
            continue
        path = os.fsdecode(raw)
        for key in sorted(keys_at(head,path) - keys_at(ancestor,path)):
            display = html.escape(path.encode("utf8","backslashreplace").decode()).replace("\n"," ").replace("\r"," ")
            rows.append(f"<tr><td><code>{display}</code></td><td><code>{key}</code></td></tr>")
    if not rows:
        return "No new environment keys in changed .env.example files."
    return ("Review these new keys when setting up your local environment.\n\n"
            "<table><tr><th>Template</th><th>Added key</th></tr>\n"
            + "\n".join(rows) + "\n</table>")

if __name__ == "__main__":
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf8") as summary:
        summary.write("## Project Ready\n\n" + main() + "\n")
