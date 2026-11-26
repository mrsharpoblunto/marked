import { execAt, isStringWhitespace, normalizeLabel, sourceText } from './helpers.ts';
import type { Rules } from './rules.ts';
import type { Links } from './Tokens.ts';

export interface InlineMask {
  codes: Uint16Array;
  openerEnds: Int32Array;
  length: number;
  changed: boolean;
}

/** @hot */
export function copyInlineCodes(mask: InlineMask, source: string): void {
  if (mask.codes.length < source.length) growInlineCodes(mask, source.length);
  mask.length = source.length;
  mask.changed = false;
  const codes = mask.codes;
  const ends = mask.openerEnds;
  let runEnd = source.length;
  let next = -1;
  for (let i = source.length - 1; i >= 0; i--) {
    const code = source.charCodeAt(i);
    codes[i] = code;
    if (code !== next) runEnd = i + 1;
    if (code === 42 || code === 95 || code === 126) ends[i] = runEnd;
    next = code;
  }
}

/** @hot */
function growInlineCodes(mask: InlineMask, size: number): void {
  const length = Math.max(size, 64, mask.codes.length * 2);
  mask.codes = new Uint16Array(length);
  mask.openerEnds = new Int32Array(length);
}

/** @hot */
function bracketMask(mask: InlineMask, start: number, end: number): void {
  const codes = mask.codes;
  codes[start] = 91;
  codes.fill(97, start + 1, end - 1);
  codes[end - 1] = 93;
  mask.changed = true;
}

/** @hot */
function referenceLabelEnd(codes: Uint16Array, start: number, end: number): number {
  let first = start;
  while (first < end && isStringWhitespace(codes[first])) first++;
  if (codes[first] === 93) return -1;
  let pos = start;
  for (let count = 0; pos < end && count <= 999; count++) {
    const code = codes[pos];
    if (code === 93) return pos > start ? pos + 1 : -1;
    if (code === 91 || count === 999) break;
    pos += code === 92 ? 2 : 1;
  }
  return -1;
}

/** @hot */
function nestedLabelEnd(codes: Uint16Array, pos: number, end: number): number {
  let level = 1;
  while (++pos < end) {
    const code = codes[pos];
    if (code === 92) pos++;
    else if (code === 91) {
      if (++level > 2) break;
    } else if (code === 93 && --level === 0) return pos + 1;
  }
  return -1;
}

/** @hot */
function ticksEnd(codes: Uint16Array, pos: number, end: number): number {
  while (pos < end && codes[pos] === 96) pos++;
  return pos;
}

/** @hot */
function nextTicks(codes: Uint16Array, pos: number, end: number): number {
  while (pos < end && codes[pos] !== 96) pos++;
  return pos;
}

/** @hot */
function fullReferenceEnd(codes: Uint16Array, pos: number, end: number): number {
  let alternative = -1;
  for (let count = 0; count <= 999; count++) {
    while (pos < end) {
      const code = codes[pos];
      if (code === 91 || code === 92 || code === 93 || code === 96) break;
      pos++;
    }
    if (pos === end) break;
    const code = codes[pos];
    if (code === 93) {
      if (pos + 2 < end && codes[pos + 1] === 91) {
        const ref = referenceLabelEnd(codes, pos + 2, end);
        if (ref >= 0) return ref;
      }
      break;
    }
    if (count === 999) break;
    if (code === 91) {
      pos = nestedLabelEnd(codes, pos, end);
      if (pos < 0) break;
    } else if (code === 92) {
      pos += 2;
      if (pos >= end) break;
    } else {
      const openEnd = ticksEnd(codes, pos, end);
      if (openEnd - pos > 1 && openEnd + 2 < end && codes[openEnd] === 93 && codes[openEnd + 1] === 91) {
        const ref = referenceLabelEnd(codes, openEnd + 2, end);
        if (ref >= 0) alternative = ref;
      }
      const close = nextTicks(codes, openEnd, end);
      if (close === end) break;
      pos = ticksEnd(codes, close, end);
    }
  }
  return alternative;
}

/** @hot */
function referenceEnd(codes: Uint16Array, start: number, end: number): number {
  const open = codes[start] === 33 ? start + 1 : start;
  if (open >= end || codes[open] !== 91) return -1;
  const full = fullReferenceEnd(codes, open + 1, end);
  if (full >= 0) return full;
  const short = referenceLabelEnd(codes, open + 1, end);
  if (short < 0) return -1;
  if (short + 1 < end && codes[short] === 91 && codes[short + 1] === 93
    && (short + 2 === end || codes[short + 2] !== 40)) return short + 2;
  return short === end || codes[short] !== 40 ? short : -1;
}

/** @hot */
function referenceStart(codes: Uint16Array, start: number, end: number): number {
  for (let i = end - 1; i > start; i--) {
    if (codes[i] === 91) return i;
  }
  return start + (codes[start] === 33 ? 1 : 0);
}

/** @hot */
function blockCodeEnd(codes: Uint16Array, start: number, end: number): number {
  const open = ticksEnd(codes, start, end);
  const close = nextTicks(codes, open, end);
  if (close === end) return -1;
  const limit = ticksEnd(codes, close, end);
  return limit - close === open - start ? limit : -1;
}

/** @hot */
function blockLinkEnd(codes: Uint16Array, start: number, end: number): number {
  let pos = start + 1;
  for (; pos < end; pos++) {
    const code = codes[pos];
    if (code === 93) break;
    if (code === 91) return -1;
    if (code === 96) {
      const after = blockCodeEnd(codes, pos, end);
      if (after < 0) return -1;
      pos = after - 1;
    }
  }
  if (pos + 1 >= end || codes[pos + 1] !== 40) return -1;
  let depth = 0;
  while ((pos += 1) + 1 < end) {
    const code = codes[pos + 1];
    if (code === 41) {
      if (depth === 0) return pos + 2;
      depth = 0;
    } else if (code === 40) {
      if (depth) break;
      depth = 1;
    } else if (code === 92) {
      pos++;
    }
  }
  return -1;
}

/** @hot */
function blockAngleEnd(codes: Uint16Array, start: number, end: number): number {
  if (codes[start + 1] === 32) return -1;
  for (let pos = start + 1; pos < end; pos++) {
    const code = codes[pos];
    if (code === 60) break;
    if (code === 62) return pos + 1;
  }
  return -1;
}

/** @hot */
function hasTextLink(mask: InlineMask, source: string, start: number, end: number, rules: Rules, links: Links): boolean {
  const codes = mask.codes;
  for (let i = start; i < end; i++) {
    const code = codes[i];
    let after = -1;
    if (code === 91) {
      after = blockLinkEnd(codes, i, end);
      if (after >= 0 && (i === start || codes[i - 1] !== 33) && rules.inline.link.test(sourceText(source, i, after))) return true;
    } else if (code === 96 && (i === start || codes[i - 1] !== 96)) {
      after = blockCodeEnd(codes, i, end);
    } else if (code === 60) {
      after = blockAngleEnd(codes, i, end);
    }
    if (after >= 0) i = after - 1;
  }
  for (let i = start; i < end; i++) {
    const code = codes[i];
    if (code !== 91 && code !== 33) continue;
    const after = referenceEnd(codes, i, end);
    if (after < 0) continue;
    const ref = referenceStart(codes, i, after);
    if (code !== 33 && Object.hasOwn(links, normalizeLabel(source, ref + 1, after - 1))
      && (ref <= i + 1 || !hasTextLink(mask, source, i + 1, ref - 1, rules, links))) return true;
    i = after - 1;
  }
  return false;
}

/** @hot */
export function maskReferences(mask: InlineMask, source: string, start: number, end: number, rules: Rules, links: Links): void {
  const codes = mask.codes;
  for (let i = start; i < end; i++) {
    const code = codes[i];
    if (code !== 91 && code !== 33) continue;
    const after = referenceEnd(codes, i, end);
    if (after < 0) continue;
    const ref = referenceStart(codes, i, after);
    if (Object.hasOwn(links, normalizeLabel(source, ref + 1, after - 1))) {
      if (ref > i + 1 && code !== 33 && hasTextLink(mask, source, i + 1, ref - 1, rules, links)) {
        maskReferences(mask, source, i + 1, ref - 1, rules, links);
        codes[ref - 1] = 93;
        bracketMask(mask, ref, after);
      } else {
        bracketMask(mask, i, after);
      }
    }
    i = after - 1;
  }
}

const unicodePunctuation = /[\p{P}\p{S}]/uy;

/** @hot */
export function isInlinePunctuation(code: number, source: string, offset: number): boolean {
  if (code <= 127) {
    return (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
      || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
  }
  unicodePunctuation.lastIndex = offset;
  return unicodePunctuation.test(source);
}

const unicodeOpenQuote = /[\p{Pi}\p{Ps}]/uy;

/** @hot */
function isOpenQuote(code: number, source: string, offset: number): boolean {
  if (code <= 127) return code === 34 || code === 39 || code === 40 || code === 91 || code === 123;
  unicodeOpenQuote.lastIndex = offset;
  return unicodeOpenQuote.test(source);
}

/** @hot */
export function delimiterOpener(mask: InlineMask, source: string, offset: number, delimiter: number, gfm: boolean, pedantic: boolean): number {
  const end = mask.openerEnds[offset];
  const length = end - offset;
  if (end >= source.length || (delimiter === 126 && (!gfm || length > 2))) return 0;
  const next = source.charCodeAt(end);
  if (isStringWhitespace(next)) return 0;
  if ((next === 126 && gfm && delimiter !== 126)
    || !isInlinePunctuation(next, source, end)
    || (pedantic && isOpenQuote(next, source, end))) return length;
  return -length;
}

/** @hot */
export function maskEscapes(mask: InlineMask, source: string): void {
  const codes = mask.codes;
  const end = mask.length;
  for (let i = 0; i < end; i++) {
    const code = codes[i];
    if (code === 92 && i + 1 < end && isInlinePunctuation(codes[i + 1], source, i + 1)) {
      const width = source.codePointAt(i + 1)! > 0xffff ? 3 : 2;
      codes.fill(43, i, i + width);
      mask.changed = true;
      i += width - 1;
    } else if (code === 96) {
      const open = ticksEnd(codes, i, end);
      const width = open - i;
      i = open - 1;
      for (let close = nextTicks(codes, open, end); close < end;) {
        const next = ticksEnd(codes, close, end);
        if (next - close === width) {
          for (let pos = open; pos < close; pos++) {
            if (codes[pos] === 96) {
              codes[pos] = 43;
              mask.changed = true;
            }
          }
          i = next - 1;
          break;
        }
        close = nextTicks(codes, next, end);
      }
    }
  }
}

/** @hotIgnore Output: one string of at most end minus start UTF-16 units for the HTML rule. */
export function inlineMaskText(mask: InlineMask, start: number, end: number): string {
  const codes = mask.codes;
  let text = '';
  for (let i = start; i < end; i += 4096) {
    text += String.fromCharCode(...codes.subarray(i, Math.min(i + 4096, end)));
  }
  return text;
}

/** @hot */
function htmlMaskEnd(mask: InlineMask, source: string, start: number, rules: Rules, edited: boolean): number {
  const { tag, autolink } = rules.inline;
  const cursor = rules.cursor?.inline;
  if (!edited) {
    const match = execAt(tag, source, start, cursor?.tag) || execAt(autolink, source, start, cursor?.autolink);
    return match ? start + match[0].length : -1;
  }
  let end = mask.length;
  while (mask.codes[end - 1] !== 62) end--;
  const text = inlineMaskText(mask, start, end);
  const match = tag.exec(text) || autolink.exec(text);
  return match ? start + match[0].length : -1;
}

/** @hot */
export function maskBlocks(mask: InlineMask, source: string, rules: Rules): void {
  const codes = mask.codes;
  const end = mask.length;
  const edited = mask.changed;
  for (let i = 0; i < end; i++) {
    const code = codes[i];
    let after = -1;
    if (code === 91) after = blockLinkEnd(codes, i, end);
    else if (code === 96 && (i === 0 || codes[i - 1] !== 96)) after = blockCodeEnd(codes, i, end);
    else if (code === 60 && blockAngleEnd(codes, i, end) >= 0) after = htmlMaskEnd(mask, source, i, rules, edited);
    if (after < 0) continue;
    bracketMask(mask, i, after);
    i = after - 1;
  }
}
