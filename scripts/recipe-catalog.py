#!/usr/bin/env python3
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
source = root / '.cache/gradle/caches/fabric-loom/26.2/minecraft-common.jar'
with zipfile.ZipFile(source) as archive:
    names = set(archive.namelist())

    def ingredient(value, visiting=()):
        if isinstance(value, list):
            return sorted(set(item for entry in value for item in ingredient(entry, visiting)))
        if not isinstance(value, str):
            return []
        if not value.startswith('#'):
            return [value]
        if value in visiting:
            return []
        namespace, tag = value[1:].split(':', 1)
        path = f'data/{namespace}/tags/item/{tag}.json'
        if path not in names:
            return []
        entries = json.loads(archive.read(path))['values']
        return sorted(set(item for entry in entries for item in ingredient(entry, (*visiting, value))))

    recipes = []
    unsupported = []
    for path in sorted(names):
        if not path.startswith('data/minecraft/recipe/') or not path.endswith('.json'):
            continue
        recipe = json.loads(archive.read(path))
        kind = recipe.get('type')
        if kind not in ('minecraft:crafting_shaped', 'minecraft:crafting_shapeless'):
            unsupported.append(path)
            continue
        if kind.endswith('shaped'):
            pattern = recipe['pattern']
            slots = [ingredient(recipe['key'][symbol]) if symbol != ' ' else [] for row in pattern for symbol in row]
            if any(not ingredient(recipe['key'][symbol]) for row in pattern for symbol in row if symbol != ' '):
                unsupported.append(path)
                continue
            width, height = max(map(len, pattern)), len(pattern)
        else:
            slots = [ingredient(entry) for entry in recipe['ingredients']]
            width, height = (2, 2) if len(slots) <= 4 else (3, 3)
        result = recipe.get('result', {})
        if not result.get('id') or result.get('components') or any(not slot for slot in slots if kind.endswith('shapeless')):
            unsupported.append(path)
            continue
        recipes.append({'id': 'minecraft:' + pathlib.PurePosixPath(path).stem,
                        'output': result['id'], 'count': result.get('count', 1),
                        'station': 'inventory' if width <= 2 and height <= 2 else 'crafting_table',
                        'slots': [slot for slot in slots if slot]})
    output = root / 'config/recipes-26.2.json'
    output.write_text(json.dumps({'version': '26.2', 'source': 'vanilla game jar; server datapacks may differ',
                                  'recipes': recipes, 'unsupported': unsupported}, separators=(',', ':')) + '\n')
    print(f'Exported {len(recipes)} recipes; {len(unsupported)} unsupported recipe types')
