"""Compare committed environment templates. Never run checked-out application code."""
import html
import json
import os
import re
import subprocess
from pathlib import Path

def git(*args):
    return subprocess.check_output(["git", *args])

def contents_at(commit, path):
    spec = f"{commit}:{path}"
    exists = subprocess.run(["git", "cat-file", "-e", spec], capture_output=True)
    if exists.returncode:
        return ""
    return git("show", spec).decode("utf8", "replace")

def keys_at(commit, path):
    raw = contents_at(commit, path)
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
    keys, versions = [], []
    for raw in paths:
        path = os.fsdecode(raw)
        filename = path.rsplit("/", 1)[-1]
        if filename == ".env.example":
            for key in sorted(keys_at(head, path) - keys_at(ancestor, path)):
                keys.append((path, key))
        elif filename == "package.json":
            before = requirements(contents_at(ancestor, path))
            after = requirements(contents_at(head, path))
            for section, name in sorted(before.keys() | after.keys()):
                old = before.get((section, name))
                new = after.get((section, name))
                if old != new:
                    versions.append((path, section, name, safe_spec(old), safe_spec(new)))
    sections = []
    if versions:
        sections.append("### Version requirements changed\n\n" + table(
            ["Manifest", "Type", "Item", "Previous requirement", "New requirement"], versions))
    if keys:
        sections.append("### New environment keys\n\n" + table(["Template", "Key"], keys))
    return "\n\n".join(sections) or "No version requirement changes or new environment keys."

def requirements(raw):
    manifest = json.loads(raw or "{}")
    fields = ("engines", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
    return {(field, name): value for field in fields
            for name, value in manifest.get(field, {}).items()}

def safe_spec(value):
    if value is None:
        return "—"
    # URLs and local paths may include private information.
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9.*+~^<>=| _-]+", value):
        return "Custom source (see manifest)"
    return value

def table(headers, rows):
    def row(values, tag):
        cells = [html.escape(str(v).encode("utf8", "backslashreplace").decode()) for v in values]
        return "<tr>" + "".join(f"<{tag}>{v}</{tag}>" for v in cells) + "</tr>"
    return "<table>" + row(headers, "th") + "".join(row(r, "td") for r in rows) + "</table>"

if __name__ == "__main__":
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf8") as summary:
        summary.write("## Project Ready\n\n" + main() + "\n")
