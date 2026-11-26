import { blockContentStart, blockIndent, blockIndentEnd, blockLineEnd, thematicBreakEnd } from './BlockLine.ts';
import { TokenKind } from './tokenKind.ts';
import {
  createBlockquote, createBr, createCheckbox, createCode, createCodespan,
  createDef, createDel, createEm, createEscape, createHeading, createHr,
  createHtml, createImage, createLink, createList, createListItem, createParagraph,
  createSpace, createStrong, createTable, createTableCell, createText, LinkPrefix,
} from './tokenFactories.ts';
import { _defaults } from './defaults.ts';
import {
  withoutTrailingNewlines,
  splitCells,
  findClosingParen,
  expandTabs,
  expandBlockquoteTabs,
  normalizeLabel,
  decodeNumericCharacterReferences,
  trimTrailingBlankLines,
  execAt,
  testCharacterAt,
  sourceText,
  trimStartOffset,
  trimEndOffset,
  isStringWhitespace,
  startCloserScan,
  lastCloser,
} from './helpers.ts';
import { block, inline, other, paragraphHtmlStart, type Rules } from './rules.ts';
import type { _Lexer } from './Lexer.ts';
import type { Links, Tokens, Token } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/** @hot */
function punctuationBeforeDelimiter(src: string, offset: number, width: number, rules: Rules): boolean {
  if (offset < 0 || offset >= src.length) return false;
  const code = src.charCodeAt(offset);
  if (code <= 127) {
    if (code === 42 || code === 95) return width === 1;
    return (code >= 9 && code <= 13) || (code >= 32 && code <= 47) || (code >= 58 && code <= 64)
      || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
  }
  return testCharacterAt(rules.inline.punctuation, src, offset, width, rules.cursor?.inline.punctuation);
}

/** @hot */
function alphaNumericAt(src: string, offset: number, width: number, rules: Rules): boolean {
  const code = src.charCodeAt(offset);
  if (code <= 127 && width === 1) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  return testCharacterAt(rules.other.unicodeAlphaNumeric, src, offset, width, rules.cursor?.other.unicodeAlphaNumeric);
}

/**
 * Remove the bracket escapes that the label match consumed, but leave code
 * spans untouched: their content is literal, so a `\[` or `\]` inside a
 * code span is not an escape.
 */
/** @hot */
function unescapeLinkLabel(label: string, rules: Rules): string {
  if (label.indexOf('\\') === -1) return label;
  let start = 0;
  let result = '';
  for (let i = 0; i < label.length; i++) {
    const first = label.charCodeAt(i);
    if (first === 96) {
      const code = execAt(rules.inline.code, label, i, rules.cursor?.inline.code);
      if (code) i += code[0].length - 1;
    } else if (first === 92) {
      const next = label.charCodeAt(i + 1);
      if (next === 91 || next === 93) {
        result += label.slice(start, i);
        start = ++i;
      }
    }
  }
  return start === 0 ? label : result + label.slice(start);
}

/** @hot */
function outputLink(cap: string[], href: string, linkTitle: string | null | undefined, raw: string, lexer: _Lexer, rules: Rules): Tokens.Link | Tokens.Image | undefined {
  const title = linkTitle || null;
  const text = unescapeLinkLabel(cap[1], rules);
  const isImage = cap[0].charCodeAt(0) === 33;

  const outerInLink = lexer.state.inLink;
  const outerLinkEmitted = lexer.state.linkEmitted;
  const outerInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const textHasLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = outerLinkEmitted;
  lexer.state.inLink = outerInLink;

  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of nesting."
    // Bail so the caller falls through to text and the inner link is the one kept.
    // Images are exempt: their text is flattened into an alt attribute.
    if (textHasLink) {
      // these tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text that is re-scanned
      lexer.state.inRawBlock = outerInRawBlock;
      return;
    }
    lexer.state.linkEmitted = true;
  }

  return isImage ? createImage(raw, href, title, text, tokens) : createLink(raw, href, title, text, tokens, LinkPrefix.None);
}

/** @hot */
function indentCodeCompensation(raw: string, text: string, canExpandTabs: boolean): string {
  const indent = skipSpaces(raw, 3);
  const marker = raw.charCodeAt(indent);
  if (indent === 0 || (marker !== 96 && marker !== 126)
    || raw.charCodeAt(indent + 1) !== marker || raw.charCodeAt(indent + 2) !== marker) return text;

  let result = '';
  let copyStart = 0;
  let start = 0;
  while (start < text.length) {
    let next = start;
    let padding = 0;
    while (next - start < indent) {
      const code = text.charCodeAt(next);
      if (code === 32) {
        next++;
      } else if (code === 9) {
        if (canExpandTabs) {
          next++;
          padding = 4 - indent;
          break;
        }
        if (marker === 126) {
          next = start;
          break;
        }
        next++;
      } else {
        break;
      }
    }
    if (next > start) {
      result += text.slice(copyStart, start);
      if (padding) result += ' '.repeat(padding);
      copyStart = next;
    }
    const end = text.indexOf('\n', next);
    if (end < 0) break;
    start = end + 1;
  }
  return copyStart === 0 ? text : result + text.slice(copyStart);
}

/** @hot */
function isLabelEndInsideToken(src: string, label: string, labelStart: number, rules: Rules) {
  if (!label.includes('<')) {
    return false;
  }

  for (let i = 0; i < label.length; i++) {
    const first = label.charCodeAt(i);
    if (first === 92) {
      i++;
      continue;
    }

    if (first === 96) {
      const code = execAt(rules.inline.code, label, i, rules.cursor?.inline.code);
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }

    if (first !== 60) {
      continue;
    }

    const token = execAt(rules.inline.tag, src, labelStart + i, rules.cursor?.inline.tag)
      || execAt(rules.inline.autolink, src, labelStart + i, rules.cursor?.inline.autolink);
    if (!token) {
      continue;
    }

    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

const standardQuotePrefix = other.blockquoteSetextReplace2;
const standardListNesting = other.listReplaceNesting;
const standardIsTask = other.listIsTask;
const standardReplaceTask = other.listReplaceTask;
const standardTaskCheckbox = other.listTaskCheckbox;
const standardListRule = block.normal.list;
const standardListInterrupt = other.listInterruptsParagraph;
const standardListHr = other.hrRegex;
const standardNestedMarkers = other.nestedBlockMarker;
const standardContainerMarkers = other.nestedContainerMarkers;
const standardDefRule = block.normal.def;
const pedanticDefRule = block.pedantic.def;
const standardQuoteRule = block.normal.blockquote;
const standardCodeRule = block.normal.code;
const standardFenceRule = block.normal.fences;
const noFenceRule = block.pedantic.fences;
const standardHeadingRule = block.normal.heading;
const pedanticHeadingRule = block.pedantic.heading;
const standardHrRule = block.normal.hr;
const standardTextRule = block.normal.text;
const standardTextContinuation = other.textIndentedContinuation;
const standardCodeIndent = other.codeRemoveIndent;
const commonMarkParagraphRule = block.normal.paragraph;
const gfmParagraphRule = block.gfm.paragraph;
const pedanticParagraphRule = block.pedantic.paragraph;

const htmlInterrupt = new RegExp(paragraphHtmlStart.source, 'y');
const standardSetextRule = block.normal.lheading;
const gfmSetextRule = block.gfm.lheading;
const pedanticSetextRule = block.pedantic.lheading;
const standardTableHeader = other.tableHeader;
const standardTableRule = block.gfm.table;
const noTableRule = block.normal.table;

/** @hot */
function headingMarkerEnd(src: string, start: number, pedantic: boolean): number {
  if (src.charCodeAt(start) !== 35) return start;
  let end = start + 1;
  while (end - start < 6 && src.charCodeAt(end) === 35) end++;
  return pedantic || end === src.length || isStringWhitespace(src.charCodeAt(end)) ? end : start;
}

/** @hot */
function fenceMarkerEnd(src: string, start: number): number {
  const marker = src.charCodeAt(start);
  let end = start;
  while (src.charCodeAt(end) === marker) end++;
  return end;
}

/** @hot */
function codeBlockEnd(src: string, offset: number): number {
  let end = offset;
  while (end < src.length) {
    const indent = blockIndentEnd(src, end);
    if (indent === end || indent === src.length || src.charCodeAt(indent) === 10) break;
    end = blockLineEnd(src, indent);
    if (end === src.length) break;
    end++;
    while (end < src.length) {
      const content = blockContentStart(src, end);
      if (content === src.length) return content;
      if (src.charCodeAt(content) !== 10) break;
      end = content + 1;
    }
  }
  return end;
}

/** @hot */
function stripCodeIndent(src: string, start: number, end: number): string {
  let out = '';
  let copyStart = start;
  for (let line = start; line < end; line = blockLineEnd(src, line) + 1) {
    let stripped = line;
    while (stripped - line < 4 && src.charCodeAt(stripped) === 32) stripped++;
    if (stripped - line < 4 && src.charCodeAt(stripped) === 9) stripped++;
    if (stripped === line) continue;
    out += sourceText(src, copyStart, line);
    copyStart = stripped;
  }
  return out + sourceText(src, copyStart, end);
}

/** @hot */
function setextTableDelimiter(src: string, start: number): boolean {
  let pipe = false;
  for (let i = start; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code === 124) pipe = true;
    else if (code === 10) return pipe;
    else if (code !== 32 && code !== 58 && code !== 45) return false;
  }
  return false;
}

/** @hot */
function setextInterrupts(src: string, start: number, gfm: boolean, first: boolean): boolean {
  let marker = start;
  let code = src.charCodeAt(start);
  if (code === 32) {
    do code = src.charCodeAt(++marker); while (code === 32 && marker - start < 4);
  }
  if (marker - start === 4 || code === 9) return first;
  switch (code) {
    case 62: return true;
    case 35: return headingMarkerEnd(src, marker, false) !== marker;
    case 96:
    case 126: return src.charCodeAt(marker + 1) === code && src.charCodeAt(marker + 2) === code;
    case 60:
      htmlInterrupt.lastIndex = start;
      return htmlInterrupt.test(src);
    case 45:
    case 95:
    case 42:
      if (!first && thematicBreakEnd(src, marker) >= 0) return true;
      if (code === 95) return false;
      break;
    case 43: break;
    case 124:
    case 58: return gfm && setextTableDelimiter(src, marker);
    default:
      if (code < 48 || code > 57 || marker === src.length) return false;
  }
  const bullet = firstListMarkerEnd(src, start);
  if (bullet && src.charCodeAt(start + bullet) === 32) return true;
  return code === 45 && gfm && setextTableDelimiter(src, marker);
}

/** @hot */
function setextUnderlineStart(src: string, start: number, pedantic: boolean): number {
  let marker = start;
  while (marker - start < 3 && src.charCodeAt(marker) === 32) marker++;
  const code = src.charCodeAt(marker);
  if (code !== 45 && code !== 61) return -1;
  let end = marker + 1;
  while (src.charCodeAt(end) === code) end++;
  let tail = src.charCodeAt(end);
  while (tail === 32 || tail === 9) {
    if (pedantic && tail === 9) return -1;
    tail = src.charCodeAt(++end);
  }
  return end === src.length || tail === 10 ? marker : -1;
}

/** @hot */
function setextTextEnd(src: string, start: number, gfm: boolean, pedantic: boolean): number {
  let end = lineEnd(src, start);
  if (end === start || end === src.length) return -1;
  if (!pedantic && setextInterrupts(src, start, gfm, true)) return -1;
  while (end < src.length) {
    const line = end + 1;
    const code = src.charCodeAt(line) | 32;
    if (!pedantic && code >= 97 && code <= 122) {
      end = lineEnd(src, line);
      continue;
    }
    if (setextUnderlineStart(src, line, pedantic) >= 0) {
      for (let i = start; i < end; i++) {
        const code = src.charCodeAt(i);
        if (code === 13 || code === 0x2028 || code === 0x2029) return -1;
      }
      return end;
    }
    if (pedantic || setextInterrupts(src, line, gfm, false)) return -1;
    let blank = line;
    while (blank < src.length && isStringWhitespace(src.charCodeAt(blank))) {
      if (src.charCodeAt(blank++) === 10) return -1;
    }
    end = lineEnd(src, line);
  }
  return -1;
}

/** @hot */
function tableDelimiterEnd(src: string, start: number): number {
  let pos = start;
  while (pos - start < 3 && src.charCodeAt(pos) === 32) pos++;
  if (src.charCodeAt(pos) === 124) {
    while (src.charCodeAt(++pos) === 32) { /* skip spaces after the pipe */ }
  }
  for (;;) {
    if (src.charCodeAt(pos) === 58) pos++;
    const dash = pos;
    while (src.charCodeAt(pos) === 45) pos++;
    if (pos === dash) return -1;
    if (src.charCodeAt(pos) === 58) pos++;
    while (src.charCodeAt(pos) === 32) pos++;
    if (src.charCodeAt(pos) !== 124) return pos === src.length || src.charCodeAt(pos) === 10 ? pos : -1;
    while (src.charCodeAt(++pos) === 32) { /* skip spaces after the pipe */ }
    if (pos === src.length || src.charCodeAt(pos) === 10) return pos;
  }
}

/** @hot */
function tableHeaderContent(src: string, start: number, end: number): number {
  while (src.charCodeAt(start) === 32) start++;
  if (start === end) return -1;
  for (let i = start + 1; i < end; i++) {
    const code = src.charCodeAt(i);
    if (code === 13 || code === 0x2028 || code === 0x2029) return -1;
  }
  return start;
}

/** @hot */
function tableBodyEnd(src: string, first: number): number {
  let start = first;
  while (start < src.length) {
    let content = start;
    while (src.charCodeAt(content) === 32) content++;
    const marker = src.charCodeAt(content);
    if (marker === 10) break;
    const indent = blockIndentEnd(src, start);
    if (indent !== start && indent < src.length && src.charCodeAt(indent) !== 10) break;
    if (content - start < 4) {
      if (marker === 62 || (marker === 35 && headingMarkerEnd(src, content, false) !== content)) break;
      if ((marker === 45 || marker === 42 || marker === 95) && thematicBreakEnd(src, content) >= 0) break;
      if (marker === 60) {
        htmlInterrupt.lastIndex = start;
        if (htmlInterrupt.test(src)) break;
      }
      if ((marker === 96 || marker === 126) && src.charCodeAt(content + 1) === marker && src.charCodeAt(content + 2) === marker) {
        let tail = fenceMarkerEnd(src, content);
        while (tail < src.length && src.charCodeAt(tail) !== 10 && src.charCodeAt(tail) !== 96) tail++;
        if (marker === 126 || tail === src.length || src.charCodeAt(tail) === 10) break;
      }
      const bullet = firstListMarkerEnd(src, start);
      const after = src.charCodeAt(start + bullet);
      if (bullet && (marker === 45 || marker === 42 || marker === 43
        || (marker === 49 && bullet - (content - start) === 2)) && (after === 32 || after === 9)) break;
    }
    const end = blockLineEnd(src, start);
    for (let i = start; i < end; i++) {
      const code = src.charCodeAt(i);
      if (code === 13 || code === 0x2028 || code === 0x2029) return start;
    }
    start = Math.min(end + 1, src.length);
  }
  return start;
}

/** @hot */
function definitionLabelEnd(src: string, start: number, pedantic: boolean): number {
  let pos = start;
  let nonSpace = pedantic;
  while (pos < src.length) {
    const code = src.charCodeAt(pos);
    if (code === 93) return pos > start && nonSpace ? pos : -1;
    if (!pedantic) {
      if (code === 91) return -1;
      if (code === 92) {
        pos += 2;
        nonSpace = true;
        continue;
      }
      if (code === 10 && src.charCodeAt(blockContentStart(src, pos + 1)) === 10) return -1;
      if (!isStringWhitespace(code)) nonSpace = true;
    }
    pos++;
  }
  return -1;
}

/** @hot */
function angleDestinationEnd(src: string, start: number): number {
  for (let pos = start + 1; pos < src.length; pos++) {
    const code = src.charCodeAt(pos);
    if (code === 62) return pos + 1;
    if (code === 60 || code === 10) return -1;
    if (code === 92) {
      const escaped = src.charCodeAt(++pos);
      if (escaped === 10 || escaped === 13 || escaped === 0x2028 || escaped === 0x2029) return -1;
    }
  }
  return -1;
}

/** @hot */
function definitionTitleEnd(src: string, start: number): number {
  const opener = src.charCodeAt(start);
  if (opener !== 34 && opener !== 39 && opener !== 40) return -1;
  const closer = opener === 40 ? 41 : opener;
  for (let pos = start + 1; pos < src.length; pos++) {
    const code = src.charCodeAt(pos);
    if (code === closer) return pos + 1;
    if (code === 92) pos++;
    else if (code === 40 && opener === 40) return -1;
    else if (code === 10 && opener === 39 && src.charCodeAt(pos + 1) === 10) return -1;
  }
  return -1;
}

/** @hot */
function definitionLineEnd(src: string, offset: number): number {
  while (src.charCodeAt(offset) === 32) offset++;
  return offset === src.length || src.charCodeAt(offset) === 10 ? offset : -1;
}

/** @hot */
function pedanticTitleEnd(src: string, start: number): number {
  const opener = src.charCodeAt(start);
  if (opener !== 34 && opener !== 40) return -1;
  let end = blockLineEnd(src, start);
  while (src.charCodeAt(end - 1) === 32) end--;
  const closer = src.charCodeAt(end - 1);
  return end - start > 2 && (closer === 34 || closer === 41) ? end : -1;
}

/** @hot */
function paragraphEnd(src: string, offset: number, pedantic: boolean, gfm: boolean, inQuote = false): number {
  let end = blockLineEnd(src, offset);
  while (end < src.length) {
    const start = end + 1;
    if (start === src.length || src.charCodeAt(start) === 10) break;
    const content = blockContentStart(src, start);
    const marker = src.charCodeAt(content);
    if (marker === 10) break;
    const spaces = content - start;
    const atBlockStart = spaces < 4 && blockIndent(src, start, content) < 4;
    if (atBlockStart) {
      if (marker === 62) break;
      if ((marker === 42 || marker === 45 || marker === 95) && thematicBreakEnd(src, content) >= 0) break;
    }
    if (marker === 35) {
      let hashEnd = content + 1;
      while (hashEnd - content < 6 && src.charCodeAt(hashEnd) === 35) hashEnd++;
      const after = src.charCodeAt(hashEnd);
      if (pedantic
        ? src.charCodeAt(content - 1) !== 9 && (hashEnd > content + 1 || (hashEnd < src.length && after !== 10))
        : atBlockStart && (hashEnd === src.length || isStringWhitespace(after))) break;
    }
    if (pedantic) {
      if (setextTextEnd(src, start, false, false) >= 0) break;
    } else if (atBlockStart) {
      if (marker === 60) {
        htmlInterrupt.lastIndex = start;
        if (htmlInterrupt.test(src)) break;
      }
      if ((marker === 96 || marker === 126)
        && src.charCodeAt(content + 1) === marker && src.charCodeAt(content + 2) === marker) {
        if (marker === 126) break;
        let rest = content + 3;
        while (src.charCodeAt(rest) === 96) rest++;
        while (rest < src.length && src.charCodeAt(rest) !== 10 && src.charCodeAt(rest) !== 96) rest++;
        if (rest === src.length || src.charCodeAt(rest) === 10) break;
      }
      if (inQuote && firstListMarkerEnd(src, start)) break;
      let bulletEnd = content;
      if (marker === 42 || marker === 43 || marker === 45) bulletEnd++;
      else if (marker === 49 && (src.charCodeAt(content + 1) === 46 || src.charCodeAt(content + 1) === 41)) bulletEnd += 2;
      if (bulletEnd !== content && (src.charCodeAt(bulletEnd) === 32 || src.charCodeAt(bulletEnd) === 9)) {
        const first = blockContentStart(src, bulletEnd);
        if (first < src.length && src.charCodeAt(first) !== 10) break;
      }
    }
    const lineEnd = blockLineEnd(src, content);
    if (gfm && lineEnd < src.length) {
      const next = blockContentStart(src, lineEnd + 1);
      const delimiter = src.charCodeAt(next);
      if (delimiter === 45 || delimiter === 58 || delimiter === 124) {
        if (tableDelimiterEnd(src, lineEnd + 1) >= 0 && tableHeaderContent(src, start, lineEnd) >= 0) break;
      }
    }
    end = lineEnd;
  }
  return end;
}

/** @hot */
function quotedBlockEnd(src: string, offset: number): number {
  let line = offset;
  let marker = quoteMarkerAt(src, line);
  while (marker >= 0) {
    let content = marker + 1;
    if (src.charCodeAt(content) === 32) content++;
    const first = blockContentStart(src, content);
    const blank = first === src.length || src.charCodeAt(first) === 10;
    const indented = line === offset && src.charCodeAt(content) === 32
      && src.charCodeAt(content + 1) === 32 && src.charCodeAt(content + 2) === 32 && src.charCodeAt(content + 3) === 32;
    const end = blank || indented ? blockLineEnd(src, content) : paragraphEnd(src, content, false, false, true);
    if (end === src.length) return end;
    line = end + 1;
    marker = quoteMarkerAt(src, line);
  }
  return line;
}

/** @hot */
function firstListMarkerEnd(src: string, offset: number): number {
  let end = offset;
  while (end < offset + 3 && src.charCodeAt(end) === 32) end++;

  let code = src.charCodeAt(end);
  if (code !== 42 && code !== 43 && code !== 45) {
    const start = end;
    while (code >= 48 && code <= 57 && end - start < 9) {
      code = src.charCodeAt(++end);
    }
    if (end === start || (code !== 46 && code !== 41)) return 0;
  }

  const next = src.charCodeAt(++end);
  return end === src.length || next === 9 || next === 10 || next === 32 ? end - offset : 0;
}

/** @hot */
function listInterruptsParagraph(src: string, start: number, after: number): boolean {
  if (after <= start) return false;
  let pos = start;
  while (src.charCodeAt(pos) === 32) pos++;
  const marker = src.charCodeAt(pos);
  if (marker !== 42 && marker !== 43 && marker !== 45 && (marker !== 49 || after - pos !== 2)) return false;
  if (src.charCodeAt(after) !== 32 && src.charCodeAt(after) !== 9) return false;
  const content = blockContentStart(src, after);
  return content < src.length && src.charCodeAt(content) !== 10;
}

/** @hot */
function listHasHr(src: string, start: number, maxIndent: number): boolean {
  let marker = start;
  while (marker - start < maxIndent && src.charCodeAt(marker) === 32) marker++;
  const code = src.charCodeAt(marker);
  return (code === 45 || code === 42 || code === 95) && thematicBreakEnd(src, marker) >= 0;
}

/** @hot */
function nestedMarkerEnd(src: string, start: number, multi: boolean): number {
  let marker = start;
  while (marker - start < 3 && src.charCodeAt(marker) === 32) marker++;
  if (src.charCodeAt(marker) === 62) {
    const next = src.charCodeAt(marker + 1);
    return next === 32 || (multi && next === 9) ? marker + 2 : marker + 1;
  }
  const length = firstListMarkerEnd(src, start);
  if (!length) return start;
  const end = start + length;
  const after = src.charCodeAt(end);
  if (multi) return after === 32 || after === 9 ? blockContentStart(src, end) : start;
  return after === 32 ? end + 1 : end === src.length ? end : start;
}

/** @hot */
function lineHasFence(src: string, start: number): boolean {
  const markerAt = start + skipSpacesAt(src, start, 3);
  const marker = src.charCodeAt(markerAt);
  if (marker !== 96 && marker !== 126) return false;
  let end = fenceMarkerEnd(src, markerAt);
  if (end - markerAt < 3) return false;
  if (marker === 126) return true;
  while (end < src.length && src.charCodeAt(end) !== 96) end++;
  return end === src.length;
}

/** @hot */
function skipSpacesAt(src: string, start: number, maximum: number): number {
  let end = start;
  while (end - start < maximum && src.charCodeAt(end) === 32) end++;
  return end - start;
}

/** @hot */
function listMarkerEnd(src: string, offset: number, marker: number, ordered: boolean, pedantic: boolean): number {
  let end = offset;
  while (end < offset + 3 && src.charCodeAt(end) === 32) end++;

  if (ordered) {
    const start = end;
    let code = src.charCodeAt(end);
    while (code >= 48 && code <= 57 && end - start < 9) {
      code = src.charCodeAt(++end);
    }
    if (end === start || code !== marker) return 0;
  } else {
    const code = src.charCodeAt(end);
    if (pedantic ? code !== 42 && code !== 43 && code !== 45 : code !== marker) return 0;
  }

  end++;
  const next = src.charCodeAt(end);
  return end === src.length || next === 9 || next === 10 || next === 32 ? end - offset : 0;
}

/** @hot */
function lineEnd(src: string, start: number): number {
  const end = src.indexOf('\n', start);
  return end === -1 ? src.length : end;
}

/** @hot */
function commonMarkTextEnd(src: string, offset: number): number {
  if (src.length === offset) return offset;

  let end = offset + 1;
  if (src.charCodeAt(offset) === 96) {
    while (src.charCodeAt(end) === 96) end++;
  }

  while (end < src.length) {
    const code = src.charCodeAt(end);
    if (code === 92 || code === 60 || code === 33 || code === 91
      || code === 96 || code === 42 || code === 95) {
      break;
    }
    if (code === 32 && src.charCodeAt(end + 1) === 32) {
      let next = end + 2;
      while (src.charCodeAt(next) === 32) next++;
      if (src.charCodeAt(next) === 10) break;
      end = next;
    } else {
      end++;
    }
  }
  return end;
}

/** @hot */
function isEscapedAt(src: string, offset: number): boolean {
  let start = offset;
  while (src.charCodeAt(start - 1) === 92) start--;
  return (offset - start) % 2 !== 0;
}

/** @hot */
function hasTableDelimiter(src: string, start = 0, end = src.length): boolean {
  for (let i = start; i < end; i++) {
    const code = src.charCodeAt(i);
    if (code === 58 || code === 124) return true;
  }
  return false;
}

/** @hotIgnore Output: one alignment array with one entry per column. */
function tableAlignments(src: string, start = 0, end = src.length): Tokens.Table['align'] {
  const alignment: Tokens.Table['align'] = [];
  let first = src.charCodeAt(start) === 124 ? start + 1 : start;
  while (src.charCodeAt(end - 1) === 32) end--;
  if (src.charCodeAt(end - 1) === 124) end--;
  for (let i = first; i <= end; i++) {
    if (i < end && src.charCodeAt(i) !== 124) continue;
    let last = i;
    while (first < last && src.charCodeAt(first) === 32) first++;
    while (last > first && src.charCodeAt(last - 1) === 32) last--;
    const left = src.charCodeAt(first) === 58;
    const right = src.charCodeAt(last - 1) === 58;
    alignment.push(left ? (right ? 'center' : 'left') : (right ? 'right' : null));
    first = i + 1;
  }
  return alignment;
}

/** @hot */
function skipSpaces(src: string, maximum: number): number {
  let end = 0;
  while (end < maximum && src.charCodeAt(end) === 32) end++;
  return end;
}

/** @hot */
function pedanticListIndent(line: string): string {
  const indent = skipSpaces(line, line.length);
  return indent && indent < line.length ? '  ' + sourceText(line, ((indent - 1) & 3) + 1, line.length) : line;
}

/** @hot */
function taskMarkerAt(src: string, offset: number): boolean {
  const marker = src.charCodeAt(offset + 1);
  return src.charCodeAt(offset) === 91 && src.charCodeAt(offset + 2) === 93
    && (marker === 32 || (marker | 32) === 120);
}

/** @hot */
function taskPrefixEnd(src: string): number {
  if (!taskMarkerAt(src, 0)) return 0;
  const end = blockContentStart(src, 3);
  return end > 3 ? end : 0;
}

/** @hot */
function stripTaskPrefix(src: string): string {
  return sourceText(src, taskPrefixEnd(src), src.length);
}

/** @hot */
function firstTaskMarker(src: string): string | undefined {
  for (let i = 0; i + 2 < src.length; i++) {
    if (taskMarkerAt(src, i)) return sourceText(src, i, i + 3);
  }
}

/** @hot */
function startsListInterrupt(src: string, maxIndent: number, pedantic: boolean, containers: boolean): boolean {
  let pos = skipSpaces(src, maxIndent);
  const marker = src.charCodeAt(pos);
  if (marker === 96 || marker === 126) {
    return src.charCodeAt(pos + 1) === marker && src.charCodeAt(pos + 2) === marker;
  }
  if (marker === 35) {
    if (pedantic) return true;
    const start = pos;
    while (src.charCodeAt(pos) === 35 && pos - start < 7) pos++;
    return pos - start <= 6 && (pos === src.length || isStringWhitespace(src.charCodeAt(pos)));
  }
  if (!containers) return false;
  if (marker === 62) return true;
  if (marker !== 42 && marker !== 43 && marker !== 45) {
    const start = pos;
    let code = marker;
    while (code >= 48 && code <= 57 && pos - start < 9) code = src.charCodeAt(++pos);
    if (pos === start || (code !== 46 && code !== 41)) return false;
  }
  const after = src.charCodeAt(++pos);
  return pos === src.length || after === 9 || after === 10 || after === 32;
}

/** @hot */
function startsIndentedCode(src: string): boolean {
  let width = 0;
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code === 32) width++;
    else if (code === 9) width += 4;
    else return width >= 4;
  }
  return false;
}

/** @hot */
function endsWithBlankLine(src: string, start: number, end: number): boolean {
  while (end > start && (src.charCodeAt(end - 1) === 9 || src.charCodeAt(end - 1) === 32)) end--;
  if (src.charCodeAt(--end) !== 10) return false;
  while (end > start && (src.charCodeAt(end - 1) === 9 || src.charCodeAt(end - 1) === 32)) end--;
  return end > start && src.charCodeAt(end - 1) === 10;
}

/** @hot */
function hasTwoLineFeeds(src: string): boolean {
  let seen = false;
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code === 10) {
      if (seen) return true;
      seen = true;
    } else if (code === 13 || code === 0x2028 || code === 0x2029) {
      seen = false;
    }
  }
  return false;
}

/** @hot */
function rawTagNameMatches(raw: string, start: number): boolean {
  let length = 0;
  const first = raw.charCodeAt(start) | 32;
  if (first === 112 && (raw.charCodeAt(start + 1) | 32) === 114 && (raw.charCodeAt(start + 2) | 32) === 101) {
    length = 3;
  } else if (first === 107 && (raw.charCodeAt(start + 1) | 32) === 98 && (raw.charCodeAt(start + 2) | 32) === 100) {
    length = 3;
  } else if (first === 99 && (raw.charCodeAt(start + 1) | 32) === 111
    && (raw.charCodeAt(start + 2) | 32) === 100 && (raw.charCodeAt(start + 3) | 32) === 101) {
    length = 4;
  } else if (first === 115 && (raw.charCodeAt(start + 1) | 32) === 99
    && (raw.charCodeAt(start + 2) | 32) === 114 && (raw.charCodeAt(start + 3) | 32) === 105
    && (raw.charCodeAt(start + 4) | 32) === 112 && (raw.charCodeAt(start + 5) | 32) === 116) {
    length = 6;
  }
  const next = raw.charCodeAt(start + length);
  return length !== 0 && (next === 62 || isStringWhitespace(next));
}

/** @hot */
function listLineText(src: string, start: number, end: number, column: number): string {
  let pos = start;
  let width = column;
  let hasTab = false;
  while (pos < end) {
    const code = src.charCodeAt(pos);
    if (code === 32) {
      width++;
    } else if (code === 9) {
      width += 4 - (width % 4);
      hasTab = true;
    } else {
      break;
    }
    pos++;
  }
  return hasTab ? ' '.repeat(width - column) + sourceText(src, pos, end) : sourceText(src, start, end);
}

/** @hot */
function appendListContent(src: string, start: number, end: number, column: number, drop: number, padding: number, segments: number[]) {
  let first = start;
  let width = column;
  while (first < end) {
    const code = src.charCodeAt(first);
    if (code === 32) width++;
    else if (code === 9) width += 4 - (width & 3);
    else break;
    first++;
  }
  const lead = width - column - drop;
  segments.push(Math.min(first + Math.max(0, -lead), end), end, padding + Math.max(0, lead));
}

/** @hot */
function quoteMarkerAt(src: string, start: number): number {
  let marker = start;
  while (marker < start + 3 && src.charCodeAt(marker) === 32) marker++;
  return src.charCodeAt(marker) === 62 ? marker : -1;
}

/** @hot */
function stripQuoteMarkers(src: string, start: number, end: number): string {
  let span = start;
  let result = '';
  for (let line = start; line < end;) {
    const marker = quoteMarkerAt(src, line);
    if (marker >= 0) {
      result += sourceText(src, span, line);
      span = marker + 1;
      const code = src.charCodeAt(span);
      if (code === 32 || code === 9) span++;
    }
    let code = src.charCodeAt(line);
    while (line < end && code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029) {
      code = src.charCodeAt(++line);
    }
    line++;
  }
  return result + sourceText(src, span, end);
}

/** @hotIgnore Output: one string for each contiguous container run. */
function containerText(src: string, segments: number[]): string {
  let text = '';
  for (let i = 0; i < segments.length; i += 3) {
    const spaces = segments[i + 2];
    if (spaces) text += ' '.repeat(spaces);
    text += sourceText(src, segments[i], segments[i + 1]);
  }
  return text;
}

/** @hot */
function quoteSegments(src: string, first: number, end: number, segments: number[]): void {
  segments.length = 0;
  let span = first;
  let padding = 0;
  let start = first;
  let followsNewline = false;
  while (start < end) {
    const marker = quoteMarkerAt(src, start);
    if (marker >= 0) {
      if (span < start || padding) segments.push(span, start, padding);
      padding = 0;
      span = marker + 1;
      const next = src.charCodeAt(span);
      if (next === 32) {
        span++;
      } else if (next === 9) {
        let whitespaceEnd = span + 1;
        while (whitespaceEnd < end && (src.charCodeAt(whitespaceEnd) === 32 || src.charCodeAt(whitespaceEnd) === 9)) {
          whitespaceEnd++;
        }
        const column = span - start;
        let width = column;
        for (let i = span; i < whitespaceEnd; i++) {
          width += src.charCodeAt(i) === 9 ? 4 - (width & 3) : 1;
        }
        padding = width - column - 1;
        span = whitespaceEnd;
      }
    } else if (followsNewline) {
      let pos = start;
      while (pos < start + 3 && src.charCodeAt(pos) === 32) pos++;
      const code = src.charCodeAt(pos);
      if (code === 45 || code === 61) {
        let after = pos + 1;
        while (after < end && src.charCodeAt(after) === code) after++;
        while (after < end && (src.charCodeAt(after) === 32 || src.charCodeAt(after) === 9)) after++;
        if (after === end || src.charCodeAt(after) === 10) {
          segments.push(span, start, padding);
          padding = 4;
          span = pos;
        }
      }
    }
    let code = src.charCodeAt(start);
    while (start < end && code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029) {
      code = src.charCodeAt(++start);
    }
    followsNewline = code === 10;
    start++;
  }
  segments.push(span, end, padding);
}

/**
 * Tokenizer
 */
export class _Tokenizer<ParserOutput = string, RendererOutput = string> {
  /** @internal */
  private listBuffer: number[] | undefined;
  private quoteBuffer: number[] | undefined;
  options: MarkedOptions<ParserOutput, RendererOutput>;
  rules!: Rules; // set by the lexer
  lexer!: _Lexer<ParserOutput, RendererOutput>; // set by the lexer

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    this.options = options || _defaults;
  }

  space(src: string): Tokens.Space | undefined {
    return this.spaceAt(src, 0);
  }

  /** @internal */
  /** @hot */
  spaceAt(src: string, offset: number): Tokens.Space | undefined {
    let end = offset;
    let pos = offset;
    while (pos < src.length) {
      const code = src.charCodeAt(pos);
      if (code === 10) {
        end = ++pos;
      } else if (code === 32 || code === 9) {
        pos++;
      } else {
        break;
      }
    }
    if (pos === src.length) end = pos;
    if (end !== offset) {
      return createSpace(sourceText(src, offset, end));
    }
  }

  code(src: string): Tokens.Code | undefined {
    return this.codeAt(src, 0);
  }

  /** @internal */
  /** @hot */
  codeAt(src: string, offset: number): Tokens.Code | undefined {
    if (this.rules.block.code === standardCodeRule && this.rules.other.codeRemoveIndent === standardCodeIndent) {
      const end = codeBlockEnd(src, offset);
      if (end === offset) return;
      const slice = sourceText(src, offset, end);
      const raw = this.options.pedantic ? slice : trimTrailingBlankLines(slice);
      return createCode(raw, stripCodeIndent(src, offset, offset + raw.length), undefined, true);
    }
    const cap = execAt(this.rules.block.code, src, offset, this.rules.cursor?.block.code);
    if (cap) {
      const raw = this.options.pedantic
        ? cap[0]
        : trimTrailingBlankLines(cap[0]);
      const text = raw.replace(this.rules.other.codeRemoveIndent, '');
      return createCode(raw, text, undefined, true);
    }
  }

  fences(src: string): Tokens.Code | undefined {
    return this.fencesAt(src, 0);
  }

  /** @internal */
  /** @hot */
  fencesAt(src: string, offset: number): Tokens.Code | undefined {
    const rule = this.rules.block.fences;
    if (rule === standardFenceRule) {
      let markerAt = offset;
      while (markerAt - offset < 3 && src.charCodeAt(markerAt) === 32) markerAt++;
      const marker = src.charCodeAt(markerAt);
      if (marker !== 96 && marker !== 126) return;
      const infoStart = fenceMarkerEnd(src, markerAt);
      const length = infoStart - markerAt;
      if (length < 3) return;
      const infoEnd = blockLineEnd(src, infoStart);
      if (marker === 96) {
        for (let i = infoStart; i < infoEnd; i++) {
          if (src.charCodeAt(i) === 96) return;
        }
      }
      const first = Math.min(infoEnd + 1, src.length);
      let line = first;
      let end = src.length;
      while (line < src.length) {
        let start = line;
        while (start - line < 3 && src.charCodeAt(start) === 32) start++;
        const close = src.charCodeAt(start) === marker ? fenceMarkerEnd(src, start) : start;
        if (close - start >= length) {
          const tail = blockContentStart(src, close);
          if (tail === src.length || src.charCodeAt(tail) === 10) {
            end = tail;
            break;
          }
        }
        line = Math.min(blockLineEnd(src, start) + 1, src.length);
      }
      let last = line;
      if (last > first && src.charCodeAt(last - 1) === 10) last--;
      const raw = sourceText(src, offset, end);
      let text = indentCodeCompensation(raw, sourceText(src, first, last), this.lexer.state.top && !this.lexer.state.inBlockquote);
      if (line > first && (text.length === 0 || text.charCodeAt(text.length - 1) === 10)) text += '\n';
      const lang = sourceText(src, infoStart, infoEnd);
      return createCode(raw, text, lang.trim().replace(this.rules.inline.anyPunctuation, '$1'), false);
    }
    if (rule === noFenceRule) return;
    const cap = execAt(this.rules.block.fences, src, offset, this.rules.cursor?.block.fences);
    if (cap) {
      const raw = cap[0];
      let text = indentCodeCompensation(raw, cap[3] || '', this.lexer.state.top && !this.lexer.state.inBlockquote);
      // The fence pattern consumes the final content newline outside the capture.
      // Keep it when the captured content ends in a blank line.
      if (cap[3] !== undefined && (text.length === 0 || text.charCodeAt(text.length - 1) === 10)) {
        text += '\n';
      }

      return createCode(raw, text, cap[2] ? cap[2].trim().replace(this.rules.inline.anyPunctuation, '$1') : cap[2], false);
    }
  }

  heading(src: string): Tokens.Heading | undefined {
    return this.headingAt(src, 0);
  }

  /** @internal */
  /** @hot */
  headingAt(src: string, offset: number): Tokens.Heading | undefined {
    const rule = this.rules.block.heading;
    let heading = src;
    let customRaw: string | undefined;
    let rawEnd: number;
    let content: number;
    let depth: number;
    if (rule === standardHeadingRule || rule === pedanticHeadingRule) {
      let marker = offset;
      if (rule === standardHeadingRule) {
        while (marker - offset < 3 && src.charCodeAt(marker) === 32) marker++;
      }
      content = headingMarkerEnd(src, marker, rule === pedanticHeadingRule);
      if (content === marker) return;
      depth = content - marker;
      rawEnd = blockLineEnd(src, content);
      for (let i = content; i < rawEnd; i++) {
        const code = src.charCodeAt(i);
        if (code === 13 || code === 0x2028 || code === 0x2029) return;
      }
    } else {
      const cap = execAt(rule, src, offset, this.rules.cursor?.block.heading);
      if (!cap) return;
      heading = cap[2];
      content = 0;
      depth = cap[1].length;
      rawEnd = heading.length;
      customRaw = withoutTrailingNewlines(cap[0]);
    }
    const start = trimStartOffset(heading, content, rawEnd);
    let end = trimEndOffset(heading, start, rawEnd);
    let hash = end;
    while (hash > start && heading.charCodeAt(hash - 1) === 35) hash--;
    const beforeHash = heading.charCodeAt(hash - 1);
    if (hash < end && (this.options.pedantic || hash === start || beforeHash === 32 || beforeHash === 9)) {
      end = trimEndOffset(heading, start, hash);
    }
    const text = sourceText(heading, start, end);
    const raw = customRaw ?? sourceText(src, offset, rawEnd);
    return createHeading(raw, depth, text, this.lexer.inline(text));
  }

  hr(src: string): Tokens.Hr | undefined {
    return this.hrAt(src, 0);
  }

  /** @internal */
  /** @hot */
  hrAt(src: string, offset: number): Tokens.Hr | undefined {
    let end = offset;
    while (end < offset + 3 && src.charCodeAt(end) === 32) end++;

    if (this.rules.block.hr !== standardHrRule) {
      const cap = execAt(this.rules.block.hr, src, offset, this.rules.cursor?.block.hr);
      if (cap) return createHr(withoutTrailingNewlines(cap[0]));
      return;
    }

    const marker = src.charCodeAt(end);
    if (marker !== 45 && marker !== 95 && marker !== 42) return;

    end = thematicBreakEnd(src, end);
    if (end >= 0) return createHr(sourceText(src, offset, end));
  }

  /** @hot */
  blockquote(src: string): Tokens.Blockquote | undefined {
    return this.blockquoteAt(src, 0);
  }

  /** @internal */
  blockquoteAt(src: string, offset: number): Tokens.Blockquote | undefined {
    const rule = this.rules.block.blockquote;
    let quoteEnd = rule === standardQuoteRule
      ? quotedBlockEnd(src, offset)
      : offset + (execAt(rule, src, offset, this.rules.cursor?.block.blockquote)?.[0].length ?? 0);
    if (quoteEnd > offset) {
      while (src.charCodeAt(quoteEnd - 1) === 10) quoteEnd--;
      let position = offset;
      let rawEnd = offset;
      let text = '';
      const tokens: Token[] = [];

      while (position < quoteEnd) {
        let inBlockquote = false;
        let start = position;
        let end = position;

        while (start <= quoteEnd) {
          const line = Math.min(lineEnd(src, start), quoteEnd);
          if (quoteMarkerAt(src, start) >= 0) {
            inBlockquote = true;
          } else if (inBlockquote) {
            break;
          }
          end = line;
          start = line + 1;
        }

        const tab = src.indexOf('\t', position);
        const segments = this.quoteBuffer ??= [];
        let currentText: string;
        if (tab >= 0 && tab < end && this.lexer.state.top && !this.lexer.state.inBlockquote) {
          const expanded = expandBlockquoteTabs(src, position, end);
          quoteSegments(expanded, 0, expanded.length, segments);
          currentText = containerText(expanded, segments);
        } else {
          quoteSegments(src, position, end, segments);
          currentText = containerText(src, segments);
        }
        position = end + 1;
        rawEnd = end;
        text = text ? `${text}\n${currentText}` : currentText;

        // parse blockquote lines as top level tokens
        // merge paragraphs if this is a continuation
        const top = this.lexer.state.top;
        const outerInBlockquote = this.lexer.state.inBlockquote;
        this.lexer.state.top = true;
        this.lexer.state.inBlockquote = true;
        this.lexer.blockTokens(currentText, tokens, true);
        this.lexer.state.top = top;
        this.lexer.state.inBlockquote = outerInBlockquote;

        // if there is no continuation then we are done
        if (position >= quoteEnd) {
          break;
        }

        const lastToken = tokens.at(-1);
        const kind = this.lexer.blockKind(lastToken);

        if (kind === TokenKind.Code || kind === TokenKind.Heading || kind === TokenKind.Hr || kind === TokenKind.Html || kind === TokenKind.Table) {
          // blockquote continuation cannot be preceded by a code block, heading, hr, html block or table
          break;
        } else if (kind === TokenKind.Blockquote) {
          // include continuation in nested blockquote
          const oldToken = lastToken as Tokens.Blockquote;
          // The continuation lines belong to the same nesting frame as the
          // nested blockquote, which already had one '>' marker stripped, so
          // strip one marker from them too. Otherwise a restated marker after a
          // lazy line is re-parsed as a spurious deeper blockquote.
          const continuation = this.rules.other.blockquoteSetextReplace2 === standardQuotePrefix
            ? stripQuoteMarkers(src, position, quoteEnd)
            : sourceText(src, position, quoteEnd).replace(this.rules.other.blockquoteSetextReplace2, '');
          const newText = oldToken.raw + '\n' + continuation;
          this.lexer.state.inBlockquote = true;
          const newToken = this.blockquote(newText)!;
          this.lexer.state.inBlockquote = outerInBlockquote;
          tokens[tokens.length - 1] = newToken;

          // Only include continuation lines the nested blockquote actually
          // consumed. Unconsumed trailing lines must stay out of `raw` so the
          // lexer can still tokenize them (paragraph, next blockquote, etc.).
          let leftoverStart = newToken.raw.length;
          if (newText.charCodeAt(leftoverStart) === 10) leftoverStart++;
          let leftoverCount = leftoverStart < newText.length ? 1 : 0;
          for (let i = leftoverStart; i < newText.length; i++) {
            if (newText.charCodeAt(i) === 10) leftoverCount++;
          }
          if (leftoverCount === 0) {
            rawEnd = quoteEnd;
            position = quoteEnd;
          } else {
            let leftoverLine = quoteEnd;
            while (leftoverCount-- > 0) {
              leftoverLine = src.lastIndexOf('\n', leftoverLine - 1);
              if (leftoverLine < position) break;
            }
            if (leftoverLine >= position) {
              rawEnd = leftoverLine;
              position = leftoverLine + 1;
            }
          }
          text = text.slice(0, text.length - oldToken.text.length) + newToken.text;

          // A leftover quote line belongs to this blockquote.
          if (position < quoteEnd && quoteMarkerAt(src, position) >= 0) {
            continue;
          }
          break;
        } else if (kind === TokenKind.List) {
          // include continuation in nested list
          const oldToken = lastToken as Tokens.List;
          const newText = oldToken.raw + '\n' + src.slice(position, quoteEnd);
          const newToken = this.list(newText)!;
          tokens[tokens.length - 1] = newToken;

          // Count the continuation lines in the nested list's source.
          if (newToken.raw.length > oldToken.raw.length) {
            let consumed = 1;
            for (let i = oldToken.raw.length + 1; i < newToken.raw.length; i++) {
              if (newText.charCodeAt(i) === 10) consumed++;
            }
            let consumedEnd = position;
            while (consumed-- > 0 && consumedEnd < quoteEnd) {
              consumedEnd = Math.min(lineEnd(src, consumedEnd), quoteEnd) + 1;
            }
            rawEnd = consumedEnd - 1;
            text += '\n' + src.slice(position, rawEnd);
            position = consumedEnd;
          }

          if (position < quoteEnd && quoteMarkerAt(src, position) < 0) {
            break;
          }
          continue;
        }
      }

      return createBlockquote(sourceText(src, offset, rawEnd), text, tokens);
    }
  }

  /** @hot */
  list(src: string): Tokens.List | undefined {
    return this.listAt(src, 0);
  }

  /** @internal */
  listAt(src: string, offset: number): Tokens.List | undefined {
    const standardRule = this.rules.block.list === standardListRule;
    const cap = standardRule ? undefined : execAt(this.rules.block.list, src, offset, this.rules.cursor?.block.list);
    const markerEnd = standardRule ? firstListMarkerEnd(src, offset) : cap?.[1].length ?? 0;
    if (markerEnd || cap) {
      // Inside a list item, paragraph lines are lexed as text tokens, so a list after one would
      // interrupt the paragraph. Only a non-empty list starting with a bullet or 1 can do that
      if (!this.options.pedantic && this.lexer.state.lastToken?.type === 'text'
        && !(this.rules.other.listInterruptsParagraph === standardListInterrupt
          ? listInterruptsParagraph(src, offset, offset + markerEnd)
          : execAt(this.rules.other.listInterruptsParagraph, src, offset, this.rules.cursor?.other.listInterruptsParagraph))) {
        return;
      }

      const listStart = offset;
      const bull = cap?.[1].trim();
      const marker = bull === undefined ? src.charCodeAt(offset + markerEnd - 1) : bull.charCodeAt(bull.length - 1);
      const isordered = bull === undefined ? marker === 46 || marker === 41 : bull.length > 1;

      let start: number | '' = '';
      if (isordered) {
        if (bull === undefined) {
          let value = 0;
          for (let i = listStart; i < listStart + markerEnd - 1; i++) {
            const code = src.charCodeAt(i);
            if (code !== 32) value = value * 10 + code - 48;
          }
          start = value;
        } else {
          start = +bull.slice(0, -1);
        }
      }

      const list: Tokens.List = createList('', isordered, start, false);

      let previousBlankLine = false;
      // Check if current bullet point can start a new List Item
      while (offset < src.length) {
        let endEarly = false;
        let itemContents = '';
        const segments = this.listBuffer ??= [];
        segments.length = 0;
        let hasContinuation = false;
        const bulletIndent = listMarkerEnd(src, offset, marker, isordered, !!this.options.pedantic);
        if (bulletIndent === 0) {
          break;
        }

        if (this.rules.block.hr === standardHrRule
          ? listHasHr(src, offset, 3)
          : execAt(this.rules.block.hr, src, offset, this.rules.cursor?.block.hr)) {
          break;
        }

        const itemStart = offset;
        const firstLineStart = offset + bulletIndent;
        const firstLineEnd = lineEnd(src, firstLineStart);
        offset = Math.min(src.length, firstLineEnd + 1);

        const pedantic = !!this.options.pedantic;
        let line = pedantic
          ? expandTabs(sourceText(src, firstLineStart, firstLineEnd), bulletIndent)
          : listLineText(src, firstLineStart, firstLineEnd, bulletIndent);
        let lineIndent = 0;
        const trimmedStart = trimStartOffset(line, 0, line.length);
        let blankLine = trimmedStart === line.length;

        let indent = 0;
        if (this.options.pedantic) {
          indent = 2;
          itemContents = sourceText(line, trimmedStart, line.length);
        } else if (blankLine) {
          indent = bulletIndent + 1;
        } else {
          indent = skipSpaces(line, line.length);
          indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent
          appendListContent(src, firstLineStart, firstLineEnd, bulletIndent, indent, 0, segments);
          indent += bulletIndent;
        }

        if (blankLine) {
          let next = offset;
          while (src.charCodeAt(next) === 32 || src.charCodeAt(next) === 9) next++;
          // Items begin with at most one blank line.
          if (next === src.length || src.charCodeAt(next) === 10) {
            offset = Math.min(src.length, next + 1);
            endEarly = true;
          }
        }

        if (!endEarly) {
          const maxIndent = Math.max(0, Math.min(3, indent - 1));
          const hrRegex = this.rules.other.hrRegex === standardListHr ? undefined : this.rules.other.hrRegex(indent);
          const htmlBeginRegex = this.rules.other.htmlBeginRegex(indent);

          // A lazy line continues a paragraph, so it is not checked for the start of a block
          let lineIsLazy = false;

          // Check if following lines should be included in List Item
          while (offset < src.length) {
            const nextEnd = lineEnd(src, offset);
            const rawLine = sourceText(src, offset, nextEnd);
            // Pedantic parsing checks the line after realigning its indentation.
            let nextLine = rawLine;
            if (pedantic) {
              nextLine = this.rules.other.listReplaceNesting === standardListNesting
                ? pedanticListIndent(rawLine)
                : rawLine.replace(this.rules.other.listReplaceNesting, '  ');
            }

            if (startsListInterrupt(nextLine, maxIndent, pedantic, true) || htmlBeginRegex.test(nextLine)) {
              break;
            }

            // Horizontal rule found
            if (hrRegex ? hrRegex.test(nextLine) : listHasHr(nextLine, 0, maxIndent)) {
              break;
            }

            const nextLineWithoutTabs = pedantic ? nextLine : listLineText(rawLine, 0, rawLine.length, 0);
            const nextIsBlank = trimStartOffset(nextLine, 0, nextLine.length) === nextLine.length;
            if (skipSpaces(nextLineWithoutTabs, nextLineWithoutTabs.length) >= indent || nextIsBlank) {
              if (pedantic) {
                itemContents += '\n';
                itemContents += sourceText(nextLineWithoutTabs, indent, nextLineWithoutTabs.length);
              } else {
                segments.push(offset - 1, offset, 0);
                appendListContent(src, offset, nextEnd, 0, indent, 0, segments);
              }
              lineIsLazy = false;
            } else {
              // not enough indentation
              if (blankLine) {
                break;
              }

              // The first line of an item always starts a block, which can be a
              // nested list item or block quote. Look past their markers to the
              // block a lazy line would continue. Tabs are left alone because
              // their width depends on the column they start at.
              const previous = sourceText(line, lineIndent, line.length);
              let lastBlock = previous;
              if (!this.options.pedantic && !hasContinuation && !previous.includes('\t')) {
                let nested = 0;
                while (!(hrRegex ? hrRegex.test(sourceText(lastBlock, nested, lastBlock.length)) : listHasHr(lastBlock, nested, maxIndent))) {
                  const after = this.rules.other.nestedBlockMarker === standardNestedMarkers
                    ? nestedMarkerEnd(lastBlock, nested, false)
                    : nested + (this.rules.other.nestedBlockMarker.exec(sourceText(lastBlock, nested, lastBlock.length))?.[0].length ?? 0);
                  if (after === nested) break;
                  nested = after;
                }
                if (nested) lastBlock = sourceText(lastBlock, nested, lastBlock.length);
                if (trimStartOffset(lastBlock, 0, lastBlock.length) === lastBlock.length) { // empty list item or block quote
                  break;
                }
              }

              // paragraph continuation unless last line was a different block level element
              if (startsIndentedCode(lastBlock)) { // indented code block
                break;
              }
              if (startsListInterrupt(lastBlock, maxIndent, pedantic, false)) {
                break;
              }
              if (htmlBeginRegex.test(lastBlock)) {
                break;
              }
              if (hrRegex ? hrRegex.test(lastBlock) : listHasHr(lastBlock, 0, maxIndent)) {
                break;
              }
              if (!this.options.pedantic && !lineIsLazy) {
                // `line` is relative to the item content, so a block on it can be indented up to 3 spaces whatever
                // the item indent is. A nested list item or blockquote on it, as in `- # heading` or `> ---`, holds
                // a block that a lazy line cannot continue either, so check what follows those markers too.
                let nested = 0;
                let content = previous;
                if (this.rules.other.nestedContainerMarkers === standardContainerMarkers) {
                  for (;;) {
                    const after = nestedMarkerEnd(previous, nested, true);
                    if (after === nested) break;
                    nested = after;
                  }
                } else {
                  content = previous.replace(this.rules.other.nestedContainerMarkers, '');
                }
                const standardStarts = this.rules.block.fences === standardFenceRule
                  && this.rules.block.heading === standardHeadingRule && this.rules.block.hr === standardHrRule;
                if (standardStarts) {
                  const heading = nested + skipSpacesAt(content, nested, 3);
                  if (lineHasFence(content, nested) || headingMarkerEnd(content, heading, false) !== heading || listHasHr(content, nested, 3)) break;
                } else {
                  const suffix = sourceText(content, nested, content.length);
                  if (this.rules.block.fences.test(suffix) || this.rules.block.heading.test(suffix) || this.rules.block.hr.test(suffix)) break;
                }
              }

              // A lazy continuation can look like a setext underline after
              // list indentation is removed. Keep it in the paragraph.
              const setextContinuation = !this.options.pedantic
                && setextUnderlineStart(nextLine, 0, true) >= 0
                && (this.rules.block.lheading === standardSetextRule || this.rules.block.lheading === gfmSetextRule
                  ? setextTextEnd(`${previous}\n${nextLine}`, 0, this.rules.block.lheading === gfmSetextRule, false) >= 0
                  : this.rules.block.lheading.test(`${previous}\n${nextLine}`));
              if (pedantic) {
                itemContents += '\n' + nextLine;
              } else {
                segments.push(offset - 1, offset, 0);
                if (setextContinuation) {
                  appendListContent(src, offset, nextEnd, 0, skipSpaces(nextLineWithoutTabs, 3), 4, segments);
                } else {
                  segments.push(offset, nextEnd, 0);
                }
              }
              lineIsLazy = true;
            }

            hasContinuation = true;
            blankLine = nextIsBlank;
            offset = Math.min(src.length, nextEnd + 1);
            line = nextLineWithoutTabs;
            lineIndent = indent;
          }
        }

        // The loops above appended a '\n' the source may not have had. It could
        // only land on the item that exhausts src, whose raw is trimmed below,
        // and after which nothing reads the blank line flag
        const raw = sourceText(src, itemStart, offset);

        if (!list.loose) {
          // If the previous item ended with a blank line, the list is loose
          if (previousBlankLine) {
            list.loose = true;
          } else if (endsWithBlankLine(src, itemStart, offset)) {
            previousBlankLine = true;
          }
        }

        if (!pedantic) itemContents = containerText(src, segments);
        let task = false;
        if (this.options.gfm) {
          if (this.rules.other.listIsTask === standardIsTask) {
            const end = taskPrefixEnd(itemContents);
            task = end !== 0 && end < itemContents.length && !isStringWhitespace(itemContents.charCodeAt(end));
          } else {
            task = this.rules.other.listIsTask.test(itemContents);
          }
        }
        list.items.push(createListItem(raw, task, false, itemContents));
      }

      // Do not consume trailing whitespace from the final item.
      const lastItem = list.items.at(-1);
      if (!lastItem) return;
      const lastItemStart = offset - lastItem.raw.length;
      lastItem.raw = sourceText(lastItem.raw, 0, trimEndOffset(lastItem.raw, 0, lastItem.raw.length));
      lastItem.text = sourceText(lastItem.text, 0, trimEndOffset(lastItem.text, 0, lastItem.text.length));
      list.raw = sourceText(src, listStart, lastItemStart + lastItem.raw.length);

      // Item child tokens handled here at end because we needed to have the final item to trim it first
      // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes
      // Where each item's inline queue entries start, so the checkbox is removed from its own text
      const queueStarts: number[] = [];
      for (const item of list.items) {
        this.lexer.state.top = false;
        queueStarts.push(this.lexer.inlineQueue.length);
        this.lexer.blockTokens(item.text, item.tokens);

        if (!list.loose) {
          for (let i = 0; i < item.tokens.length; i++) {
            const token = item.tokens[i];
            if (token.type === 'space' && hasTwoLineFeeds(token.raw)) {
              list.loose = true;
              break;
            }
          }
        }
      }

      // Second pass: place task checkboxes using the final list.loose
      for (let i = 0; i < list.items.length; i++) {
        const item = list.items[i];
        const itemToken = item.tokens[0];
        if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
          // Remove checkbox markdown from item tokens
          const rule = this.rules.other.listReplaceTask;
          const standardTask = rule === standardReplaceTask;
          item.text = standardTask ? stripTaskPrefix(item.text) : item.text.replace(rule, '');
          itemToken.raw = standardTask ? stripTaskPrefix(itemToken.raw) : itemToken.raw.replace(rule, '');
          itemToken.text = standardTask ? stripTaskPrefix(itemToken.text) : itemToken.text.replace(rule, '');
          // The first token queued its text first, so its entry is found right away
          const inlineQueue = this.lexer.inlineQueue;
          for (let j = queueStarts[i]; j < inlineQueue.length; j++) {
            if (inlineQueue[j].tokens === itemToken.tokens) {
              const entry = inlineQueue[j];
              entry.src = standardTask ? stripTaskPrefix(entry.src) : entry.src.replace(rule, '');
              break;
            }
          }

          const taskRule = this.rules.other.listTaskCheckbox;
          const taskRaw = taskRule === standardTaskCheckbox ? firstTaskMarker(item.raw) : taskRule.exec(item.raw)?.[0];
          if (taskRaw !== undefined) {
            const checkboxToken: Tokens.Checkbox = createCheckbox(taskRaw + ' ', taskRaw.charCodeAt(1) !== 32);
            item.checked = checkboxToken.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
                item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkboxToken);
              } else {
                item.tokens.unshift(createParagraph(checkboxToken.raw, checkboxToken.raw, [checkboxToken]));
              }
            } else {
              item.tokens.unshift(checkboxToken);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }

      // Set all items to loose if list is loose
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const token of item.tokens) {
            if (token.type === 'text') {
              token.type = 'paragraph';
              if (token.kind !== undefined) token.kind = TokenKind.Paragraph;
            }
          }
        }
      }

      return list;
    }
  }

  html(src: string): Tokens.HTML | undefined {
    return this.htmlAt(src, 0);
  }

  /** @internal */
  /** @hot */
  htmlAt(src: string, offset: number): Tokens.HTML | undefined {
    const cap = execAt(this.rules.block.html, src, offset, this.rules.cursor?.block.html);
    if (cap) {
      // an html block of type 7 cannot interrupt a paragraph, so a lazy
      // continuation line that starts one continues the paragraph instead
      if (this.lexer.state.lastToken?.type === 'paragraph' && !execAt(this.rules.other.htmlBeginRegex(4), src, offset, this.rules.cursor?.other.htmlBegin)) {
        return;
      }

      const raw = trimTrailingBlankLines(cap[0]);
      const token: Tokens.HTML = createHtml(raw, cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', undefined);
      return token;
    }
  }

  def(src: string): Tokens.Def | undefined {
    return this.defAt(src, 0);
  }

  /** @internal */
  defAt(src: string, offset: number): Tokens.Def | undefined {
    const rule = this.rules.block.def;
    if (rule === standardDefRule || rule === pedanticDefRule) {
      const pedantic = rule === pedanticDefRule;
      let label = offset;
      while (src.charCodeAt(label) === 32) {
        if (!pedantic && label - offset === 3) break;
        label++;
      }
      if (src.charCodeAt(label++) !== 91) return;
      const labelEnd = definitionLabelEnd(src, label, pedantic);
      if (labelEnd < 0 || src.charCodeAt(labelEnd + 1) !== 58) return;
      let hrefStart = labelEnd + 2;
      while (src.charCodeAt(hrefStart) === 32) hrefStart++;
      if (!pedantic && src.charCodeAt(hrefStart) === 10) {
        hrefStart = blockContentStart(src, hrefStart + 1);
      }
      let hrefEnd = hrefStart;
      let destEnd = hrefStart;
      if (!pedantic && src.charCodeAt(hrefStart) === 60) {
        hrefEnd = destEnd = angleDestinationEnd(src, hrefStart);
        if (hrefEnd < 0) return;
      } else {
        const angle = pedantic && src.charCodeAt(hrefStart) === 60;
        if (angle && src.charCodeAt(hrefStart + 1) !== 62 && !isStringWhitespace(src.charCodeAt(hrefStart + 1)) && hrefStart + 1 < src.length) hrefStart++;
        hrefEnd = hrefStart;
        while (hrefEnd < src.length && !isStringWhitespace(src.charCodeAt(hrefEnd))) {
          if (pedantic && src.charCodeAt(hrefEnd) === 62) break;
          hrefEnd++;
        }
        if (hrefEnd === hrefStart) return;
        destEnd = pedantic && src.charCodeAt(hrefEnd) === 62 ? hrefEnd + 1 : hrefEnd;
      }

      let titleStart = destEnd;
      while (src.charCodeAt(titleStart) === 32) titleStart++;
      if (!pedantic && src.charCodeAt(titleStart) === 10) titleStart = blockContentStart(src, titleStart + 1);
      const titleEnd = titleStart === destEnd
        ? -1
        : pedantic ? pedanticTitleEnd(src, titleStart) : definitionTitleEnd(src, titleStart);
      const titledEnd = titleEnd < 0 ? -1 : definitionLineEnd(src, titleEnd);
      const end = titledEnd < 0 ? definitionLineEnd(src, destEnd) : titledEnd;
      if (end < 0) return;
      const href = sourceText(src, hrefStart, hrefEnd);
      if (href.charCodeAt(0) !== 60 && findClosingParen(href) !== -1) return;
      const tag = normalizeLabel(src, label, labelEnd);
      const url = href.replace(this.rules.other.hrefBrackets, '$1').replace(this.rules.inline.anyPunctuation, '$1');
      const title = titledEnd < 0 ? undefined : sourceText(src, titleStart + 1, titleEnd - 1).replace(this.rules.inline.anyPunctuation, '$1');
      return createDef(tag, sourceText(src, offset, end), url, title!);
    }
    const cap = execAt(this.rules.block.def, src, offset, this.rules.cursor?.block.def);
    if (cap) {
      // outside angle brackets a link destination holds only balanced parentheses
      if (cap[2].charCodeAt(0) !== 60 && findClosingParen(cap[2]) !== -1) {
        return;
      }

      const tag = normalizeLabel(cap[1]);
      const href = cap[2] ? cap[2].replace(this.rules.other.hrefBrackets, '$1').replace(this.rules.inline.anyPunctuation, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(this.rules.inline.anyPunctuation, '$1') : cap[3];
      return createDef(tag, withoutTrailingNewlines(cap[0]), href, title);
    }
  }

  table(src: string): Tokens.Table | undefined {
    return this.tableAt(src, 0);
  }

  /** @internal */
  /** @hot */
  tableAt(src: string, offset: number): Tokens.Table | undefined {
    if (this.rules.block.table === noTableRule) return;
    if (this.rules.block.table === standardTableRule && this.rules.other.tableHeader === standardTableHeader) {
      const headerEnd = blockLineEnd(src, offset);
      if (headerEnd === src.length) return;
      const alignStart = headerEnd + 1;
      const alignEnd = tableDelimiterEnd(src, alignStart);
      if (alignEnd < 0 || !hasTableDelimiter(src, alignStart, alignEnd)) return;
      const start = tableHeaderContent(src, offset, headerEnd);
      if (start < 0) return;
      const headers = splitCells(src, start, headerEnd, 0);
      const aligns = tableAlignments(src, blockContentStart(src, alignStart), alignEnd);
      if (headers.length !== aligns.length) return;
      const bodyStart = Math.min(alignEnd + 1, src.length);
      const bodyEnd = tableBodyEnd(src, bodyStart);
      const raw = withoutTrailingNewlines(sourceText(src, offset, bodyEnd));
      const table = createTable(raw, aligns);
      for (let i = 0; i < headers.length; i++) {
        table.header.push(createTableCell(headers[i], this.lexer.inline(headers[i]), true, aligns[i]));
      }
      let end = bodyEnd;
      while (end > bodyStart && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
      end = src.charCodeAt(end - 1) === 10 ? end - 1 : bodyEnd;
      if (trimStartOffset(src, bodyStart, bodyEnd) < bodyEnd) {
        for (let line = bodyStart; line <= end;) {
          const eol = Math.min(blockLineEnd(src, line), end);
          const cells = splitCells(src, line, eol, headers.length);
          const row: Tokens.TableCell[] = [];
          for (let i = 0; i < cells.length; i++) {
            row.push(createTableCell(cells[i], this.lexer.inline(cells[i]), false, aligns[i]));
          }
          table.rows.push(row);
          line = eol + 1;
        }
      }
      return table;
    }
    let headers: string[] | undefined;
    let aligns: Tokens.Table['align'] | undefined;
    if (this.options.gfm && !this.options.pedantic) {
      const header = execAt(this.rules.other.tableHeader, src, offset, this.rules.cursor?.other.tableHeader);
      if (!header || !hasTableDelimiter(header[2])) {
        return;
      }
      headers = splitCells(header[1], 0, header[1].length, 0);
      aligns = tableAlignments(header[2]);
      if (headers.length !== aligns.length) {
        return;
      }
    }
    const cap = execAt(this.rules.block.table, src, offset, this.rules.cursor?.block.table);
    if (!cap) {
      return;
    }

    if (!hasTableDelimiter(cap[2])) {
      // delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading
      return;
    }

    headers ??= splitCells(cap[1], 0, cap[1].length, 0);
    aligns ??= tableAlignments(cap[2]);

    const item: Tokens.Table = createTable(withoutTrailingNewlines(cap[0]), aligns);

    if (headers.length !== aligns.length) {
      // header and align columns must be equal, rows can be different.
      return;
    }

    for (let i = 0; i < headers.length; i++) {
      item.header.push(createTableCell(headers[i], this.lexer.inline(headers[i]), true, item.align[i]));
    }

    const body = cap[3];
    if (body && trimStartOffset(body, 0, body.length) < body.length) {
      let end = body.length;
      while (body.charCodeAt(end - 1) === 32 || body.charCodeAt(end - 1) === 9) end--;
      end = body.charCodeAt(end - 1) === 10 ? end - 1 : body.length;
      let start = 0;
      while (start <= end) {
        const next = Math.min(lineEnd(body, start), end);
        const cells = splitCells(body, start, next, item.header.length);
        const row: Tokens.TableCell[] = [];
        for (let i = 0; i < cells.length; i++) {
          row.push(createTableCell(cells[i], this.lexer.inline(cells[i]), false, aligns[i]));
        }
        item.rows.push(row);
        start = next + 1;
      }
    }

    return item;
  }

  lheading(src: string): Tokens.Heading | undefined {
    return this.lheadingAt(src, 0);
  }

  /** @internal */
  /** @hot */
  lheadingAt(src: string, offset: number): Tokens.Heading | undefined {
    const rule = this.rules.block.lheading;
    if (rule === standardSetextRule || rule === gfmSetextRule || rule === pedanticSetextRule) {
      const pedantic = rule === pedanticSetextRule;
      const end = setextTextEnd(src, offset, rule === gfmSetextRule, pedantic);
      if (end < 0) return;
      const marker = setextUnderlineStart(src, end + 1, pedantic);
      const depth = src.charCodeAt(marker) === 61 ? 1 : 2;
      const start = trimStartOffset(src, offset, end);
      const text = sourceText(src, start, trimEndOffset(src, start, end));
      const raw = sourceText(src, offset, blockLineEnd(src, marker));
      return createHeading(raw, depth, text, this.lexer.inline(text));
    }
    const cap = execAt(this.rules.block.lheading, src, offset, this.rules.cursor?.block.lheading);
    if (cap) {
      const start = trimStartOffset(cap[1], 0, cap[1].length);
      const text = sourceText(cap[1], start, trimEndOffset(cap[1], start, cap[1].length));
      return createHeading(withoutTrailingNewlines(cap[0]), cap[2].charCodeAt(0) === 61 ? 1 : 2, text, this.lexer.inline(text));
    }
  }

  paragraph(src: string): Tokens.Paragraph | undefined {
    return this.paragraphAt(src, 0);
  }

  /** @internal */
  /** @hot */
  paragraphAt(src: string, offset: number): Tokens.Paragraph | undefined {
    const rule = this.rules.block.paragraph;
    let raw: string;
    let text: string;
    if (rule === commonMarkParagraphRule || rule === gfmParagraphRule || rule === pedanticParagraphRule) {
      const end = paragraphEnd(src, offset, rule === pedanticParagraphRule, rule === gfmParagraphRule);
      if (end === offset) return;
      raw = text = sourceText(src, offset, end);
    } else {
      const cap = execAt(rule, src, offset, this.rules.cursor?.block.paragraph);
      if (!cap) return;
      raw = cap[0];
      text = cap[1];
      if (text.charCodeAt(text.length - 1) === 10) {
        text = sourceText(text, 0, text.length - 1);
      }
    }
    return createParagraph(raw, text, this.lexer.inline(text));
  }

  text(src: string): Tokens.Text | undefined {
    return this.textAt(src, 0);
  }

  /** @internal */
  /** @hot */
  textAt(src: string, offset: number): Tokens.Text | undefined {
    if (this.rules.block.text === standardTextRule
      && this.rules.other.textIndentedContinuation === standardTextContinuation
      && this.rules.other.codeRemoveIndent === standardCodeIndent) {
      const line = blockLineEnd(src, offset);
      if (line === offset) return;
      let end = line;
      let text = sourceText(src, offset, line);
      while (end < src.length) {
        const start = end + 1;
        const indent = blockIndentEnd(src, start);
        if (indent === start) break;
        const content = blockContentStart(src, indent);
        if (content === src.length || src.charCodeAt(content) === 10) break;
        end = blockLineEnd(src, content);
        text += '\n' + sourceText(src, indent, end);
      }
      return createText(end === line ? text : sourceText(src, offset, end), text, this.lexer.inline(text));
    }
    const cap = execAt(this.rules.block.text, src, offset, this.rules.cursor?.block.text);
    if (cap) {
      let raw = cap[0];
      let text = cap[0];
      // Indented code cannot interrupt the text, so indented lines continue it
      // up to the next blank line
      const continuation = execAt(this.rules.other.textIndentedContinuation, src, offset + raw.length, this.rules.cursor?.other.textIndentedContinuation);
      if (continuation) {
        raw = sourceText(src, offset, offset + raw.length + continuation[0].length);
        text += continuation[0].replace(this.rules.other.codeRemoveIndent, '');
      }
      return createText(raw, text, this.lexer.inline(text));
    }
  }

  escape(src: string): Tokens.Escape | undefined {
    return this.escapeAt(src, 0);
  }

  /** @internal */
  /** @hot */
  escapeAt(src: string, offset: number): Tokens.Escape | undefined {
    if (src.charCodeAt(offset) !== 92) return; // \\
    const cap = execAt(this.rules.inline.escape, src, offset, this.rules.cursor?.inline.escape);
    if (cap) {
      return createEscape(cap[0], cap[1]);
    }
  }

  tag(src: string): Tokens.Tag | undefined {
    return this.tagAt(src, 0);
  }

  /** @internal */
  /** @hot */
  tagAt(src: string, offset: number): Tokens.Tag | undefined {
    if (src.charCodeAt(offset) !== 60) return; // <
    const cap = execAt(this.rules.inline.tag, src, offset, this.rules.cursor?.inline.tag);
    if (cap) {
      const raw = cap[0];
      const state = this.lexer.state;
      const closing = raw.charCodeAt(1) === 47;
      const name = closing ? 2 : 1;
      if ((raw.charCodeAt(name) | 32) === 97) {
        if (!state.inLink && !closing && raw.charCodeAt(2) === 32) state.inLink = true;
        else if (state.inLink && closing && raw.charCodeAt(3) === 62) state.inLink = false;
      }
      if (state.inRawBlock === closing && rawTagNameMatches(raw, name)) {
        state.inRawBlock = !closing;
      }

      return createHtml(cap[0], this.lexer.state.inLink, this.lexer.state.inRawBlock);
    }
  }

  link(src: string): Tokens.Link | Tokens.Image | undefined {
    return this.linkAt(src, 0);
  }

  /** @internal */
  /** @hot */
  linkAt(src: string, offset: number): Tokens.Link | Tokens.Image | undefined {
    // The link regex backtracks quadratically over unterminated-link inputs
    // like '[a](b'.repeat(n): at every '[' its greedy unquoted-href run
    // re-partitions the whole remainder while hunting for a ')' that never
    // comes. inlineTokens anchors one paren scan per run in
    // state.linkParenPossible; when it is false the regex cannot match, so
    // bail out before running it.
    if (this.lexer.state.linkParenPossible === false) {
      return undefined;
    }
    const first = src.charCodeAt(offset);
    if (first !== 91 && first !== 33) return; // [ or !
    const cap = execAt(this.rules.inline.link, src, offset, this.rules.cursor?.inline.link);
    if (cap) {
      const labelStart = cap[0].charCodeAt(0) === 33 ? 2 : 1;
      if (!this.options.pedantic && isLabelEndInsideToken(src, cap[1], offset + labelStart, this.rules)) {
        return;
      }

      const url = cap[2];
      const urlStart = trimStartOffset(url, 0, url.length);
      const urlEnd = trimEndOffset(url, urlStart, url.length);
      const endsWithBracket = url.charCodeAt(urlEnd - 1) === 62;
      if (!this.options.pedantic && url.charCodeAt(urlStart) === 60) {
        if (!endsWithBracket || isEscapedAt(url, urlEnd - 1)) return;
      } else {
        // find closing parenthesis
        const lastParenIndex = findClosingParen(cap[2]);
        if (lastParenIndex === -2) {
          // more open parens than closed
          return;
        }

        if (lastParenIndex > -1) {
          const start = cap[0].charCodeAt(0) === 33 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      // The ')' that ends the match is the link closer only when it is not
      // escaped. `[foo](/url\)` has no closer; that paren is destination text.
      if (isEscapedAt(cap[0], cap[0].length - 1)) {
        return;
      }
      let href = cap[2];
      let title = '';
      if (this.options.pedantic) {
        // split pedantic href and title
        const link = this.rules.other.pedanticHrefTitle.exec(href);

        if (link) {
          href = link[1];
          title = link[3];
        }
      } else {
        title = cap[3] ? cap[3].slice(1, -1) : '';
      }

      let hrefStart = href.length === url.length ? urlStart : trimStartOffset(href, 0, href.length);
      let hrefEnd = href.length === url.length ? urlEnd : trimEndOffset(href, hrefStart, href.length);
      if (href.charCodeAt(hrefStart) === 60) {
        hrefStart++;
        if (!this.options.pedantic || endsWithBracket) hrefEnd--;
      }
      href = sourceText(href, hrefStart, hrefEnd);
      return outputLink(cap,
        href ? href.replace(this.rules.inline.anyPunctuation, '$1') : href,
        title ? title.replace(this.rules.inline.anyPunctuation, '$1') : title,
        cap[0], this.lexer, this.rules);
    }
  }

  reflink(src: string, links: Links): Tokens.Link | Tokens.Image | Tokens.Text | undefined {
    return this.reflinkAt(src, links, 0);
  }

  /** @internal */
  /** @hot */
  reflinkAt(src: string, links: Links, offset: number): Tokens.Link | Tokens.Image | Tokens.Text | undefined {
    const first = src.charCodeAt(offset);
    if (first !== 91 && first !== 33) return; // [ or !
    let cap;
    if ((cap = execAt(this.rules.inline.reflink, src, offset, this.rules.cursor?.inline.reflink))
      || (cap = execAt(this.rules.inline.nolink, src, offset, this.rules.cursor?.inline.nolink))) {
      const labelStart = cap[0].charCodeAt(0) === 33 ? 2 : 1;
      if (!this.options.pedantic && isLabelEndInsideToken(src, cap[1], offset + labelStart, this.rules)) {
        return;
      }

      const label = cap[2] || cap[1];
      const link = links[normalizeLabel(label)];
      if (!link) {
        const text = cap[0].charAt(0);
        return createText(text, text, undefined);
      }
      return outputLink(cap, link.href, link.title, cap[0], this.lexer, this.rules);
    }
  }

  emStrong(src: string, maskedSrc: string, prevChar = ''): Tokens.Em | Tokens.Strong | undefined {
    return this.emStrongAt(src, maskedSrc, prevChar, 0, lastCloser(maskedSrc, src.charCodeAt(0)));
  }

  /** @internal */
  /** @hot */
  emStrongAt(src: string, maskedSrc: string, prevChar: string, offset: number, lastPossibleEmStrongCloserIndex: number): Tokens.Em | Tokens.Strong | undefined {
    let match = execAt(this.rules.inline.emStrongLDelim, src, offset, this.rules.cursor?.inline.emStrongLDelim);
    if (!match) return;
    const following = match[1] || match[2] || match[3] || match[4];
    if (!following) return;
    const delimiter = match[0].charCodeAt(0);
    const star = delimiter === 42;
    if (!star && delimiter !== 95) return;
    // A mid-run opener (for example the second star of an unmatched `**`) must
    // only pair with a delimiter that can only close, otherwise it steals the
    // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
    const midRun = prevChar.length === 1 && prevChar.charCodeAt(0) === delimiter;

    // The start of this delimiter run may already be behind src, either taken
    // as text after the whole run failed to match or used to close an earlier
    // span. Flanking and rules 9-10 are about the whole run, so find its start.
    // Pedantic follows markdown.pl, which has no such rules.
    const srcStart = maskedSrc.length - src.length + offset;
    let runStart = srcStart;
    while (!this.options.pedantic && runStart > 0 && maskedSrc.charCodeAt(runStart - 1) === delimiter) {
      runStart--;
    }
    const prevUnit = maskedSrc.charCodeAt(runStart - 1);
    const prevWidth = prevUnit >= 0xdc00 && prevUnit <= 0xdfff && maskedSrc.codePointAt(runStart - 2)! > 0xffff
      ? 2
      : 1;
    const previousStart = runStart - prevWidth;
    const runPrevPunct = punctuationBeforeDelimiter(maskedSrc, previousStart, prevWidth, this.rules);
    const startedBeforeOffset = runStart < srcStart;
    const prevPunct = startedBeforeOffset ? runPrevPunct : punctuationBeforeDelimiter(prevChar, 0, prevChar.length, this.rules);

    // An underscore cannot open between letters or numbers.
    if (match[4]) {
      if (startedBeforeOffset) {
        if (runStart > 0 && alphaNumericAt(maskedSrc, previousStart, prevWidth, this.rules)) return;
      } else if (prevChar.length === 1
        ? alphaNumericAt(prevChar, 0, 1, this.rules)
        : this.rules.other.unicodeAlphaNumeric.test(prevChar)) {
        return;
      }
    }

    const punctAfter = !!(match[1] || match[3]);
    const hasPrevious = startedBeforeOffset ? runStart > 0 : prevChar.length > 0;
    if (!punctAfter || !hasPrevious || prevPunct) {
      const lLength = match[0].length - following.length;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

      // Rules 9-10 count the whole run, and also apply when the opener could
      // close as well (`a*b**`, where `*` is both left- and right-flanking).
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !this.options.pedantic && !isStringWhitespace(prevUnit) && runStart > 0
        && (punctAfter || (star && !runPrevPunct));
      const closerRule = star ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      const emStrongCloserWindowStart = maskedSrc.length - src.length + offset + lLength;
      if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return;
      // An emStrongMask hook can return a string with a different length.
      const scanStart = Math.max(0, emStrongCloserWindowStart);
      const lastCloser = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart + scanStart;
      const endReg = startCloserScan(closerRule, maskedSrc, scanStart, star ? this.rules.cursor?.inline.star : this.rules.cursor?.inline.underscore);

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastCloser) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue; // skip single * in __abc*abc__

        rLength = rDelim.length;

        if (match[3] || match[4]) { // found another Left Delim
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6] || openerCanClose) { // either Left or Right Delim
          if (runLength % 3 && !((runLength + rLength) % 3)) { // CommonMark Emphasis Rules 9-10
            if (midRun && (match[5] || match[6])) {
              // A delimiter that can also open and cannot close this run
              // opens its own span; a later closer pairs with it, not with a
              // mid-run opener (`**a*a*` must be `**a<em>a</em>`).
              break;
            }
            midDelimTotal += rLength;
            continue;
          }
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue; // Haven't found enough closing delimiters

        // Remove extra characters. *a*** -> *a*
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        // char length can be >1 for unicode characters;
        const lastCharLength = match[0].codePointAt(0)! > 0xffff ? 2 : 1;
        const rawEnd = Math.min(src.length, offset + lLength + match.index - scanStart + lastCharLength + rLength);
        const raw = sourceText(src, offset, rawEnd);

        // Create `em` if smallest delimiter has odd char count. *a***
        if (Math.min(lLength, rLength) % 2) {
          const text = sourceText(src, offset + 1, rawEnd - 1);
          return createEm(raw, text, this.lexer.inlineTokens(text));
        }

        // Create 'strong' if smallest delimiter has even char count. **a***
        const text = sourceText(src, offset + 2, rawEnd - 2);
        return createStrong(raw, text, this.lexer.inlineTokens(text));
      }
    }
  }

  codespan(src: string): Tokens.Codespan | undefined {
    return this.codespanAt(src, 0);
  }

  /** @internal */
  /** @hot */
  codespanAt(src: string, offset: number): Tokens.Codespan | undefined {
    if (src.charCodeAt(offset) !== 96) return; // `
    const cap = execAt(this.rules.inline.code, src, offset, this.rules.cursor?.inline.code);
    if (cap) {
      const content = cap[2];
      let start = 0;
      let end = content.length;
      const first = content.charCodeAt(0);
      const last = content.charCodeAt(end - 1);
      if ((first === 32 || first === 10) && (last === 32 || last === 10)) {
        for (let i = 1; i < end - 1; i++) {
          const code = content.charCodeAt(i);
          if (code !== 32 && code !== 10) {
            start++;
            end--;
            break;
          }
        }
      }
      const trimmed = sourceText(content, start, end);
      const text = trimmed.indexOf('\n') < 0 ? trimmed : trimmed.replace(this.rules.other.newLineCharGlobal, ' ');
      return createCodespan(cap[0], text);
    }
  }

  br(src: string): Tokens.Br | undefined {
    return this.brAt(src, 0);
  }

  /** @internal */
  /** @hot */
  brAt(src: string, offset: number): Tokens.Br | undefined {
    const first = src.charCodeAt(offset);
    if (first !== 32 && first !== 92 && first !== 10) return; // space, \\ or newline (breaks)
    const cap = execAt(this.rules.inline.br, src, offset, this.rules.cursor?.inline.br);
    if (cap) {
      return createBr(cap[0]);
    }
  }

  del(src: string, maskedSrc: string, prevChar = ''): Tokens.Del | undefined {
    return this.delAt(src, maskedSrc, prevChar, 0, lastCloser(maskedSrc, 126));
  }

  /** @internal */
  /** @hot */
  delAt(src: string, maskedSrc: string, prevChar: string, offset: number, lastPossibleDelCloserIndex: number): Tokens.Del | undefined {
    if (src.charCodeAt(offset) !== 126) return; // ~
    let match = execAt(this.rules.inline.delLDelim, src, offset, this.rules.cursor?.inline.delLDelim);
    if (!match) return;

    const nextChar = match[1] || '';

    if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
      // unicode Regex counts emoji as 1 char; spread into array for proper count
      const lLength = match[0].charCodeAt(1) === 126 ? 2 : 1;
      let rDelim, rLength, delimTotal = lLength;

      const closerRule = this.rules.inline.delRDelim;
      const delCloserWindowStart = maskedSrc.length - src.length + offset + lLength;
      if (lastPossibleDelCloserIndex < delCloserWindowStart) return;
      // An emStrongMask hook can return a string with a different length.
      const scanStart = Math.max(0, delCloserWindowStart);
      const lastCloser = lastPossibleDelCloserIndex - delCloserWindowStart + scanStart;
      const endReg = startCloserScan(closerRule, maskedSrc, scanStart, this.rules.cursor?.inline.tilde);

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastCloser) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        rLength = rDelim.length;

        if (rLength !== lLength) continue;

        if (match[3] || match[4]) { // found another Left Delim
          delimTotal += rLength;
          continue;
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue; // Haven't found enough closing delimiters

        // Remove extra characters
        rLength = Math.min(rLength, rLength + delimTotal);
        // char length can be >1 for unicode characters
        const lastCharLength = match[0].codePointAt(0)! > 0xffff ? 2 : 1;
        const rawEnd = Math.min(src.length, offset + lLength + match.index - scanStart + lastCharLength + rLength);
        const raw = sourceText(src, offset, rawEnd);

        // Create del token - only single ~ or double ~~ supported
        const text = sourceText(src, offset + lLength, rawEnd - lLength);
        return createDel(raw, text, this.lexer.inlineTokens(text));
      }
    }
  }

  autolink(src: string): Tokens.Link | undefined {
    return this.autolinkAt(src, 0);
  }

  /** @internal */
  /** @hot */
  autolinkAt(src: string, offset: number): Tokens.Link | undefined {
    if (src.charCodeAt(offset) !== 60) return; // <
    const cap = execAt(this.rules.inline.autolink, src, offset, this.rules.cursor?.inline.autolink);
    if (cap) {
      const prefix = cap[2]?.charCodeAt(0) === 64 ? LinkPrefix.Email : LinkPrefix.None;
      return createLink(cap[0], cap[1], null, cap[1], undefined, prefix);
    }
  }

  url(src: string): Tokens.Link | undefined {
    return this.urlAt(src, 0);
  }

  /** @internal */
  /** @hot */
  urlAt(src: string, offset: number): Tokens.Link | undefined {
    let cap;
    if (cap = execAt(this.rules.inline.url, src, offset, this.rules.cursor?.inline.url)) {
      let prefix: number = LinkPrefix.None;
      if (cap[2]?.charCodeAt(0) === 64) {
        prefix = LinkPrefix.Email;
      } else {
        // The URL rule matches a prefix. Remove invalid trailing characters.
        let previousLength;
        do {
          previousLength = cap[0].length;
          cap[0] = this.rules.inline._backpedal.exec(cap[0])?.[0] ?? '';
        } while (previousLength !== cap[0].length);
        if (cap[1]?.charCodeAt(3) === 46) prefix = LinkPrefix.Http;
      }
      return createLink(cap[0], cap[0], null, cap[0], undefined, prefix);
    }
  }

  inlineText(src: string): Tokens.Text | undefined {
    return this.inlineTextAt(src, 0);
  }

  /** @internal */
  /** @hot */
  inlineTextAt(src: string, offset: number): Tokens.Text | undefined {
    const rule = this.rules.inline.text;
    let raw: string | undefined;
    if (rule === inline.normal.text) {
      const end = commonMarkTextEnd(src, offset);
      if (end === offset) return;
      raw = sourceText(src, offset, end);
    } else {
      raw = execAt(rule, src, offset, this.rules.cursor?.inline.text)?.[0];
    }
    if (raw !== undefined) {
      const escaped = this.lexer.state.inRawBlock;
      return createText(raw, escaped ? raw : decodeNumericCharacterReferences(raw), escaped);
    }
  }
}
