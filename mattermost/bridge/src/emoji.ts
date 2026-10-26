import { readFileSync } from 'node:fs';

// Table générée au build (scripts/build-emoji.mjs) à partir d'emoji-datasource,
// la même source que celle utilisée par Mattermost pour ses noms d'emoji.
const table = JSON.parse(readFileSync(new URL('./emoji.json', import.meta.url), 'utf8')) as {
  names: Record<string, string>;
  unicode: Record<string, string>;
};

const VARIATION_SELECTOR = /️/g;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/gu;

/** 👍 → "+1" (nom Mattermost) */
export function unicodeToName(emoji: string): string | undefined {
  const key = emoji.replace(VARIATION_SELECTOR, '');
  return table.unicode[key] ?? table.unicode[key.replace(SKIN_TONE, '')];
}

/** "+1" → 👍 */
export function nameToUnicode(name: string): string | undefined {
  return table.names[name.toLowerCase()];
}

export function sameEmoji(a: string, b: string): boolean {
  return a.replace(VARIATION_SELECTOR, '') === b.replace(VARIATION_SELECTOR, '');
}

/** Remplace les codes :smile: de Mattermost par l'emoji Unicode, que Discord affiche tel quel. */
export function replaceShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (match, name: string) => nameToUnicode(name) ?? match);
}
