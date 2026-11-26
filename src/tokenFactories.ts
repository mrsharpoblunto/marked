import { setTokenKind, TokenKind } from './tokenKind.ts';
import type { Token, Tokens } from './Tokens.ts';

/** @hotIgnore Output: one space token per call. */
export function createSpace(raw: Tokens.Space['raw']): Tokens.Space {
  return setTokenKind({ type: 'space', raw }, TokenKind.Space);
}

/** @hotIgnore Output: one hr token per call. */
export function createHr(raw: Tokens.Hr['raw']): Tokens.Hr {
  return setTokenKind({ type: 'hr', raw }, TokenKind.Hr);
}

/** @hotIgnore Output: one heading token per call. */
export function createHeading(raw: Tokens.Heading['raw'], depth: Tokens.Heading['depth'], text: Tokens.Heading['text'], tokens: Tokens.Heading['tokens']): Tokens.Heading {
  return setTokenKind({ type: 'heading', raw, depth, text, tokens }, TokenKind.Heading);
}

/** @hotIgnore Output: one blockquote token per call. */
export function createBlockquote(raw: Tokens.Blockquote['raw'], text: Tokens.Blockquote['text'], tokens: Tokens.Blockquote['tokens']): Tokens.Blockquote {
  return setTokenKind({ type: 'blockquote', raw, tokens, text }, TokenKind.Blockquote);
}

/** @hotIgnore Output: one list token per call. */
export function createList(raw: Tokens.List['raw'], ordered: Tokens.List['ordered'], start: Tokens.List['start'], loose: Tokens.List['loose'], items: Tokens.List['items']): Tokens.List {
  return setTokenKind({ type: 'list', raw, ordered, start, loose, items }, TokenKind.List);
}

/** @hotIgnore Output: one list item token per call. */
export function createListItem(raw: Tokens.ListItem['raw'], task: Tokens.ListItem['task'], loose: Tokens.ListItem['loose'], text: Tokens.ListItem['text'], tokens: Tokens.ListItem['tokens']): Tokens.ListItem {
  return setTokenKind({ type: 'list_item', raw, task, loose, text, tokens }, TokenKind.ListItem);
}

/** @hotIgnore Output: one checkbox token per call. */
export function createCheckbox(raw: Tokens.Checkbox['raw'], checked: Tokens.Checkbox['checked']): Tokens.Checkbox {
  return setTokenKind({ type: 'checkbox', raw, checked }, TokenKind.Checkbox);
}

/** @hotIgnore Output: one paragraph token per call. */
export function createParagraph(raw: Tokens.Paragraph['raw'], text: Tokens.Paragraph['text'], tokens: Tokens.Paragraph['tokens']): Tokens.Paragraph {
  return setTokenKind({ type: 'paragraph', raw, text, tokens }, TokenKind.Paragraph);
}

/** @hotIgnore Output: one def token per call. */
export function createDef(tag: Tokens.Def['tag'], raw: Tokens.Def['raw'], href: Tokens.Def['href'], title: Tokens.Def['title']): Tokens.Def {
  return setTokenKind({ type: 'def', tag, raw, href, title }, TokenKind.Def);
}

/** @hotIgnore Output: one table token per call. */
export function createTable(raw: Tokens.Table['raw'], header: Tokens.Table['header'], align: Tokens.Table['align'], rows: Tokens.Table['rows']): Tokens.Table {
  return setTokenKind({ type: 'table', raw, header, align, rows }, TokenKind.Table);
}

/** @hotIgnore Output: one escape token per call. */
export function createEscape(raw: Tokens.Escape['raw'], text: Tokens.Escape['text']): Tokens.Escape {
  return setTokenKind({ type: 'escape', raw, text }, TokenKind.Escape);
}

/** @hotIgnore Output: one em token per call. */
export function createEm(raw: Tokens.Em['raw'], text: Tokens.Em['text'], tokens: Tokens.Em['tokens']): Tokens.Em {
  return setTokenKind({ type: 'em', raw, text, tokens }, TokenKind.Em);
}

/** @hotIgnore Output: one strong token per call. */
export function createStrong(raw: Tokens.Strong['raw'], text: Tokens.Strong['text'], tokens: Tokens.Strong['tokens']): Tokens.Strong {
  return setTokenKind({ type: 'strong', raw, text, tokens }, TokenKind.Strong);
}

/** @hotIgnore Output: one codespan token per call. */
export function createCodespan(raw: Tokens.Codespan['raw'], text: Tokens.Codespan['text']): Tokens.Codespan {
  return setTokenKind({ type: 'codespan', raw, text }, TokenKind.Codespan);
}

/** @hotIgnore Output: one br token per call. */
export function createBr(raw: Tokens.Br['raw']): Tokens.Br {
  return setTokenKind({ type: 'br', raw }, TokenKind.Br);
}

/** @hotIgnore Output: one del token per call. */
export function createDel(raw: Tokens.Del['raw'], text: Tokens.Del['text'], tokens: Tokens.Del['tokens']): Tokens.Del {
  return setTokenKind({ type: 'del', raw, text, tokens }, TokenKind.Del);
}

/** @hotIgnore Output: one table cell token per call. */
export function createTableCell(text: Tokens.TableCell['text'], tokens: Tokens.TableCell['tokens'], header: Tokens.TableCell['header'], align: Tokens.TableCell['align']): Tokens.TableCell {
  return { text, tokens, header, align };
}

/** @hotIgnore Output: one code token per call. */
export function createCode(raw: string, text: string, lang: string | undefined, indented: boolean): Tokens.Code {
  if (indented) return setTokenKind({ type: 'code', raw, codeBlockStyle: 'indented', text }, TokenKind.Code);
  return setTokenKind({ type: 'code', raw, lang, text }, TokenKind.Code);
}

export function createHtml(raw: string, pre: boolean, inRawBlock?: undefined): Tokens.HTML;
export function createHtml(raw: string, inLink: boolean, inRawBlock: boolean): Tokens.Tag;
/** @hotIgnore Output: one HTML token per call. */
export function createHtml(raw: string, flag: boolean, inRawBlock: boolean | undefined): Tokens.HTML | Tokens.Tag {
  if (inRawBlock === undefined) return setTokenKind({ type: 'html', block: true, raw, pre: flag, text: raw }, TokenKind.Html);
  return setTokenKind({ type: 'html', raw, inLink: flag, inRawBlock, block: false, text: raw }, TokenKind.Html);
}

/** @hotIgnore Output: one text token per call. */
export function createText(raw: string, text: string, detail: Token[] | boolean | undefined): Tokens.Text {
  if (typeof detail === 'boolean') return setTokenKind({ type: 'text', raw, text, escaped: detail }, TokenKind.Text);
  if (detail) return setTokenKind({ type: 'text', raw, text, tokens: detail }, TokenKind.Text);
  return setTokenKind({ type: 'text', raw, text }, TokenKind.Text);
}

/** @hotIgnore Output: one link token per call. */
export function createLink(raw: string, href: string, title: string | null, text: string, tokens: Token[], autolink: boolean): Tokens.Link {
  if (autolink) return setTokenKind({ type: 'link', raw, text, href, autolink: true, tokens }, TokenKind.Link);
  return setTokenKind({ type: 'link', raw, href, title, text, tokens }, TokenKind.Link);
}

/** @hotIgnore Output: one image token per call. */
export function createImage(raw: string, href: string, title: string | null, text: string, tokens: Token[]): Tokens.Image {
  return setTokenKind({ type: 'image', raw, href, title, text, tokens }, TokenKind.Image);
}
