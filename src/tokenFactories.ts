import type { Token, Tokens } from './Tokens.ts';

/** @hotIgnore Output: one space token per call. */
export function createSpace(raw: Tokens.Space['raw']): Tokens.Space {
  return { type: 'space', raw };
}

/** @hotIgnore Output: one hr token per call. */
export function createHr(raw: Tokens.Hr['raw']): Tokens.Hr {
  return { type: 'hr', raw };
}

/** @hotIgnore Output: one heading token per call. */
export function createHeading(raw: Tokens.Heading['raw'], depth: Tokens.Heading['depth'], text: Tokens.Heading['text'], tokens: Tokens.Heading['tokens']): Tokens.Heading {
  return { type: 'heading', raw, depth, text, tokens };
}

/** @hotIgnore Output: one blockquote token per call. */
export function createBlockquote(raw: Tokens.Blockquote['raw'], text: Tokens.Blockquote['text'], tokens: Tokens.Blockquote['tokens']): Tokens.Blockquote {
  return { type: 'blockquote', raw, tokens, text };
}

/** @hotIgnore Output: one list token per call. */
export function createList(raw: Tokens.List['raw'], ordered: Tokens.List['ordered'], start: Tokens.List['start'], loose: Tokens.List['loose'], items: Tokens.List['items']): Tokens.List {
  return { type: 'list', raw, ordered, start, loose, items };
}

/** @hotIgnore Output: one list item token per call. */
export function createListItem(raw: Tokens.ListItem['raw'], task: Tokens.ListItem['task'], loose: Tokens.ListItem['loose'], text: Tokens.ListItem['text'], tokens: Tokens.ListItem['tokens']): Tokens.ListItem {
  return { type: 'list_item', raw, task, loose, text, tokens };
}

/** @hotIgnore Output: one checkbox token per call. */
export function createCheckbox(raw: Tokens.Checkbox['raw'], checked: Tokens.Checkbox['checked']): Tokens.Checkbox {
  return { type: 'checkbox', raw, checked };
}

/** @hotIgnore Output: one paragraph token per call. */
export function createParagraph(raw: Tokens.Paragraph['raw'], text: Tokens.Paragraph['text'], tokens: Tokens.Paragraph['tokens']): Tokens.Paragraph {
  return { type: 'paragraph', raw, text, tokens };
}

/** @hotIgnore Output: one def token per call. */
export function createDef(tag: Tokens.Def['tag'], raw: Tokens.Def['raw'], href: Tokens.Def['href'], title: Tokens.Def['title']): Tokens.Def {
  return { type: 'def', tag, raw, href, title };
}

/** @hotIgnore Output: one table token per call. */
export function createTable(raw: Tokens.Table['raw'], header: Tokens.Table['header'], align: Tokens.Table['align'], rows: Tokens.Table['rows']): Tokens.Table {
  return { type: 'table', raw, header, align, rows };
}

/** @hotIgnore Output: one escape token per call. */
export function createEscape(raw: Tokens.Escape['raw'], text: Tokens.Escape['text']): Tokens.Escape {
  return { type: 'escape', raw, text };
}

/** @hotIgnore Output: one em token per call. */
export function createEm(raw: Tokens.Em['raw'], text: Tokens.Em['text'], tokens: Tokens.Em['tokens']): Tokens.Em {
  return { type: 'em', raw, text, tokens };
}

/** @hotIgnore Output: one strong token per call. */
export function createStrong(raw: Tokens.Strong['raw'], text: Tokens.Strong['text'], tokens: Tokens.Strong['tokens']): Tokens.Strong {
  return { type: 'strong', raw, text, tokens };
}

/** @hotIgnore Output: one codespan token per call. */
export function createCodespan(raw: Tokens.Codespan['raw'], text: Tokens.Codespan['text']): Tokens.Codespan {
  return { type: 'codespan', raw, text };
}

/** @hotIgnore Output: one br token per call. */
export function createBr(raw: Tokens.Br['raw']): Tokens.Br {
  return { type: 'br', raw };
}

/** @hotIgnore Output: one del token per call. */
export function createDel(raw: Tokens.Del['raw'], text: Tokens.Del['text'], tokens: Tokens.Del['tokens']): Tokens.Del {
  return { type: 'del', raw, text, tokens };
}

/** @hotIgnore Output: one table cell token per call. */
export function createTableCell(text: Tokens.TableCell['text'], tokens: Tokens.TableCell['tokens'], header: Tokens.TableCell['header'], align: Tokens.TableCell['align']): Tokens.TableCell {
  return { text, tokens, header, align };
}

/** @hotIgnore Output: one code token per call. */
export function createCode(raw: string, text: string, lang: string | undefined, indented: boolean): Tokens.Code {
  if (indented) return { type: 'code', raw, codeBlockStyle: 'indented', text };
  return { type: 'code', raw, lang, text };
}

export function createHtml(raw: string, pre: boolean, inRawBlock?: undefined): Tokens.HTML;
export function createHtml(raw: string, inLink: boolean, inRawBlock: boolean): Tokens.Tag;
/** @hotIgnore Output: one HTML token per call. */
export function createHtml(raw: string, flag: boolean, inRawBlock: boolean | undefined): Tokens.HTML | Tokens.Tag {
  if (inRawBlock === undefined) return { type: 'html', block: true, raw, pre: flag, text: raw };
  return { type: 'html', raw, inLink: flag, inRawBlock, block: false, text: raw };
}

/** @hotIgnore Output: one text token per call. */
export function createText(raw: string, text: string, detail: Token[] | boolean | undefined): Tokens.Text {
  if (typeof detail === 'boolean') return { type: 'text', raw, text, escaped: detail };
  if (detail) return { type: 'text', raw, text, tokens: detail };
  return { type: 'text', raw, text };
}

/** @hotIgnore Output: one link token per call. */
export function createLink(raw: string, href: string, title: string | null, text: string, tokens: Token[], autolink: boolean): Tokens.Link {
  if (autolink) return { type: 'link', raw, text, href, autolink: true, tokens };
  return { type: 'link', raw, href, title, text, tokens };
}

/** @hotIgnore Output: one image token per call. */
export function createImage(raw: string, href: string, title: string | null, text: string, tokens: Token[]): Tokens.Image {
  return { type: 'image', raw, href, title, text, tokens };
}
