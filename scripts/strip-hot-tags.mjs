import { readFileSync, writeFileSync } from 'node:fs';

const file = 'lib/marked.d.ts';
const types = readFileSync(file, 'utf8');
writeFileSync(file, types.replace(/^[ \t]*\/\*\* @hot(?:Ignore\b[^\n]*?)? \*\/\n/gm, ''));
