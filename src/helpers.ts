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
const inlineKeys = ['code', 'tag', 'autolink', 'escape', 'link', 'reflink', 'nolink', 'emStrongLDelim', 'br', 'delLDelim', 'url', 'text'] as const;
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
export function normalizeLabel(label: string) {
  // The spec also asks for leading and trailing spaces, tabs and line endings
  // to be stripped, and for internal runs of them to collapse to one space.
  // Doing it here keeps every call site in agreement: the definition and the
  // reference have to normalize to the same key.
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
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
export function scanCloserHints(src: string, hints: CloserHints): void {
  let star = -1;
  let underscore = -1;
  let tilde = -1;
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code !== 42 && code !== 95 && code !== 126) {
      i++;
      continue;
    }
    const start = i++;
    while (src.charCodeAt(i) === code) i++;

    if (start === 0) continue;
    const prev = src.charCodeAt(start - 1);
    if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12) continue;
    if (code === 42) {
      star = start;
    } else if (code === 95) {
      underscore = start;
    } else {
      tilde = start;
    }
  }
  hints.star = star;
  hints.underscore = underscore;
  hints.tilde = tilde;
}

export function lastCloser(src: string, delimiter: number): number {
  const hints = { star: -1, underscore: -1, tilde: -1 };
  scanCloserHints(src, hints);
  return delimiter === 42 ? hints.star : delimiter === 95 ? hints.underscore : hints.tilde;
}

const tabPadding = ['', ' ', '  ', '   ', '    '];

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
export function expandBlockquoteTabs(src: string): string {
  let fenceMarker = 0;
  let fenceLength = 0;
  let fenceDepth = Infinity;
  let expanded = '';
  let start = 0;
  const part = { depth: 0, expanded: '', keptIndent: '', content: '' };
  while (start <= src.length) {
    let end = src.indexOf('\n', start);
    if (end === -1) end = src.length;
    if (start !== 0) expanded += '\n';
    splitBlockquoteLine(src, start, end, fenceDepth, part);
    if (fenceDepth !== part.depth) fenceMarker = 0;
    if (fenceMarker) {
      const close = other.blockquoteFenceClose.exec(part.content)?.[1];
      if (!close || close.charCodeAt(0) !== fenceMarker || close.length < fenceLength) {
        expanded += part.keptIndent;
        start = end + 1;
        continue;
      }
      fenceMarker = 0;
      fenceDepth = Infinity;
    } else {
      if (other.blockquoteListItemStart.test(part.content)) return expanded + src.slice(start);
      const open = other.blockquoteFenceOpen.exec(part.content)?.[1];
      if (open) {
        fenceMarker = open.charCodeAt(0);
        fenceLength = open.length;
        fenceDepth = part.depth;
      } else {
        fenceDepth = Infinity;
      }
    }
    expanded += part.expanded;
    start = end + 1;
  }
  return expanded;
}

interface BlockquoteLine {
  depth: number;
  expanded: string;
  keptIndent: string;
  content: string;
}

/**
 * Reads the `>` markers at the start of a line. `expanded` has the tabs in them and in the
 * content's first four columns of indentation expanded, `keptIndent` only the tab that the
 * optional space after the last marker cuts into, and `content` is what follows the markers.
 */
function splitBlockquoteLine(src: string, start: number, end: number, maxDepth: number, part: BlockquoteLine): void {
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
  if (depth === 0) {
    part.expanded = part.keptIndent = part.content = src.slice(start, end);
    return;
  }

  let indent = '';
  let keptIndent = '';
  let code = src.charCodeAt(i);
  while (i < end && (code === 32 || code === 9) && col < contentCol + 4) {
    const added = tabWidth(code, col);
    indent += tabPadding[added];
    keptIndent += col < contentCol && added > 1 ? tabPadding[added] : src[i];
    col += added;
    code = src.charCodeAt(++i);
  }

  const rest = src.slice(i, end);
  part.expanded = prefix + indent + rest;
  part.keptIndent = prefix + keptIndent + rest;
  part.content = ' '.repeat(Math.max(0, col - contentCol)) + rest;
}

/** @hot */
function tabWidth(code: number, col: number): number {
  return code === 9 ? 4 - (col % 4) : 1;
}
