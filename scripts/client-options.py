#!/usr/bin/env python3
"""Set instance options the harness depends on. Run with this instance's Minecraft closed.

pauseOnLostFocus:true is why switching to the agent terminal opens the game menu,
which the bridge treats as human takeover and cancels the running action.
"""
import pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parent.parent
instance = root / 'runtime/realm-client'
options = instance / 'options.txt'
wanted = {'pauseOnLostFocus': 'false', 'autoJump': 'false'}

running = [l for l in subprocess.run(['ps', '-axo', 'command='], capture_output=True, text=True).stdout.splitlines()
           if str(instance) in l and 'java' in l]
if running:
    sys.exit(f'{instance.name} is running; Minecraft rewrites options.txt when it exits.\n'
             'Press F3+P in game to toggle pause-on-lost-focus now, or quit the client and rerun this script.')
if not options.exists():
    sys.exit(f'No options.txt yet at {options}; launch the instance once first.')

lines = options.read_text().splitlines()
seen, out = set(), []
for line in lines:
    key = line.split(':', 1)[0]
    if key in wanted:
        seen.add(key)
        out.append(f'{key}:{wanted[key]}')
    else:
        out.append(line)
out += [f'{k}:{v}' for k, v in wanted.items() if k not in seen]
options.write_text('\n'.join(out) + '\n')
print('Set', ', '.join(f'{k}={v}' for k, v in wanted.items()), 'in', options)
