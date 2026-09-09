#!/usr/bin/env python3
"""Install a dedicated normal-launcher profile. Run with Minecraft Launcher closed."""
import datetime, hashlib, json, pathlib, shutil, os
root=pathlib.Path(__file__).resolve().parent.parent
minecraft=pathlib.Path.home()/'Library/Application Support/minecraft'
manifest=json.loads((root/'.cache/fabric-profile.json').read_text())
assert manifest['id']=='fabric-loader-0.19.5-26.2' and manifest['inheritsFrom']=='26.2'
profile_file=minecraft/'launcher_profiles.json'
original=profile_file.read_bytes(); profiles=json.loads(original)
instance=root/'runtime/realm-client'
mods=instance/'mods';mods.mkdir(parents=True,exist_ok=True)
api=list((root/'.cache/gradle/caches/modules-2/files-2.1/net.fabricmc.fabric-api/fabric-api/0.159.0+26.2').glob('*/*.jar'))
assert len(api)==1, 'Build first to resolve Fabric API'
for src in [root/'client-mod/build/libs/windove-bridge-0.1.0.jar',root/'client-mod/libs/baritone-fabric-26.2.jar',api[0]]:
    assert src.exists(), str(src)
    shutil.copy2(src, mods/src.name)
version_dir=minecraft/'versions'/manifest['id'];version_dir.mkdir(parents=True,exist_ok=True)
version_file=version_dir/(manifest['id']+'.json')
version_file.write_text(json.dumps(manifest,indent=2)+'\n')
key='windove-mvp-26-2'
existing=profiles.setdefault('profiles',{}).get(key)
if existing and existing.get('gameDir')!=str(instance):raise SystemExit('Profile key occupied; refusing overwrite')
profiles['profiles'][key]={'name':'Windove MVP 26.2','type':'custom','lastVersionId':manifest['id'],'gameDir':str(instance),'icon':'Grass','javaArgs':'-Xmx4G -XX:+UseG1GC'}
backup=root/'runtime/launcher-backups';backup.mkdir(parents=True,exist_ok=True)
backup_file=backup/(datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-launcher_profiles.json')
backup_file.write_bytes(original);backup_file.chmod(0o600)
assert profile_file.read_bytes()==original, 'Launcher changed profiles while installing; retry with it closed'
temporary=profile_file.with_suffix('.windove.tmp');temporary.write_text(json.dumps(profiles,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(profile_file)
print('Installed Windove MVP 26.2 in the normal launcher. Microsoft authentication is supplied by the launcher.')
print('Instance:',instance)
print('Mods:',', '.join(p.name for p in mods.glob('*.jar')))
