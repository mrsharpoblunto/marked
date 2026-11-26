import type { Token } from './Tokens.ts';

export const TokenKind = {
  Space: 1,
  Hr: 2,
  Heading: 3,
  Code: 4,
  Table: 5,
  Blockquote: 6,
  List: 7,
  Checkbox: 8,
  Html: 9,
  Def: 10,
  Paragraph: 11,
  Text: 12,
  Escape: 13,
  Link: 14,
  Image: 15,
  Strong: 16,
  Em: 17,
  Codespan: 18,
  Br: 19,
  Del: 20,
  ListItem: 21,
} as const;

/** @hotIgnore User adapter: maps a public token type to a kind without allocating. */
export function tokenKind(token: Token): number {
  switch (token.type) {
    case 'space': return TokenKind.Space;
    case 'hr': return TokenKind.Hr;
    case 'heading': return TokenKind.Heading;
    case 'code': return TokenKind.Code;
    case 'table': return TokenKind.Table;
    case 'blockquote': return TokenKind.Blockquote;
    case 'list': return TokenKind.List;
    case 'checkbox': return TokenKind.Checkbox;
    case 'html': return TokenKind.Html;
    case 'def': return TokenKind.Def;
    case 'paragraph': return TokenKind.Paragraph;
    case 'text': return TokenKind.Text;
    case 'escape': return TokenKind.Escape;
    case 'link': return TokenKind.Link;
    case 'image': return TokenKind.Image;
    case 'strong': return TokenKind.Strong;
    case 'em': return TokenKind.Em;
    case 'codespan': return TokenKind.Codespan;
    case 'br': return TokenKind.Br;
    case 'del': return TokenKind.Del;
    case 'list_item': return TokenKind.ListItem;
    default: return 0;
  }
}
