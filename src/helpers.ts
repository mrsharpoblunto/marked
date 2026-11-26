import { block, inline, noopTest, other } from './rules.ts';

/** @hotIgnore Output: at most one string for each token field. */
export function sourceText(src: string, start: number, end: number): string {
  return start === 0 && end === src.length ? src : src.slice(start, end);
}

/** @hot */
export function isStringWhitespace(code: number): boolean {
  return (code >= 9 && code <= 13) || code === 32 || code === 160 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** @hot */
export function trimStartOffset(src: string, start: number, end: number): number {
  while (start < end && isStringWhitespace(src.charCodeAt(start))) start++;
  return start;
}

/** @hot */
export function trimEndOffset(src: string, start: number, end: number): number {
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
function execUserRule(rule: RegExp, src: string, offset: number): RegExpExecArray | null {
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
export function splitCells(tableRow: string, rowStart: number, rowEnd: number, count: number): string[] {
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
        const cell = sourceText(tableRow, left, right);
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

const unicodeDelimiterPunctuation = /[\p{P}\p{S}]/uy;

export function delimiterClass(src: string, offset: number, tildeIsWord: boolean): number {
  if (offset < 0 || offset >= src.length) return 0;
  const code = src.charCodeAt(offset);
  if (code <= 127) {
    if (code === 32 || (code >= 9 && code <= 13)) return 0;
    if (tildeIsWord && code === 126) return 2;
    return (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
      || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)
      ? 1
      : 2;
  }
  if (isStringWhitespace(code)) return 0;
  unicodeDelimiterPunctuation.lastIndex = offset;
  return unicodeDelimiterPunctuation.test(src) ? 1 : 2;
}

export interface InlineRuns {
  entries: Int32Array;
  length: number;
  gfm: boolean;
  source: string;
  masks: number[];
  share: boolean;
}

export function inlineRunAt(runs: InlineRuns, offset: number): number {
  let first = 0;
  let end = runs.length / 5;
  while (first < end) {
    const middle = (first + end) >> 1;
    if (runs.entries[middle * 5] < offset) first = middle + 1;
    else end = middle;
  }
  return first * 5;
}

export function scanWindowHints(runs: InlineRuns, start: number, end: number, hints: CloserHints): void {
  hints.star = -1;
  hints.underscore = -1;
  hints.tilde = -1;
  const entries = runs.entries;
  for (let i = inlineRunAt(runs, end) - 5; i >= 0 && entries[i] > start; i -= 5) {
    const offset = entries[i];
    const prev = runs.source.charCodeAt(offset - 1);
    if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12) continue;
    const code = entries[i + 2];
    if (code === 42 && hints.star < 0) hints.star = offset;
    else if (code === 95 && hints.underscore < 0) hints.underscore = offset;
    else if (code === 126 && hints.tilde < 0) hints.tilde = offset;
    if (hints.star >= 0 && hints.underscore >= 0 && hints.tilde >= 0) break;
  }
}

function addInlineRun(runs: InlineRuns, src: string, start: number, end: number, code: number, before: number, after: number) {
  const index = runs.length;
  if (index + 5 > runs.entries.length) {
    const expanded = new Int32Array(Math.max(40, runs.entries.length * 2));
    expanded.set(runs.entries);
    runs.entries = expanded;
  }
  const tildeIsWord = code === 42 && runs.gfm;
  const entries = runs.entries;
  entries[index] = start;
  entries[index + 1] = end - start;
  entries[index + 2] = code;
  entries[index + 3] = before < 0 ? 1 : delimiterClass(src, before, tildeIsWord);
  entries[index + 4] = after < 0 ? 1 : delimiterClass(src, after, tildeIsWord);
  runs.length += 5;
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
  scanInlineRuns(src, hints, masks, undefined);
}

export function scanInlineRuns(src: string, hints: CloserHints, masks: number[] | undefined, runs: InlineRuns | undefined): void {
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

      if (runs) {
        const unit = src.charCodeAt(start - 1);
        const width = unit >= 0xdc00 && unit <= 0xdfff && src.codePointAt(start - 2)! > 0xffff ? 2 : 1;
        addInlineRun(runs, src, start, i, code, start === maskEnd ? -1 : start - width, i !== src.length && i === end ? -1 : i);
      }
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

/** @hot */
export function tabSegments(src: string, first: number, end: number, column: number, segments: number[]): void {
  const tab = src.indexOf('\t', first);
  if (tab < 0 || tab >= end) {
    segments.push(first, end, 0);
    return;
  }
  let span = first;
  let padding = 0;
  for (let i = first; i < end; i++) {
    if (src.charCodeAt(i) === 9) {
      segments.push(span, i, padding);
      padding = 4 - (column & 3);
      column += padding;
      span = i + 1;
    } else {
      if (src.codePointAt(i)! > 0xffff) i++;
      column++;
    }
  }
  segments.push(span, end, padding);
}

/** @hot */
export function scanQuoteTabs(src: string, first: number, limit: number, segments: number[],
  appendQuoteSegments: (src: string, first: number, end: number, segments: number[], followsNewline: boolean) => void): void {
  let fenceMarker = 0;
  let fenceLength = 0;
  let fenceDepth = Infinity;
  const part = { depth: 0, firstColumn: 0, rest: 0, indentWidth: 0, keptStart: 0, keptPadding: 0, contentIndent: 0 };
  for (let start = first; start <= limit;) {
    let end = src.indexOf('\n', start);
    if (end === -1 || end > limit) end = limit;
    if (start !== first) segments.push(start - 1, start, 0);
    const before = segments.length;
    scanQuoteIndent(src, start, end, fenceDepth, part, segments);
    if (fenceDepth !== part.depth) fenceMarker = 0;
    const content = quoteContentStart(src, part.rest, end, part.contentIndent);
    let kept = false;
    if (fenceMarker) {
      kept = src.charCodeAt(content) !== fenceMarker || quoteFenceLength(src, content, end, true) < fenceLength;
      if (!kept) {
        fenceMarker = 0;
        fenceDepth = Infinity;
      }
    } else {
      if (quoteListStarter(src, content, end)) {
        segments.length = before;
        appendQuoteSegments(src, start, limit, segments, start !== first);
        return;
      }
      const openLength = quoteFenceLength(src, content, end, false);
      if (openLength) {
        fenceMarker = src.charCodeAt(content);
        fenceLength = openLength;
        fenceDepth = part.depth;
      } else {
        fenceDepth = Infinity;
      }
    }
    let rest = kept ? part.keptStart : part.rest;
    let padding = kept ? part.keptPadding : part.indentWidth;
    if (part.depth === 0) {
      appendQuoteSegments(src, start, end, segments, start !== first);
    } else {
      if (part.depth === 1) {
        if (padding) padding--;
        else if (src.charCodeAt(rest) === 32) rest++;
        else if (src.charCodeAt(rest) === 9) {
          let column = part.firstColumn;
          while (rest < end && (src.charCodeAt(rest) === 32 || src.charCodeAt(rest) === 9)) {
            column += tabWidth(src.charCodeAt(rest++), column);
          }
          padding = column - part.firstColumn - 1;
        }
      }
      let tail = rest;
      while (tail < end) {
        const code = src.charCodeAt(tail++);
        if (code === 13 || code === 0x2028 || code === 0x2029) break;
      }
      segments.push(rest, tail, padding);
      if (tail < end) appendQuoteSegments(src, tail, end, segments, false);
    }
    start = end + 1;
  }
}

/** @hot */
function quoteContentStart(src: string, offset: number, end: number, indent: number): number {
  while (offset < end && src.charCodeAt(offset) === 32 && indent <= 3) {
    offset++;
    indent++;
  }
  return indent <= 3 && offset < end ? offset : -1;
}

/** @hot */
function quoteFenceLength(src: string, start: number, end: number, closing: boolean): number {
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
function quoteListStarter(src: string, start: number, end: number): boolean {
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
  firstColumn: number;
  rest: number;
  indentWidth: number;
  keptStart: number;
  keptPadding: number;
  contentIndent: number;
}

/** @hot */
function scanQuoteIndent(src: string, start: number, end: number, maxDepth: number, part: BlockquoteLine, segments: number[]): void {
  let i = start;
  let col = 0;
  let depth = 0;
  let contentCol = 0;

  while (depth < maxDepth) {
    let j = i;
    let markerCol = col;
    let code = src.charCodeAt(j);
    while (j < end && (code === 32 || code === 9)) {
      markerCol += tabWidth(code, markerCol);
      code = src.charCodeAt(++j);
    }
    if (j === end || code !== 62 || markerCol - contentCol > 3) break;
    if (depth === 0) part.firstColumn = markerCol + 1;
    else segments.push(j, j + 1, Math.max(0, markerCol - col - (depth === 1 ? 1 : 0)));
    depth++;
    i = j + 1;
    col = markerCol + 1;
    code = src.charCodeAt(i);
    contentCol = code === 32 || code === 9 ? col + 1 : col;
  }

  part.depth = depth;
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
