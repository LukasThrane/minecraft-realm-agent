#!/usr/bin/env python3
"""Fetch only the pinned navigation candidate; Gradle resolves the other build dependencies."""
import hashlib, json, pathlib, urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
spec=json.loads((root/'config/dependencies.json').read_text())['baritone']
dest=root/'client-mod/libs/baritone-fabric-26.2.jar'
if not dest.exists():
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary=dest.with_suffix('.download')
    urllib.request.urlretrieve(spec['url'], temporary)
    if hashlib.sha256(temporary.read_bytes()).hexdigest()!=spec['sha256']:
        temporary.unlink(); raise SystemExit('Downloaded Baritone checksum mismatch')
    temporary.replace(dest)
if hashlib.sha256(dest.read_bytes()).hexdigest()!=spec['sha256']:
    raise SystemExit('Installed Baritone checksum mismatch; investigate before replacing it')
print('Pinned Baritone artifact verified')
