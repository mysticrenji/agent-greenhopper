import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

const sourcePath = new URL('../config/plants.yaml', import.meta.url);
const outputPath = new URL('../packages/config/src/plants.generated.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const document = parseDocument(source, { prettyErrors: true, strict: true });

if (document.errors.length > 0) {
  throw new Error(document.errors.map((error) => error.message).join('\n'));
}

function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function formatValue(value, indent = 0) {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);

  const padding = ' '.repeat(indent);
  const nextPadding = ' '.repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${nextPadding}${formatValue(item, indent + 2)},`).join('\n')}\n${padding}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([key, item]) => `${nextPadding}${key}: ${formatValue(item, indent + 2)},`)
    .join('\n')}\n${padding}}`;
}

const output = `// Generated from config/plants.yaml by pnpm config:generate. Do not edit manually.\n\nexport const plantConfiguration = ${formatValue(document.toJS())} as const;\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8');
  if (current !== output) {
    throw new Error('packages/config/src/plants.generated.ts is stale; run pnpm config:generate.');
  }
} else {
  await writeFile(outputPath, output);
}
