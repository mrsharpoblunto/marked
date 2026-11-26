import type { BlockSource } from './BlockLine.ts';
import { block, inline, noopTest, other } from './rules.ts';

/** @hotIgnore Output: at most one string for each token field. */
export function sourceText(src: string, start: number, end: number): string {
  return start === 0 && end === src.length ? src : src.slice(start, end);
}

/** @hot */
export function blockSourceText(src: BlockSource, start: number, end: number): string {
  return typeof src === 'string' ? sourceText(src, start, end) : src.slice(start, end);
}

/** @hot */
export function isStringWhitespace(code: number): boolean {
  return (code >= 9 && code <= 13) || code === 32 || code === 160 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** @hot */
export function trimStartOffset(src: BlockSource, start: number, end: number): number {
  while (start < end && isStringWhitespace(src.charCodeAt(start))) start++;
  return start;
}

/** @hot */
export function trimEndOffset(src: BlockSource, start: number, end: number): number {
  while (end > start && isStringWhitespace(src.charCodeAt(end - 1))) end--;
  return end;
}

interface CursorRule {
  original: RegExp;
  sticky: RegExp | null;
}

// Rule sets share expressions. Compile each expression once at module setup.
const preparedRules = new WeakMap<RegExp, CursorRule>();

function prepareRule(original: RegExp): CursorRule {
  let rule = preparedRules.get(original);
  if (!rule) {
    let sticky = null;
    if (original !== noopTest) {
      // Remove start anchors while preserving escaped characters and classes.
      const pattern = original.source.replace(/\\.|\[(?:\\.|[^\]\\])*\]|\^/g, part => part === '^' ? '' : part);
      sticky = new RegExp(pattern, original.flags.replace(/[gy]/g, '') + 'y');
    }
    rule = { original, sticky };
    preparedRules.set(original, rule);
  }
  return rule;
}

function prepareRules<K extends string>(keys: readonly K[], rules: Record<K, RegExp>): Record<K, CursorRule> {
  return Object.fromEntries(keys.map(key => [key, prepareRule(rules[key])])) as Record<K, CursorRule>;
}

const blockKeys = ['code', 'fences', 'heading', 'blockquote', 'list', 'hr', 'html', 'def', 'table', 'lheading', 'paragraph', 'text'] as const;
const inlineKeys = ['code', 'tag', 'autolink', 'escape', 'link', 'reflink', 'nolink', 'emStrongLDelim', 'br', 'delLDelim', 'url', 'text', 'punctuation'] as const;
const preparedBlock = {
  normal: prepareRules(blockKeys, block.normal),
  gfm: prepareRules(blockKeys, block.gfm),
  pedantic: prepareRules(blockKeys, block.pedantic),
};

interface CloserRule {
  original: RegExp;
  initial: RegExp;
  next: RegExp;
}

const preparedClosers = new WeakMap<RegExp, CloserRule>();

function prepareCloser(original: RegExp): CloserRule {
  let scan = preparedClosers.get(original);
  if (!scan) {
    const separator = original.source.indexOf('|');
    scan = {
      original,
      initial: new RegExp(original.source.slice(1, separator), 'uy'),
      next: new RegExp(original.source.slice(separator + 1), 'gu'),
    };
    preparedClosers.set(original, scan);
  }
  return scan;
}

function prepareInline(rules: typeof inline.normal) {
  return {
    ...prepareRules(inlineKeys, rules),
    star: prepareCloser(rules.emStrongRDelimAst),
    underscore: prepareCloser(rules.emStrongRDelimUnd),
    tilde: rules.delRDelim === noopTest ? undefined : prepareCloser(rules.delRDelim),
  };
}

const preparedInline = {
  normal: prepareInline(inline.normal),
  gfm: prepareInline(inline.gfm),
  breaks: prepareInline(inline.breaks),
  pedantic: prepareInline(inline.pedantic),
};

const preparedOther = {
  blockquoteStart: prepareRule(other.blockquoteStart),
  listInterruptsParagraph: prepareRule(other.listInterruptsParagraph),
  htmlBegin: prepareRule(other.htmlBeginRegex(4)),
  tableHeader: prepareRule(other.tableHeader),
  textIndentedContinuation: prepareRule(other.textIndentedContinuation),
  unicodeAlphaNumeric: prepareRule(other.unicodeAlphaNumeric),
};

export interface PreparedRules {
  block: typeof preparedBlock.normal;
  inline: typeof preparedInline.normal;
  other: typeof preparedOther;
}

export const preparedLexerRules = {
  normal: { block: preparedBlock.normal, inline: preparedInline.normal, other: preparedOther },
  gfm: { block: preparedBlock.gfm, inline: preparedInline.gfm, other: preparedOther },
  breaks: { block: preparedBlock.gfm, inline: preparedInline.breaks, other: preparedOther },
  pedantic: { block: preparedBlock.pedantic, inline: preparedInline.pedantic, other: preparedOther },
};

/** @hotIgnore User adapter: one source suffix per custom rule call. */
function execUserRule(rule: RegExp, src: BlockSource, offset: number): RegExpExecArray | null {
  return rule.exec(src.slice(offset));
}

/** @hot */
export function execAt(rule: RegExp, src: string, offset: number, prepared: CursorRule | undefined): RegExpExecArray | null {
  if (offset === 0) return rule.exec(src);
  if (prepared?.original !== rule) return execUserRule(rule, src, offset);
  const sticky = prepared.sticky;
  if (!sticky) return null;
  sticky.lastIndex = offset;
  return sticky.exec(src);
}

/** @hot */
export function execBlockRule(rule: RegExp, src: BlockSource, offset: number, prepared: CursorRule | undefined): RegExpExecArray | null {
  return typeof src === 'string' ? execAt(rule, src, offset, prepared) : execUserRule(rule, src, offset);
}

/** @hotIgnore User adapter: one character string per custom rule test. */
function testUserCharacter(rule: RegExp, src: string, offset: number, width: number): boolean {
  return rule.test(src.slice(offset, offset + width));
}

/** @hot */
export function testCharacterAt(rule: RegExp, src: string, offset: number, width: number, prepared: CursorRule | undefined): boolean {
  if (prepared?.original !== rule || !prepared.sticky) return testUserCharacter(rule, src, offset, width);
  prepared.sticky.lastIndex = offset;
  return prepared.sticky.test(src);
}

/** @hotIgnore User adapter: at most two RegExp instances and one record per custom closer rule. */
function prepareUserCloser(rule: RegExp): CloserRule {
  return prepareCloser(rule);
}

/** Start a delimiter scan at the cursor. The first alternative can only match at the start. */
/** @hot */
export function startCloserScan(rule: RegExp, src: string, start: number, prepared: CloserRule | undefined): RegExp {
  const scan = prepared?.original === rule ? prepared : prepareUserCloser(rule);
  scan.initial.lastIndex = start;
  const initial = scan.initial.exec(src);
  scan.next.lastIndex = initial ? scan.initial.lastIndex : start;
  return scan.next;
}

/**
 * Helpers
 */
/** @hot */
function getEscapeReplacement(ch: string): string {
  switch (ch.charCodeAt(0)) {
    case 38: return '&amp;';
    case 60: return '&lt;';
    case 62: return '&gt;';
    case 34: return '&quot;';
    case 39: return '&#39;';
    default: return ch;
  }
}

/** @hot */
export function escapeHtmlEntities(html: string, encode?: boolean) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else {
    if (other.escapeTestNoEncode.test(html)) {
      return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
    }
  }

  return html;
}

/**
 * Numeric character references are recognized outside code and are equivalent to the
 * character they name. Values that are zero, out of range, or a surrogate become the
 * replacement character.
 */
/** @hot */
export function decodeNumericCharacterReferences(text: string) {
  if (!other.numericCharacterReference.test(text)) {
    return text;
  }
  // A decoded character must not join its neighbours into a new reference,
  // so every `&` that is not already one is escaped here.
  return text.replace(other.numericCharacterReferenceOrAmpersand, decodeNumericReference);
}

/** @hot */
function decodeNumericReference(ref: string, dec: string | undefined, hex: string | undefined): string {
  if (dec === undefined && hex === undefined) return '&amp;';
  const code = dec === undefined ? Number.parseInt(hex!, 16) : Number.parseInt(dec, 10);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  return code === 38 ? '&amp;' : String.fromCodePoint(code);
}

export function cleanUrl(href: string) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

/** @hot */
export function splitCells(tableRow: BlockSource, rowStart: number, rowEnd: number, count: number): string[] {
  const cells: string[] = [];
  let start = rowStart;
  let escaped = false;
  let escapedPipe = false;
  for (let i = rowStart; i <= rowEnd; i++) {
    const atEnd = i === rowEnd;
    const code = tableRow.charCodeAt(i);
    if (!atEnd && code === 92) {
      escaped = !escaped;
      continue;
    }
    if (atEnd || (code === 124 && !escaped)) {
      const left = trimStartOffset(tableRow, start, i);
      const right = trimEndOffset(tableRow, left, i);
      if (left < right || (start !== rowStart && !atEnd)) {
        const cell = blockSourceText(tableRow, left, right);
        cells.push(escapedPipe ? cell.replace(other.slashPipe, '|') : cell);
        if (count && cells.length === count) return cells;
      }
      start = i + 1;
      escapedPipe = false;
    } else if (code === 124) {
      escapedPipe = true;
    }
    escaped = false;
  }
  if (count) {
    while (cells.length < count) cells.push('');
  }
  return cells;
}

/** @hot */
export function withoutTrailingNewlines(src: string): string {
  let end = src.length;
  while (src.charCodeAt(end - 1) === 10) end--;
  return sourceText(src, 0, end);
}

/** @hot */
export function trimTrailingBlankLines(str: string) {
  let lineEnd = str.length;
  let blankLines = 0;
  for (let i = lineEnd - 1; i >= 0; i--) {
    const code = str.charCodeAt(i);
    if (code === 10) {
      blankLines++;
      lineEnd = i;
    } else if (code !== 32 && code !== 9) {
      return blankLines > 1 ? sourceText(str, 0, lineEnd) : str;
    }
  }
  return blankLines === 0 ? str : '';
}

/**
 * Normalizes a link label so definitions and references can be matched.
 * CommonMark asks for a Unicode case fold, which `toLowerCase()` does not
 * reach: `ẞ` lowercases to `ß` and so never meets `SS`. Round-tripping
 * through upper case does, as in commonmark.js; the final `toLowerCase()`
 * keeps the folded label lower case, the form `def.tag` has always used.
 */
/** @hot */
export function normalizeLabel(label: string, first = 0, last = label.length): string {
  const start = trimStartOffset(label, first, last);
  const end = trimEndOffset(label, start, last);
  let needsRewrite = false;
  for (let i = start; i < end; i++) {
    const code = label.charCodeAt(i);
    if (code > 127) {
      const text = sourceText(label, start, end);
      return text.replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
    }
    if ((code >= 65 && code <= 90) || (code >= 9 && code <= 13)
      || (code === 32 && label.charCodeAt(i - 1) === 32)) {
      needsRewrite = true;
    }
  }

  if (!needsRewrite) return sourceText(label, start, end);
  let result = '';
  let span = start;
  for (let i = start; i < end; i++) {
    const code = label.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      result += label.slice(span, i);
      result += String.fromCharCode(code + 32);
      span = i + 1;
    } else if (isStringWhitespace(code)) {
      const next = trimStartOffset(label, i + 1, end);
      if (code !== 32 || next !== i + 1) {
        result += label.slice(span, i);
        result += ' ';
        span = next;
      }
      i = next - 1;
    }
  }
  return result + label.slice(span, end);
}

/** @hot */
export function findClosingParen(str: string) {
  // an opening bracket on its own is still unbalanced, so both have to be absent
  if (str.indexOf('(') === -1 && str.indexOf(')') === -1) {
    return -1;
  }

  let level = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 92) {
      i++;
    } else if (code === 40) {
      level++;
    } else if (code === 41) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }

  return -1;
}

export interface CloserHints {
  star: number;
  underscore: number;
  tilde: number;
}

/**
 * Last indexes of `*` / `_` runs that can close emphasis or strong, and of
 * a `~` run that can close strikethrough.
 *
 * A run can close only when it is not preceded by ASCII whitespace or the
 * start of the string. The right-delim regexes accept a closer only in
 * groups 1, 2, 5, and 6, and each of those requires that predecessor. When
 * the opener's window has no such run, the regex scan cannot succeed.
 * Finding one only means "keep looking": CommonMark rules 9–10 and mid-run
 * openers are still applied in the loop (#4099).
 */
/** @hot */
export function scanCloserHints(src: string, hints: CloserHints, masks: number[] | undefined): void {
  let star = -1;
  let underscore = -1;
  let tilde = -1;
  let i = 0;
  let range = 0;
  let maskEnd = -1;
  while (i < src.length) {
    const end = masks?.[range] ?? src.length;
    while (i < end) {
      const code = src.charCodeAt(i);
      if (code !== 42 && code !== 95 && code !== 126) {
        i++;
        continue;
      }
      const start = i++;
      while (i < end && src.charCodeAt(i) === code) i++;

      if (start === 0) continue;
      const prev = start === maskEnd ? 93 : src.charCodeAt(start - 1);
      if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12) continue;
      if (code === 42) {
        star = start;
      } else if (code === 95) {
        underscore = start;
      } else {
        tilde = start;
      }
    }
    if (end === src.length) break;
    i = maskEnd = masks![range + 1];
    range += 2;
  }
  hints.star = star;
  hints.underscore = underscore;
  hints.tilde = tilde;
}

export function lastCloser(src: string, delimiter: number): number {
  const hints = { star: -1, underscore: -1, tilde: -1 };
  scanCloserHints(src, hints, undefined);
  return delimiter === 42 ? hints.star : delimiter === 95 ? hints.underscore : hints.tilde;
}

const tabPadding = ['', ' ', '  ', '   ', '    '];

/** @hot */
export function expandTabs(line: string, indent = 0): string {
  let start = 0;
  let tab = line.indexOf('\t');
  if (tab === -1) return line;

  let col = indent;
  let expanded = '';
  while (tab !== -1) {
    for (let i = start; i < tab; i++) {
      if (line.codePointAt(i)! > 0xffff) i++;
      col++;
    }
    const added = 4 - (col % 4);
    expanded += line.slice(start, tab) + tabPadding[added];
    col += added;
    start = tab + 1;
    tab = line.indexOf('\t', start);
  }
  return expanded + line.slice(start);
}

/**
 * Expands the tabs in block quote markers and the indentation after them to spaces, with tab
 * stops measured from the start of the line. Inside fenced code the indentation is code content,
 * so a tab there stays literal. Lines from the first list item on are returned as is, because
 * the item's columns and the fences inside it are not tracked here.
 */
export function expandBlockquoteTabs(src: BlockSource, first: number, limit: number): string {
  let fenceMarker = 0;
  let fenceLength = 0;
  let fenceDepth = Infinity;
  let expanded = '';
  let start = first;
  const part: BlockquoteLine = {
    depth: 0,
    prefix: '',
    rest: 0,
    indentWidth: 0,
    keptStart: 0,
    keptPadding: 0,
    contentIndent: 0,
  };
  while (start <= limit) {
    let end = src.indexOf('\n', start);
    if (end === -1 || end > limit) end = limit;
    if (start !== first) expanded += '\n';
    splitBlockquoteLine(src, start, end, fenceDepth, part);
    if (fenceDepth !== part.depth) fenceMarker = 0;
    const content = quoteContentStart(src, part.rest, end, part.contentIndent);
    if (fenceMarker) {
      if (src.charCodeAt(content) !== fenceMarker || quoteFenceLength(src, content, end, true) < fenceLength) {
        expanded += part.prefix;
        expanded += ' '.repeat(part.keptPadding);
        expanded += src.slice(part.keptStart, end);
        start = end + 1;
        continue;
      }
      fenceMarker = 0;
      fenceDepth = Infinity;
    } else {
      if (quoteListStarter(src, content, end)) return expanded + src.slice(start, limit);
      const openLength = quoteFenceLength(src, content, end, false);
      if (openLength) {
        fenceMarker = src.charCodeAt(content);
        fenceLength = openLength;
        fenceDepth = part.depth;
      } else {
        fenceDepth = Infinity;
      }
    }
    expanded += part.prefix;
    expanded += ' '.repeat(part.indentWidth);
    expanded += src.slice(part.rest, end);
    start = end + 1;
  }
  return expanded;
}

/** @hot */
function quoteContentStart(src: BlockSource, offset: number, end: number, indent: number): number {
  while (offset < end && src.charCodeAt(offset) === 32 && indent <= 3) {
    offset++;
    indent++;
  }
  return indent <= 3 && offset < end ? offset : -1;
}

/** @hot */
function quoteFenceLength(src: BlockSource, start: number, end: number, closing: boolean): number {
  const marker = src.charCodeAt(start);
  if (marker !== 96 && marker !== 126) return 0;
  let offset = start + 1;
  while (offset < end && src.charCodeAt(offset) === marker) offset++;
  const length = offset - start;
  if (length < 3) return 0;
  if (closing) {
    while (offset < end && (src.charCodeAt(offset) === 32 || src.charCodeAt(offset) === 9)) offset++;
    return offset === end ? length : 0;
  }
  if (marker === 96) {
    const next = src.indexOf('`', offset);
    if (next >= 0 && next < end) return 0;
  }
  return length;
}

/** @hot */
function quoteListStarter(src: BlockSource, start: number, end: number): boolean {
  let offset = start;
  let code = src.charCodeAt(offset);
  if (code !== 42 && code !== 43 && code !== 45) {
    while (offset < end && offset - start < 9 && code >= 48 && code <= 57) code = src.charCodeAt(++offset);
    if (offset === start || (code !== 46 && code !== 41)) return false;
  }
  const next = src.charCodeAt(++offset);
  return offset === end || next === 32 || next === 9;
}

interface BlockquoteLine {
  depth: number;
  prefix: string;
  rest: number;
  indentWidth: number;
  keptStart: number;
  keptPadding: number;
  contentIndent: number;
}

function splitBlockquoteLine(src: BlockSource, start: number, end: number, maxDepth: number, part: BlockquoteLine): void {
  let i = start;
  let col = 0;
  let depth = 0;
  let contentCol = 0;
  let prefix = '';

  while (depth < maxDepth) {
    let j = i;
    let markerCol = col;
    let code = src.charCodeAt(j);
    while (j < end && (code === 32 || code === 9)) {
      markerCol += tabWidth(code, markerCol);
      code = src.charCodeAt(++j);
    }
    if (j === end || code !== 62 || markerCol - contentCol > 3) break;
    prefix += ' '.repeat(markerCol - col) + '>';
    depth++;
    i = j + 1;
    col = markerCol + 1;
    code = src.charCodeAt(i);
    contentCol = code === 32 || code === 9 ? col + 1 : col;
  }

  part.depth = depth;
  part.prefix = prefix;
  part.keptStart = i;
  part.keptPadding = 0;
  part.indentWidth = 0;
  part.contentIndent = 0;

  if (depth > 0) {
    const indentStart = col;
    let code = src.charCodeAt(i);
    while (i < end && (code === 32 || code === 9) && col < contentCol + 4) {
      const added = tabWidth(code, col);
      if (col < contentCol && added > 1) {
        part.keptPadding = added;
        part.keptStart = i + 1;
      }
      col += added;
      code = src.charCodeAt(++i);
    }
    part.indentWidth = col - indentStart;
    part.contentIndent = Math.max(0, col - contentCol);
  }
  part.rest = i;
}

/** @hot */
function tabWidth(code: number, col: number): number {
  return code === 9 ? 4 - (col % 4) : 1;
}
