#!/usr/bin/env python3
"""Keep every published version in line with Cargo.toml.

  scripts/version.py sync          set npm/*/package.json versions (and the
                                   @malia/* optional dependencies) to Cargo.toml's
  scripts/version.py check vX.Y.Z  fail unless the tag, Cargo.toml and every npm
                                   package agree (run by the release workflow)
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def cargo_version():
    m = re.search(r'^version\s*=\s*"([^"]+)"', (ROOT / "Cargo.toml").read_text(), re.M)
    return m.group(1)


def npm_manifests():
    return sorted((ROOT / "npm").glob("*/package.json"))


def mismatches(version):
    out = []
    for path in npm_manifests():
        pkg = json.loads(path.read_text())
        rel = path.relative_to(ROOT)
        if pkg.get("version") != version:
            out.append(f"{rel}: version {pkg.get('version')}")
        for name, v in pkg.get("optionalDependencies", {}).items():
            if name.startswith("@malia/") and v != version:
                out.append(f"{rel}: {name} {v}")
    return out


def sync(version):
    for path in npm_manifests():
        text = path.read_text()
        pkg = json.loads(text)
        pkg["version"] = version
        for name in pkg.get("optionalDependencies", {}):
            if name.startswith("@malia/"):
                pkg["optionalDependencies"][name] = version
        indent = 2 if text.startswith('{\n  "') else 4
        path.write_text(json.dumps(pkg, indent=indent) + "\n")


def main(argv):
    version = cargo_version()
    if argv[:1] == ["sync"]:
        sync(version)
        print(f"npm packages set to {version}")
        return 0
    if argv[:1] == ["check"] and len(argv) == 2:
        problems = mismatches(version)
        if argv[1] != f"v{version}":
            problems.insert(0, f"tag {argv[1]} does not match Cargo.toml version {version}")
        for p in problems:
            print(f"version mismatch: {p}", file=sys.stderr)
        return 1 if problems else 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
