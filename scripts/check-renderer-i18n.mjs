import fs from 'node:fs';

const htmlPaths = ['desktop/renderer/index.html'];
const i18nPath = 'desktop/renderer/i18n.js';
const htmlDocuments = htmlPaths.map((file) => ({ file, html: fs.readFileSync(file, 'utf8') }));
const i18n = fs.readFileSync(i18nPath, 'utf8');
const app = fs.readFileSync('desktop/renderer/app.js', 'utf8');
const rendererScripts = [
  { file: 'desktop/renderer/app.js', source: app },
];

const hasHan = (value) => /[\u3400-\u9fff]/u.test(value);
const catalog = new Set(
  [...i18n.matchAll(/['"]([^'"]*[\u3400-\u9fff][^'"]*)['"]/gu)].map((match) => match[1].trim()),
);
const keyedNames = new Set([...i18n.matchAll(/['"]([\w.-]+)['"]\s*:\s*\[/gu)].map((match) => match[1]));
const failures = [];

// Keep this check dependency-free: the renderer is intentionally offline and
// does not ship a DOM parser just for build-time validation.
const allTextChunks = [];
for (const { file, html } of htmlDocuments) {
  const withoutIgnoredTags = html
    .replace(/<(script|style|textarea)[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/giu, '$1');
  const textChunks = [...withoutIgnoredTags.matchAll(/>([^<>]+)</gu)]
    .map((match) => match[1].replace(/\s+/gu, ' ').trim())
    .filter(hasHan);
  allTextChunks.push(...textChunks);
  for (const value of new Set(textChunks)) {
    if (!catalog.has(value)) failures.push(`${file}: HTML text is missing from i18n catalog: ${value}`);
  }
  for (const match of html.matchAll(/\b(?:placeholder|title|aria-label|data-help)="([^"]*[\u3400-\u9fff][^"]*)"/gu)) {
    const value = match[1].trim();
    if (!catalog.has(value)) failures.push(`${file}: HTML attribute is missing from i18n catalog: ${value}`);
  }
  for (const match of html.matchAll(/\bdata-i18n="([\w.-]+)"/gu)) {
    if (!keyedNames.has(match[1])) failures.push(`${file}: Unknown data-i18n key: ${match[1]}`);
  }
}

if (/MutationObserver/gu.test(i18n)) failures.push('Renderer i18n must not use MutationObserver');
if (/TryCloudflare · \{url\} ·/u.test(i18n)) failures.push('Optional tunnel URL interpolation must own its leading separator');
if (!/i18n\.apply\(document\)/u.test(app)) {
  failures.push('Renderer must apply translations after dynamic rendering');
}

// Inspect every quoted argument inside t(...), including conditional calls
// such as t(condition ? 'key.a' : 'key.b'). This keeps both branches in sync.
for (const { file, source } of rendererScripts) {
  for (const match of source.matchAll(/\bt\(\s*([^\n)]*)\)/gu)) {
    for (const keyMatch of match[1].matchAll(/['"]([\w-]+\.[\w.-]+)['"]/gu)) {
      if (!keyedNames.has(keyMatch[1])) failures.push(`Unknown i18n key referenced by ${file}: ${keyMatch[1]}`);
    }
  }
}
if (/localizedText\(\s*t\(/u.test(app)) failures.push('Keyed translations must not be passed through localizedText');
if (/localizedText\(\s*(?:state\.)?\b(?:endpoint|workspace|path|publicUrl)\b/u.test(app)) {
  failures.push('URLs, paths, and Workspace data must not be passed to localizedText');
}

if (failures.length) {
  console.error(`Renderer i18n check failed (${failures.length} issue(s))`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Renderer i18n check passed (${new Set(allTextChunks).size} HTML text chunks checked across ${htmlPaths.length} files)`);
