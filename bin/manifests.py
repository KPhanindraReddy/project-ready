"""Read static project declarations without importing application packages."""
import json
import os
import re
import sys
import tomllib
import xml.etree.ElementTree as ET
from email.parser import Parser
from pathlib import Path

root = Path(sys.argv[1])
rows = []
def record(kind, name, spec="", status="declared", detail=""):
    rows.append([kind, name, str(spec), status, detail])

def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()

venvs = [root / ".venv", root / "venv"]
if os.environ.get("VIRTUAL_ENV"):
    venvs.append(Path(os.environ["VIRTUAL_ENV"]))
site = []
for env in venvs:
    if (env / "pyvenv.cfg").is_file():
        site = [p for p in [env / "Lib/site-packages", *env.glob("lib/python*/site-packages")] if p.is_dir()]
        if site:
            break
installed = {}
for folder in site:
    for f in folder.glob("*.dist-info/METADATA"):
        with f.open(encoding="utf8", errors="replace") as stream:
            msg = Parser().parse(stream, headersonly=True)
        if msg["Name"]:
            installed[norm(msg["Name"])] = msg["Version"]

def requirement(line, optional=False):
    # Preserve declarations that need a full resolver as inventory only.
    m = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9_.-]*)(\[[^\]]+\])?\s*([<>=!~].*|;.*|@.*)?", line)
    if not m:
        record("python directive", "complex requirement", "", "unknown", "Inspect the original manifest")
        return
    name, extras, spec = m.groups()
    spec = spec or ""
    if "@" in spec:
        spec = "direct reference"
    version = installed.get(norm(name))
    status = "found-unverified" if version else "missing" if site and not optional and ";" not in spec else "declared"
    record("python", name, (extras or "") + spec, status, version or "")

for filename in sys.argv[2:]:
    f = root / filename
    if filename == "requirements.txt":
        for line in f.read_text(encoding="utf8").splitlines():
            line = line.split(" #", 1)[0].strip()
            if line and not line.startswith("#"):
                requirement(line)
    elif filename == "pyproject.toml":
        data = tomllib.loads(f.read_text(encoding="utf8"))
        project = data.get("project", {})
        for dep in project.get("dependencies", []):
            requirement(dep)
        for group in project.get("optional-dependencies", {}).values():
            for dep in group:
                requirement(dep, True)
        for name, dep in data.get("tool", {}).get("poetry", {}).get("dependencies", {}).items():
            record("poetry", name, dep if isinstance(dep,str) else dep.get("version","custom source"))
    elif filename == "Cargo.toml":
        data = tomllib.loads(f.read_text(encoding="utf8"))
        for scope in [data, data.get("workspace", {}), *data.get("target", {}).values()]:
            for kind in ["dependencies", "build-dependencies", "dev-dependencies"]:
                for name, dep in scope.get(kind, {}).items():
                    record("cargo/"+kind,name,dep if isinstance(dep,str) else dep.get("version","workspace or custom source"))
    else:
        for tag in ET.parse(f).iter():
            if tag.tag.split("}")[-1] == "PackageReference" and "Include" in tag.attrib:
                version = tag.get("Version") or next((c.text for c in tag if c.tag.split("}")[-1]=="Version"),"managed")
                record("nuget",tag.get("Include"),version)
print(json.dumps(rows))
