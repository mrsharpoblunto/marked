import { defineConfig } from '@thestraylight/so-hot-right-now';

export default defineConfig({
  include: ['src/**'],
  roots: [
    { kind: 'method', owner: { name: '_Lexer' }, methods: ['lex', 'lexInline'], label: 'lexer' },
    { kind: 'method', owner: { name: '_Parser' }, methods: ['parse', 'parseInline'], label: 'parser' },
  ],
});
