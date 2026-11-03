#!/usr/bin/env python3
"""Check the exact public payload, not a recursive workstation directory upload."""
import re
import sys
import tarfile

# A best-effort raw-byte guard, not a claim to inspect every compressed or
# encrypted string inside an executable. Source review remains required.
patterns = {
    # "dev" occurs in upstream's synthetic gallery fixtures; runner is public CI.
    "workstation home path": rb"/Users/(?!(?:runner(?:/|_)|dev/))[A-Za-z0-9_.-]+/|/home/(?!runner/)[A-Za-z0-9_.-]+/",
    "GitHub credential": rb"gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,}",
    "OpenAI project credential": rb"sk-proj-[A-Za-z0-9_-]{40,}",
}

with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    if sorted(member.name for member in members) != ["LICENSE", "bin/omp"]:
        raise SystemExit("Unexpected archive members: release only bin/omp and LICENSE")
    for member in members:
        if not member.isfile():
            raise SystemExit("Release members must be regular files")
        if (member.uid, member.gid, member.uname, member.gname) != (0, 0, "root", "root"):
            raise SystemExit("Archive owner/group metadata is not normalized")
        if any("xattr" in key.lower() for key in member.pax_headers):
            raise SystemExit("Archive contains extended attributes")
        payload = archive.extractfile(member).read()
        for label, pattern in patterns.items():
            if re.search(pattern, payload):
                # Never echo the matched bytes to public CI logs.
                raise SystemExit(f"Privacy gate: {label} detected in {member.name}")
print("Archive allowlist, ownership, xattrs, and raw credential/path checks passed")
