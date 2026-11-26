import { createBlockquote, createBr, createCheckbox, createCode, createCodespan, createDef, createDel, createEm, createEscape, createHeading, createHr, createHtml, createImage, createLink, createList, createListItem, createParagraph, createSpace, createStrong, createTable, createTableCell, createText } from './tokenFactories.ts';
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
  sourceText,
  trimStartOffset,
  trimEndOffset,
  isStringWhitespace,
  startCloserScan,
  lastCloser,
} from './helpers.ts';
import { block, inline, type Rules } from './rules.ts';
import type { _Lexer } from './Lexer.ts';
import type { Links, Tokens, Token } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/** @hot */
function countCodePoints(text: string) {
  let count = 0;
  for (let i = 0; i < text.length; i++, count++) {
    if (text.codePointAt(i)! > 0xffff) i++;
  }
  return count;
}

/**
 * Remove the bracket escapes that the label match consumed, but leave code
 * spans untouched: their content is literal, so a `\[` or `\]` inside a
 * code span is not an escape.
 */
function unescapeLinkLabel(label: string, rules: Rules): string {
  let result = '';
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '`') {
      const code = execAt(rules.inline.code, label, i);
      if (code) {
        result += code[0];
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] === '\\' && (label[i + 1] === '[' || label[i + 1] === ']')) {
      result += label[i + 1];
      i++;
      continue;
    }
    result += label[i];
  }
  return result;
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

  return isImage ? createImage(raw, href, title, text, tokens) : createLink(raw, href, title, text, tokens, false);
}

function indentCodeCompensation(raw: string, text: string, rules: Rules, canExpandTabs: boolean) {
  const matchIndentToCode = raw.match(rules.other.indentCodeCompensation);

  if (matchIndentToCode === null) {
    return text;
  }

  const indent = matchIndentToCode[1].length;

  return text
    .split('\n')
    .map(node => {
      const matchIndentInNode = node.match(rules.other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }

      const [indentInNode] = matchIndentInNode;
      const tab = indentInNode.indexOf('\t');
      if (tab !== -1 && tab < indent) {
        if (canExpandTabs) {
          // The fence indent is at most three spaces. A tab within that indent
          // reaches column four, leaving the remaining columns as code content.
          return ' '.repeat(4 - indent) + node.slice(tab + 1);
        }
        // Container tokens lack the original tab column. Keep their existing
        // behavior for lines whose indentation ends inside a tab.
        if (raw[indent] === '~') {
          return node;
        }
      }

      // Up to the fence's own indentation is removed from each line, so a line
      // indented less than the fence loses whatever indentation it has.
      return node.slice(Math.min(indentInNode.length, indent));
    })
    .join('\n');
}

function isLabelEndInsideToken(src: string, label: string, labelStart: number, rules: Rules) {
  if (!label.includes('<')) {
    return false;
  }

  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }

    if (label[i] === '`') {
      const code = execAt(rules.inline.code, label, i);
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }

    if (label[i] !== '<') {
      continue;
    }

    const token = execAt(rules.inline.tag, src, labelStart + i)
      || execAt(rules.inline.autolink, src, labelStart + i);
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

const standardListRule = block.normal.list;
const commonMarkParagraphRule = block.normal.paragraph;
const gfmParagraphRule = block.gfm.paragraph;
const pedanticParagraphRule = block.pedantic.paragraph;

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
function hasTableDelimiter(src: string): boolean {
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code === 58 || code === 124) return true;
  }
  return false;
}

/** @hotIgnore Output: one alignment array with one entry per column. */
function tableAlignments(src: string): Tokens.Table['align'] {
  const alignment: Tokens.Table['align'] = [];
  let first = src.charCodeAt(0) === 124 ? 1 : 0;
  let end = src.length;
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

/**
 * Tokenizer
 */
export class _Tokenizer<ParserOutput = string, RendererOutput = string> {
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
  codeAt(src: string, offset: number): Tokens.Code | undefined {
    const cap = execAt(this.rules.block.code, src, offset);
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
  fencesAt(src: string, offset: number): Tokens.Code | undefined {
    const cap = execAt(this.rules.block.fences, src, offset);
    if (cap) {
      const raw = cap[0];
      let text = indentCodeCompensation(raw, cap[3] || '', this.rules, this.lexer.state.top && !this.lexer.state.inBlockquote);
      // The fence pattern consumes the final content newline outside the capture.
      // Keep it when the captured content ends in a blank line.
      if (cap[3] !== undefined && (text === '' || text.endsWith('\n'))) {
        text += '\n';
      }

      return createCode(raw, text, cap[2] ? cap[2].trim().replace(this.rules.inline.anyPunctuation, '$1') : cap[2], false);
    }
  }

  heading(src: string): Tokens.Heading | undefined {
    return this.headingAt(src, 0);
  }

  /** @internal */
  headingAt(src: string, offset: number): Tokens.Heading | undefined {
    const cap = execAt(this.rules.block.heading, src, offset);
    if (cap) {
      const start = trimStartOffset(cap[2], 0, cap[2].length);
      let end = trimEndOffset(cap[2], start, cap[2].length);
      let hash = end;
      while (hash > start && cap[2].charCodeAt(hash - 1) === 35) hash--;
      const beforeHash = cap[2].charCodeAt(hash - 1);
      if (hash < end && (this.options.pedantic || hash === start || beforeHash === 32 || beforeHash === 9)) {
        end = trimEndOffset(cap[2], start, hash);
      }
      const text = sourceText(cap[2], start, end);

      return createHeading(withoutTrailingNewlines(cap[0]), cap[1].length, text, this.lexer.inline(text));
    }
  }

  hr(src: string): Tokens.Hr | undefined {
    return this.hrAt(src, 0);
  }

  /** @internal */
  hrAt(src: string, offset: number): Tokens.Hr | undefined {
    let end = offset;
    while (end < offset + 3 && src.charCodeAt(end) === 32) end++;

    const marker = src.charCodeAt(end);
    if (marker !== 45 && marker !== 95 && marker !== 42) return;

    let count = 0;
    while (end < src.length) {
      const code = src.charCodeAt(end);
      if (code === marker) {
        count++;
      } else if (code !== 32 && code !== 9) {
        break;
      }
      end++;
    }
    if (count >= 3 && (end === src.length || src.charCodeAt(end) === 10)) {
      return createHr(sourceText(src, offset, end));
    }
  }

  blockquote(src: string): Tokens.Blockquote | undefined {
    return this.blockquoteAt(src, 0);
  }

  /** @internal */
  blockquoteAt(src: string, offset: number): Tokens.Blockquote | undefined {
    const cap = execAt(this.rules.block.blockquote, src, offset);
    if (cap) {
      let quoteEnd = offset + cap[0].length;
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
          if (execAt(this.rules.other.blockquoteStart, src, start)) {
            inBlockquote = true;
          } else if (inBlockquote) {
            break;
          }
          end = line;
          start = line + 1;
        }

        const currentRaw = src.slice(position, end);
        position = end + 1;
        rawEnd = end;
        // Only the outermost block quote knows the original tab columns.
        let currentText = currentRaw;
        if (currentRaw.includes('\t')) {
          if (this.lexer.state.top && !this.lexer.state.inBlockquote) {
            currentText = expandBlockquoteTabs(currentRaw);
          }
          currentText = currentText.replace(
            this.rules.other.blockquoteMarkerWhitespace,
            (_: string, marker: string, whitespace: string) => {
              if (whitespace.startsWith(' ')) {
                return marker + ' ' + whitespace.slice(1);
              }
              return marker + expandTabs(whitespace, marker.length);
            },
          );
        }
        currentText = currentText
          // precede setext continuation with 4 spaces so it isn't a setext
          .replace(this.rules.other.blockquoteSetextReplace, '\n    $1')
          .replace(this.rules.other.blockquoteSetextReplace2, '');
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

        if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
          // blockquote continuation cannot be preceded by a code block, heading, hr, html block or table
          break;
        } else if (lastToken?.type === 'blockquote') {
          // include continuation in nested blockquote
          const oldToken = lastToken as Tokens.Blockquote;
          // The continuation lines belong to the same nesting frame as the
          // nested blockquote, which already had one '>' marker stripped, so
          // strip one marker from them too. Otherwise a restated marker after a
          // lazy line is re-parsed as a spurious deeper blockquote.
          const remaining = src.slice(position, quoteEnd);
          const newText = oldToken.raw + '\n' + remaining.replace(this.rules.other.blockquoteSetextReplace2, '');
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
          if (position < quoteEnd && execAt(this.rules.other.blockquoteStart, src, position)) {
            continue;
          }
          break;
        } else if (lastToken?.type === 'list') {
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

          if (position < quoteEnd && !execAt(this.rules.other.blockquoteStart, src, position)) {
            break;
          }
          continue;
        }
      }

      return createBlockquote(sourceText(src, offset, rawEnd), text, tokens);
    }
  }

  list(src: string): Tokens.List | undefined {
    return this.listAt(src, 0);
  }

  /** @internal */
  listAt(src: string, offset: number): Tokens.List | undefined {
    const standardRule = this.rules.block.list === standardListRule;
    const cap = standardRule ? undefined : execAt(this.rules.block.list, src, offset);
    const markerEnd = standardRule ? firstListMarkerEnd(src, offset) : cap?.[1].length ?? 0;
    if (markerEnd || cap) {
      // Inside a list item, paragraph lines are lexed as text tokens, so a list after one would
      // interrupt the paragraph. Only a non-empty list starting with a bullet or 1 can do that
      if (!this.options.pedantic && this.lexer.state.lastToken?.type === 'text'
        && !execAt(this.rules.other.listInterruptsParagraph, src, offset)) {
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

      const list: Tokens.List = createList('', isordered, start, false, []);

      let previousBlankLine = false;
      // Check if current bullet point can start a new List Item
      while (offset < src.length) {
        let endEarly = false;
        let itemContents = '';
        const bulletIndent = listMarkerEnd(src, offset, marker, isordered, !!this.options.pedantic);
        if (bulletIndent === 0) {
          break;
        }

        if (execAt(this.rules.block.hr, src, offset)) {
          break;
        }

        const itemStart = offset;
        const firstLineEnd = lineEnd(src, offset + bulletIndent);
        const firstLine = src.slice(offset + bulletIndent, firstLineEnd);
        offset = Math.min(src.length, firstLineEnd + 1);

        let line = this.options.pedantic
          ? expandTabs(firstLine, bulletIndent)
          : firstLine.replace(this.rules.other.leadingSpaceTab, whitespace => expandTabs(whitespace, bulletIndent));
        let nextLine = '';
        let blankLine = trimStartOffset(line, 0, line.length) === line.length;

        let indent = 0;
        if (this.options.pedantic) {
          indent = 2;
          itemContents = line.trimStart();
        } else if (blankLine) {
          indent = bulletIndent + 1;
        } else {
          indent = line.search(this.rules.other.nonSpaceChar); // Find first non-space char
          indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent
          itemContents = line.slice(indent);
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
          const pedantic = !!this.options.pedantic;
          const hrRegex = this.rules.other.hrRegex(indent);
          const htmlBeginRegex = this.rules.other.htmlBeginRegex(indent);

          // A lazy line continues a paragraph, so it is not checked for the start of a block
          let lineIsLazy = false;

          // Check if following lines should be included in List Item
          while (offset < src.length) {
            const rawLine = src.slice(offset, lineEnd(src, offset));
            let nextLineWithoutTabs;
            nextLine = rawLine;

            // Re-align to follow commonmark nesting rules
            if (this.options.pedantic) {
              nextLine = nextLine.replace(this.rules.other.listReplaceNesting, '  ');
              nextLineWithoutTabs = nextLine;
            } else {
              nextLineWithoutTabs = nextLine.replace(this.rules.other.leadingSpaceTab, whitespace => expandTabs(whitespace));
            }

            if (startsListInterrupt(nextLine, maxIndent, pedantic, true) || htmlBeginRegex.test(nextLine)) {
              break;
            }

            // Horizontal rule found
            if (hrRegex.test(nextLine)) {
              break;
            }

            if (nextLineWithoutTabs.search(this.rules.other.nonSpaceChar) >= indent || trimStartOffset(nextLine, 0, nextLine.length) === nextLine.length) { // Dedent if possible
              itemContents += '\n' + nextLineWithoutTabs.slice(indent);
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
              let lastBlock = line;
              if (!this.options.pedantic && !itemContents.includes('\n') && !line.includes('\t')) {
                let marker;
                while (!hrRegex.test(lastBlock) && (marker = this.rules.other.nestedBlockMarker.exec(lastBlock))) {
                  lastBlock = lastBlock.slice(marker[0].length);
                }
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
              if (hrRegex.test(lastBlock)) {
                break;
              }
              if (!this.options.pedantic && !lineIsLazy) {
                // `line` is relative to the item content, so a block on it can be indented up to 3 spaces whatever
                // the item indent is. A nested list item or blockquote on it, as in `- # heading` or `> ---`, holds
                // a block that a lazy line cannot continue either, so check what follows those markers too.
                const lastBlockLine = line.replace(this.rules.other.nestedContainerMarkers, '');
                if (this.rules.block.fences.test(lastBlockLine) || this.rules.block.heading.test(lastBlockLine) || this.rules.block.hr.test(lastBlockLine)) {
                  break;
                }
              }

              // A lazy continuation can look like a setext underline after
              // list indentation is removed. Keep it in the paragraph.
              const setextContinuation = !this.options.pedantic
                && /^ {0,3}(?:=+|-+) *$/.test(nextLine)
                && this.rules.block.lheading.test(`${line}\n${nextLine}`);
              const continuation = setextContinuation
                ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
                : nextLine;
              itemContents += '\n' + continuation;
              lineIsLazy = true;
            }

            blankLine = trimStartOffset(nextLine, 0, nextLine.length) === nextLine.length;

            offset = Math.min(src.length, offset + rawLine.length + 1);
            line = nextLineWithoutTabs.slice(indent);
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

        list.items.push(createListItem(raw, !!this.options.gfm && this.rules.other.listIsTask.test(itemContents), false, itemContents, []));
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
          item.text = item.text.replace(this.rules.other.listReplaceTask, '');
          itemToken.raw = itemToken.raw.replace(this.rules.other.listReplaceTask, '');
          itemToken.text = itemToken.text.replace(this.rules.other.listReplaceTask, '');
          // The first token queued its text first, so its entry is found right away
          const inlineQueue = this.lexer.inlineQueue;
          for (let j = queueStarts[i]; j < inlineQueue.length; j++) {
            if (inlineQueue[j].tokens === itemToken.tokens) {
              inlineQueue[j].src = inlineQueue[j].src.replace(this.rules.other.listReplaceTask, '');
              break;
            }
          }

          const taskRaw = this.rules.other.listTaskCheckbox.exec(item.raw);
          if (taskRaw) {
            const checkboxToken: Tokens.Checkbox = createCheckbox(taskRaw[0] + ' ', taskRaw[0].charCodeAt(1) !== 32);
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
  htmlAt(src: string, offset: number): Tokens.HTML | undefined {
    const cap = execAt(this.rules.block.html, src, offset);
    if (cap) {
      // an html block of type 7 cannot interrupt a paragraph, so a lazy
      // continuation line that starts one continues the paragraph instead
      if (this.lexer.state.lastToken?.type === 'paragraph' && !execAt(this.rules.other.htmlBeginRegex(4), src, offset)) {
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
    const cap = execAt(this.rules.block.def, src, offset);
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
  tableAt(src: string, offset: number): Tokens.Table | undefined {
    let headers: string[] | undefined;
    let aligns: Tokens.Table['align'] | undefined;
    if (this.options.gfm && !this.options.pedantic) {
      const header = execAt(this.rules.other.tableHeader, src, offset);
      if (!header || !hasTableDelimiter(header[2])) {
        return;
      }
      headers = splitCells(header[1], 0, header[1].length, 0);
      aligns = tableAlignments(header[2]);
      if (headers.length !== aligns.length) {
        return;
      }
    }
    const cap = execAt(this.rules.block.table, src, offset);
    if (!cap) {
      return;
    }

    if (!hasTableDelimiter(cap[2])) {
      // delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading
      return;
    }

    headers ??= splitCells(cap[1], 0, cap[1].length, 0);
    aligns ??= tableAlignments(cap[2]);

    const item: Tokens.Table = createTable(withoutTrailingNewlines(cap[0]), [], aligns, []);

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
  lheadingAt(src: string, offset: number): Tokens.Heading | undefined {
    const cap = execAt(this.rules.block.lheading, src, offset);
    if (cap) {
      const start = trimStartOffset(cap[1], 0, cap[1].length);
      const text = sourceText(cap[1], start, trimEndOffset(cap[1], start, cap[1].length));
      return createHeading(withoutTrailingNewlines(cap[0]), cap[2].charAt(0) === '=' ? 1 : 2, text, this.lexer.inline(text));
    }
  }

  paragraph(src: string): Tokens.Paragraph | undefined {
    return this.paragraphAt(src, 0);
  }

  /** @internal */
  paragraphAt(src: string, offset: number): Tokens.Paragraph | undefined {
    const rule = this.rules.block.paragraph;
    let raw: string;
    let text: string;
    if (src.length > offset && src.indexOf('\n', offset) === -1
      && (rule === commonMarkParagraphRule || rule === gfmParagraphRule || rule === pedanticParagraphRule)) {
      raw = text = sourceText(src, offset, src.length);
    } else {
      const cap = execAt(rule, src, offset);
      if (!cap) return;
      raw = cap[0];
      text = cap[1];
      if (text.charCodeAt(text.length - 1) === 10) {
        text = text.slice(0, -1);
      }
    }
    return createParagraph(raw, text, this.lexer.inline(text));
  }

  text(src: string): Tokens.Text | undefined {
    return this.textAt(src, 0);
  }

  /** @internal */
  textAt(src: string, offset: number): Tokens.Text | undefined {
    const cap = execAt(this.rules.block.text, src, offset);
    if (cap) {
      let raw = cap[0];
      let text = cap[0];
      // Indented code cannot interrupt the text, so indented lines continue it
      // up to the next blank line
      const continuation = execAt(this.rules.other.textIndentedContinuation, src, offset + raw.length);
      if (continuation) {
        raw += continuation[0];
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
    const cap = execAt(this.rules.inline.escape, src, offset);
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
    const cap = execAt(this.rules.inline.tag, src, offset);
    if (cap) {
      if (!this.lexer.state.inLink && this.rules.other.startATag.test(cap[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && this.rules.other.endATag.test(cap[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = false;
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
    const cap = execAt(this.rules.inline.link, src, offset);
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
    if ((cap = execAt(this.rules.inline.reflink, src, offset))
      || (cap = execAt(this.rules.inline.nolink, src, offset))) {
      const labelStart = cap[0].charCodeAt(0) === 33 ? 2 : 1;
      if (!this.options.pedantic && isLabelEndInsideToken(src, cap[1], offset + labelStart, this.rules)) {
        return;
      }

      const link = links[normalizeLabel(cap[2] || cap[1])];
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
    let match = execAt(this.rules.inline.emStrongLDelim, src, offset);
    if (!match) return;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return;

    const delimChar = match[0][0];
    // A mid-run opener (for example the second star of an unmatched `**`) must
    // only pair with a delimiter that can only close, otherwise it steals the
    // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
    const midRun = prevChar === delimChar;

    // The start of this delimiter run may already be behind src, either taken
    // as text after the whole run failed to match or used to close an earlier
    // span. Flanking and rules 9-10 are about the whole run, so find its start.
    // Pedantic follows markdown.pl, which has no such rules.
    const srcStart = maskedSrc.length - src.length + offset;
    let runStart = srcStart;
    while (!this.options.pedantic && runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
      runStart--;
    }
    const prevUnit = maskedSrc.charCodeAt(runStart - 1);
    const prevWidth = prevUnit >= 0xdc00 && prevUnit <= 0xdfff && maskedSrc.codePointAt(runStart - 2)! > 0xffff
      ? 2
      : 1;
    const runPrevChar = runStart > 0 ? maskedSrc.slice(runStart - prevWidth, runStart) : '';
    // The other delimiter character counts as punctuation here (`_**a*`, `*_#_`)
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!this.rules.inline.punctuation.exec(runPrevChar);
    if (runStart < srcStart) {
      prevChar = runPrevChar;
    }
    const prevPunct = runStart < srcStart
      ? runPrevPunct
      : prevChar === '*' || prevChar === '_' || !!this.rules.inline.punctuation.exec(prevChar);

    // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
    if (match[4] && prevChar.match(this.rules.other.unicodeAlphaNumeric)) return;

    const nextChar = match[1] || match[3] || '';

    if (!nextChar || !prevChar || prevPunct) {
      // The delimiter rules count Unicode code points.
      const lLength = countCodePoints(match[0]) - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

      // Rules 9-10 count the whole run, and also apply when the opener could
      // close as well (`a*b**`, where `*` is both left- and right-flanking).
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !this.options.pedantic && !isStringWhitespace(runPrevChar.charCodeAt(0)) && runStart > 0
        && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      if (delimChar !== '*' && delimChar !== '_') return;
      const closerRule = delimChar === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      const emStrongCloserWindowStart = maskedSrc.length - src.length + offset + lLength;
      if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return;
      // An emStrongMask hook can return a string with a different length.
      const scanStart = Math.max(0, emStrongCloserWindowStart);
      const lastCloser = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart + scanStart;
      const endReg = startCloserScan(closerRule, maskedSrc, scanStart);

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastCloser) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue; // skip single * in __abc*abc__

        rLength = countCodePoints(rDelim);

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
    const cap = execAt(this.rules.inline.code, src, offset);
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
    const cap = execAt(this.rules.inline.br, src, offset);
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
    let match = execAt(this.rules.inline.delLDelim, src, offset);
    if (!match) return;

    const nextChar = match[1] || '';

    if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
      // unicode Regex counts emoji as 1 char; spread into array for proper count
      const lLength = countCodePoints(match[0]) - 1;
      let rDelim, rLength, delimTotal = lLength;

      const closerRule = this.rules.inline.delRDelim;
      const delCloserWindowStart = maskedSrc.length - src.length + offset + lLength;
      if (lastPossibleDelCloserIndex < delCloserWindowStart) return;
      // An emStrongMask hook can return a string with a different length.
      const scanStart = Math.max(0, delCloserWindowStart);
      const lastCloser = lastPossibleDelCloserIndex - delCloserWindowStart + scanStart;
      const endReg = startCloserScan(closerRule, maskedSrc, scanStart);

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastCloser) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        rLength = countCodePoints(rDelim);

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
    const cap = execAt(this.rules.inline.autolink, src, offset);
    if (cap) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[1];
        href = 'mailto:' + text;
      } else {
        text = cap[1];
        href = text;
      }

      return createLink(cap[0], href, null, text, [
        createText(text, text, undefined),
      ], true);
    }
  }

  url(src: string): Tokens.Link | undefined {
    return this.urlAt(src, 0);
  }

  /** @internal */
  /** @hot */
  urlAt(src: string, offset: number): Tokens.Link | undefined {
    let cap;
    if (cap = execAt(this.rules.inline.url, src, offset)) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        // do extended autolink path validation
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = this.rules.inline._backpedal.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        if (cap[1] === 'www.') {
          href = 'http://' + cap[0];
        } else {
          href = cap[0];
        }
      }
      return createLink(cap[0], href, null, text, [
        createText(text, text, undefined),
      ], true);
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
      raw = execAt(rule, src, offset)?.[0];
    }
    if (raw !== undefined) {
      const escaped = this.lexer.state.inRawBlock;
      return createText(raw, escaped ? raw : decodeNumericCharacterReferences(raw), escaped);
    }
  }
}
