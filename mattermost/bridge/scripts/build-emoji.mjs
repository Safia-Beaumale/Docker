// Génère dist/emoji.json : correspondance nom Mattermost ⇄ emoji Unicode.
// Exécuté uniquement dans le stage de build : emoji-datasource (~30 Mo)
// n'est pas embarqué dans l'image finale.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const list = JSON.parse(readFileSync(require.resolve('emoji-datasource/emoji.json'), 'utf8'));

const toChars = (unified) =>
  unified
    .split('-')
    .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .join('');

const names = {};
const unicode = {};
for (const emoji of list) {
  const chars = toChars(emoji.unified);
  for (const name of emoji.short_names) names[name] ??= chars;
  unicode[chars.replace(/️/g, '')] ??= emoji.short_name;
}

mkdirSync('dist', { recursive: true });
writeFileSync('dist/emoji.json', JSON.stringify({ names, unicode }));
console.log(`emoji.json : ${Object.keys(names).length} noms, ${Object.keys(unicode).length} emoji`);
