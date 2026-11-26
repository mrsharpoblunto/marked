import { TokenKind } from './tokenKind.ts';
import type { Token, Tokens } from './Tokens.ts';

/** @hotIgnore Output: one space token per call. */
export function createSpace(raw: Tokens.Space['raw']): Tokens.Space {
  return { type: 'space', raw, kind: TokenKind.Space };
}

/** @hotIgnore Output: one hr token per call. */
export function createHr(raw: Tokens.Hr['raw']): Tokens.Hr {
  return { type: 'hr', raw, kind: TokenKind.Hr };
}

/** @hotIgnore Output: one heading token per call. */
export function createHeading(raw: Tokens.Heading['raw'], depth: Tokens.Heading['depth'], text: Tokens.Heading['text'], tokens: Tokens.Heading['tokens']): Tokens.Heading {
  return { type: 'heading', raw, depth, text, tokens, kind: TokenKind.Heading };
}

/** @hotIgnore Output: one blockquote token per call. */
export function createBlockquote(raw: Tokens.Blockquote['raw'], text: Tokens.Blockquote['text'], tokens: Tokens.Blockquote['tokens']): Tokens.Blockquote {
  return { type: 'blockquote', raw, tokens, text, kind: TokenKind.Blockquote };
}

/** @hotIgnore Output: one list token and one item array per call. */
export function createList(raw: Tokens.List['raw'], ordered: Tokens.List['ordered'], start: Tokens.List['start'], loose: Tokens.List['loose']): Tokens.List {
  return { type: 'list', raw, ordered, start, loose, items: [], kind: TokenKind.List };
}

/** @hotIgnore Output: one list item token and one child array per call. */
export function createListItem(raw: Tokens.ListItem['raw'], task: Tokens.ListItem['task'], loose: Tokens.ListItem['loose'], text: Tokens.ListItem['text']): Tokens.ListItem {
  return { type: 'list_item', raw, task, loose, text, tokens: [], kind: TokenKind.ListItem };
}

/** @hotIgnore Output: one checkbox token per call. */
export function createCheckbox(raw: Tokens.Checkbox['raw'], checked: Tokens.Checkbox['checked']): Tokens.Checkbox {
  return { type: 'checkbox', raw, checked, kind: TokenKind.Checkbox };
}

/** @hotIgnore Output: one paragraph token per call. */
export function createParagraph(raw: Tokens.Paragraph['raw'], text: Tokens.Paragraph['text'], tokens: Tokens.Paragraph['tokens']): Tokens.Paragraph {
  return { type: 'paragraph', raw, text, tokens, kind: TokenKind.Paragraph };
}

/** @hotIgnore Output: one def token per call. */
export function createDef(tag: Tokens.Def['tag'], raw: Tokens.Def['raw'], href: Tokens.Def['href'], title: Tokens.Def['title']): Tokens.Def {
  return { type: 'def', tag, raw, href, title, kind: TokenKind.Def };
}

/** @hotIgnore Output: one table token and two arrays per call. */
export function createTable(raw: Tokens.Table['raw'], align: Tokens.Table['align']): Tokens.Table {
  return { type: 'table', raw, header: [], align, rows: [], kind: TokenKind.Table };
}

/** @hotIgnore Output: one escape token per call. */
export function createEscape(raw: Tokens.Escape['raw'], text: Tokens.Escape['text']): Tokens.Escape {
  return { type: 'escape', raw, text, kind: TokenKind.Escape };
}

/** @hotIgnore Output: one em token per call. */
export function createEm(raw: Tokens.Em['raw'], text: Tokens.Em['text'], tokens: Tokens.Em['tokens']): Tokens.Em {
  return { type: 'em', raw, text, tokens, kind: TokenKind.Em };
}

/** @hotIgnore Output: one strong token per call. */
export function createStrong(raw: Tokens.Strong['raw'], text: Tokens.Strong['text'], tokens: Tokens.Strong['tokens']): Tokens.Strong {
  return { type: 'strong', raw, text, tokens, kind: TokenKind.Strong };
}

/** @hotIgnore Output: one codespan token per call. */
export function createCodespan(raw: Tokens.Codespan['raw'], text: Tokens.Codespan['text']): Tokens.Codespan {
  return { type: 'codespan', raw, text, kind: TokenKind.Codespan };
}

/** @hotIgnore Output: one br token per call. */
export function createBr(raw: Tokens.Br['raw']): Tokens.Br {
  return { type: 'br', raw, kind: TokenKind.Br };
}

/** @hotIgnore Output: one del token per call. */
export function createDel(raw: Tokens.Del['raw'], text: Tokens.Del['text'], tokens: Tokens.Del['tokens']): Tokens.Del {
  return { type: 'del', raw, text, tokens, kind: TokenKind.Del };
}

/** @hotIgnore Output: one table cell token per call. */
export function createTableCell(text: Tokens.TableCell['text'], tokens: Tokens.TableCell['tokens'], header: Tokens.TableCell['header'], align: Tokens.TableCell['align']): Tokens.TableCell {
  return { text, tokens, header, align };
}

/** @hotIgnore Output: one code token per call. */
export function createCode(raw: string, text: string, lang: string | undefined, indented: boolean): Tokens.Code {
  if (indented) return { type: 'code', raw, codeBlockStyle: 'indented', text, kind: TokenKind.Code };
  return { type: 'code', raw, lang, text, kind: TokenKind.Code };
}

export function createHtml(raw: string, pre: boolean, inRawBlock?: undefined): Tokens.HTML;
export function createHtml(raw: string, inLink: boolean, inRawBlock: boolean): Tokens.Tag;
/** @hotIgnore Output: one HTML token per call. */
export function createHtml(raw: string, flag: boolean, inRawBlock: boolean | undefined): Tokens.HTML | Tokens.Tag {
  if (inRawBlock === undefined) return { type: 'html', block: true, raw, pre: flag, text: raw, kind: TokenKind.Html };
  return { type: 'html', raw, inLink: flag, inRawBlock, block: false, text: raw, kind: TokenKind.Html };
}

/** @hotIgnore Output: one text token per call. */
export function createText(raw: string, text: string, detail: Token[] | boolean | undefined): Tokens.Text {
  if (typeof detail === 'boolean') return { type: 'text', raw, text, escaped: detail, kind: TokenKind.Text };
  if (detail) return { type: 'text', raw, text, tokens: detail, kind: TokenKind.Text };
  return { type: 'text', raw, text, kind: TokenKind.Text };
}

export const LinkPrefix = { None: 0, Email: 1, Http: 2 } as const;

/** @hotIgnore Output: one link token. An autolink adds one text token, one child array, and at most one URL string. */
export function createLink(raw: string, href: string, title: string | null, text: string, tokens: Token[] | undefined, prefix: number): Tokens.Link {
  if (!tokens) {
    if (prefix === LinkPrefix.Email) href = 'mailto:' + href;
    if (prefix === LinkPrefix.Http) href = 'http://' + href;
    return { type: 'link', raw, text, href, autolink: true, tokens: [createText(text, text, undefined)], kind: TokenKind.Link };
  }
  return { type: 'link', raw, href, title, text, tokens, kind: TokenKind.Link };
}

/** @hotIgnore Output: one image token per call. */
export function createImage(raw: string, href: string, title: string | null, text: string, tokens: Token[]): Tokens.Image {
  return { type: 'image', raw, href, title, text, tokens, kind: TokenKind.Image };
}
