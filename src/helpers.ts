import { noopTest, other } from './rules.ts';

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

const cursorRules = new WeakMap<RegExp, RegExp>();

/** @hotIgnore User adapter: one source suffix per custom rule call. */
function execUserRule(rule: RegExp, src: string, offset: number): RegExpExecArray | null {
  return rule.exec(src.slice(offset));
}

export function execAt(rule: RegExp, src: string, offset: number): RegExpExecArray | null {
  if (offset === 0) return rule.exec(src);
  let sticky = cursorRules.get(rule);
  if (!sticky) {
    if (rule === noopTest) return null;
    if (typeof rule.source !== 'string' || rule.exec !== RegExp.prototype.exec) return execUserRule(rule, src, offset);
    // Remove start anchors while preserving escaped characters and classes.
    const pattern = rule.source.replace(/\\.|\[(?:\\.|[^\]\\])*\]|\^/g, part => part === '^' ? '' : part);
    sticky = new RegExp(pattern, rule.flags.replace(/[gy]/g, '') + 'y');
    cursorRules.set(rule, sticky);
  }
  sticky.lastIndex = offset;
  return sticky.exec(src);
}

const closerRules = new WeakMap<RegExp, { initial: RegExp, next: RegExp }>();

/** Start a delimiter scan at the cursor. The first alternative can only match at the start. */
export function startCloserScan(rule: RegExp, src: string, start: number): RegExp {
  let scan = closerRules.get(rule);
  if (!scan) {
    const separator = rule.source.indexOf('|');
    scan = {
      initial: new RegExp(rule.source.slice(1, separator), 'uy'),
      next: new RegExp(rule.source.slice(separator + 1), 'gu'),
    };
    closerRules.set(rule, scan);
  }
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

export function expandTabs(line: string, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }

  return expanded;
}

/**
 * Expands the tabs in block quote markers and the indentation after them to spaces, with tab
 * stops measured from the start of the line. Inside fenced code the indentation is code content,
 * so a tab there stays literal. Lines from the first list item on are returned as is, because
 * the item's columns and the fences inside it are not tracked here.
 */
export function expandBlockquoteTabs(lines: string[]) {
  let fence: { marker: string, depth: number } | undefined;
  let inListItem = false;
  return lines.map((line) => {
    if (inListItem) {
      return line;
    }
    const { depth, expanded, keptIndent, content } = splitBlockquoteLine(line, fence?.depth ?? Infinity);
    if (fence?.depth !== depth) {
      fence = undefined;
    }
    if (fence) {
      const close = other.blockquoteFenceClose.exec(content)?.[1];
      if (!close || close[0] !== fence.marker[0] || close.length < fence.marker.length) {
        return keptIndent;
      }
      fence = undefined;
      return expanded;
    }
    inListItem = other.blockquoteListItemStart.test(content);
    if (inListItem) {
      return line;
    }
    const open = other.blockquoteFenceOpen.exec(content)?.[1];
    if (open) {
      fence = { marker: open, depth };
    }
    return expanded;
  }).join('\n');
}

/**
 * Reads the `>` markers at the start of a line. `expanded` has the tabs in them and in the
 * content's first four columns of indentation expanded, `keptIndent` only the tab that the
 * optional space after the last marker cuts into, and `content` is what follows the markers.
 */
function splitBlockquoteLine(line: string, maxDepth: number) {
  let i = 0;
  let col = 0;
  let depth = 0;
  let contentCol = 0;
  let prefix = '';

  while (depth < maxDepth) {
    let j = i;
    let markerCol = col;
    while (line[j] === ' ' || line[j] === '\t') {
      markerCol += tabWidth(line[j], markerCol);
      j++;
    }
    if (line[j] !== '>' || markerCol - contentCol > 3) {
      break;
    }
    prefix += ' '.repeat(markerCol - col) + '>';
    depth++;
    i = j + 1;
    col = markerCol + 1;
    contentCol = line[i] === ' ' || line[i] === '\t' ? col + 1 : col;
  }

  if (depth === 0) {
    return { depth, expanded: line, keptIndent: line, content: line };
  }

  let indent = '';
  let keptIndent = '';
  while ((line[i] === ' ' || line[i] === '\t') && col < contentCol + 4) {
    const added = tabWidth(line[i], col);
    indent += ' '.repeat(added);
    keptIndent += col < contentCol && added > 1 ? ' '.repeat(added) : line[i];
    col += added;
    i++;
  }

  const rest = line.slice(i);
  return {
    depth,
    expanded: prefix + indent + rest,
    keptIndent: prefix + keptIndent + rest,
    content: ' '.repeat(Math.max(0, col - contentCol)) + rest,
  };
}

function tabWidth(char: string, col: number) {
  return char === '\t' ? 4 - (col % 4) : 1;
}
