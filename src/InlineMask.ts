import { execAt, isStringWhitespace, normalizeLabel, sourceText } from './helpers.ts';
import { supportsLookbehind, type Rules } from './rules.ts';
import type { Links } from './Tokens.ts';

export interface InlineMask {
  codes: Uint16Array;
  rawCodes: Uint16Array;
  parent: InlineMask | undefined;
  segments: number[];
  nextParen: Int32Array;
  openerEnds: Int32Array;
  nextEvent: Int32Array;
  spans: number[];
  window: MaskWindow | undefined;
  length: number;
  lastEdit: number;
}

/** @hot */
export function copyInlineCodes(runs: InlineRuns, source: string): void {
  const mask = runs.mask;
  runs.length = 0;
  if (mask.openerEnds.length < source.length) growInlineIndexes(mask, source.length);
  if (mask.codes.length < source.length) {
    mask.codes = new Uint16Array(mask.openerEnds.length);
    mask.rawCodes = new Uint16Array(mask.openerEnds.length);
  }
  mask.length = source.length;
  mask.lastEdit = 0;
  const codes = mask.codes;
  const raw = mask.rawCodes;
  const nextParen = mask.nextParen;
  const ends = mask.openerEnds;
  const nextEvent = mask.nextEvent;
  mask.spans.length = 0;
  mask.window = mask.parent = undefined;
  let eventStart = 0;
  let parenStart = 0;
  for (let i = 0; i < source.length;) {
    const code = source.charCodeAt(i);
    if (code === 42 || code === 95 || code === 126) {
      const start = i++;
      while (source.charCodeAt(i) === code) i++;
      codes.fill(code, start, i);
      raw.fill(code, start, i);
      ends.fill(i, start, i);
      addInlineRun(runs, start, i, code);
    } else {
      codes[i] = raw[i] = code;
      if (eventCode[code]) {
        nextEvent.fill(i, eventStart, i + 1);
        eventStart = i + 1;
        if (code === 41) {
          nextParen.fill(i, parenStart, i + 1);
          parenStart = i + 1;
        }
      }
      i++;
    }
  }
  nextEvent.fill(source.length, eventStart, source.length);
  nextParen.fill(source.length, parenStart, source.length);
}

/** @hot */
function growInlineIndexes(mask: InlineMask, size: number): void {
  const length = Math.max(size, 64, mask.openerEnds.length * 2);
  mask.nextParen = new Int32Array(length);
  mask.openerEnds = new Int32Array(length);
  mask.nextEvent = new Int32Array(length);
}

/** @hot */
export function projectInlineLabel(mask: InlineMask, root: InlineMask, start: number, end: number, removed: number[]): void {
  const length = end - start - removed.length;
  if (mask.openerEnds.length < length) growInlineIndexes(mask, length);
  mask.length = length;
  mask.lastEdit = 0;
  mask.spans.length = 0;
  mask.parent = root;
  const segments = mask.segments;
  segments.length = 0;
  let from = start;
  let dest = 0;
  let lastEvent = 0;
  let lastParen = 0;
  for (let i = 0; i <= removed.length; i++) {
    const to = i === removed.length ? end : start + removed[i];
    const size = to - from;
    if (size) segments.push(dest, from);
    for (let j = from; j < to;) {
      const event = root.nextEvent[j];
      if (event >= to) break;
      const pos = dest + event - from;
      mask.nextEvent.fill(pos, lastEvent, pos + 1);
      lastEvent = pos + 1;
      j = event + 1;
    }
    for (let j = from; j < to;) {
      const paren = root.nextParen[j];
      if (paren >= to) break;
      const pos = dest + paren - from;
      mask.nextParen.fill(pos, lastParen, pos + 1);
      lastParen = pos + 1;
      j = paren + 1;
    }
    dest += size;
    from = to + 1;
  }
  mask.nextEvent.fill(length, lastEvent, length);
  mask.nextParen.fill(length, lastParen, length);
}

const Event = {
  Bang: 1,
  OpenParen: 2,
  CloseParen: 4,
  OpenAngle: 8,
  CloseAngle: 16,
  OpenBracket: 32,
  Backslash: 64,
  CloseBracket: 128,
  Tick: 256,
} as const;

const eventCode = new Uint16Array(128);
eventCode[33] = Event.Bang;
eventCode[40] = Event.OpenParen;
eventCode[41] = Event.CloseParen;
eventCode[60] = Event.OpenAngle;
eventCode[62] = Event.CloseAngle;
eventCode[91] = Event.OpenBracket;
eventCode[92] = Event.Backslash;
eventCode[93] = Event.CloseBracket;
eventCode[96] = Event.Tick;

const MaskCode = {
  Brackets: 0,
  Plus: 43,
  CloseBracket: 93,
} as const;

export interface MaskWindow {
  edits: number[];
  spans: number[];
  starts: number[];
  stage: number;
}

/** @hot */
function findMaskCode(edits: number[], start: number, end: number, pos: number): number {
  let first = start / 3;
  let last = end / 3;
  while (first < last) {
    const middle = (first + last) >> 1;
    const index = middle * 3;
    if (pos < edits[index]) last = middle;
    else if (pos >= edits[index + 1]) first = middle + 1;
    else {
      const code = edits[index + 2];
      if (code !== MaskCode.Brackets) return code;
      return pos === edits[index] ? 91 : pos + 1 === edits[index + 1] ? 93 : 97;
    }
  }
  return -1;
}

/** @hot */
export function inlineMaskCode(mask: InlineMask, pos: number): number {
  const window = mask.window;
  if (!window) return mask.codes[pos];
  const edits = window.edits;
  let end = edits.length;
  for (let stage = window.stage; stage >= 0; stage--) {
    const start = window.starts[stage];
    const code = findMaskCode(edits, start, end, pos);
    if (code >= 0) return code;
    end = start;
  }
  return unmaskedCode(mask, pos);
}

/** @hot */
function unmaskedCode(mask: InlineMask, pos: number): number {
  const parent = mask.parent;
  if (!parent || pos < 0 || pos >= mask.length) return mask.rawCodes[pos];
  const segments = mask.segments;
  let first = 0;
  let end = segments.length / 2;
  while (first + 1 < end) {
    const middle = (first + end) >> 1;
    if (segments[middle * 2] > pos) end = middle;
    else first = middle;
  }
  const index = first * 2;
  return unmaskedCode(parent, segments[index + 1] + pos - segments[index]);
}

/** @hot */
export function advanceMaskStage(mask: InlineMask): void {
  const window = mask.window;
  if (window) window.starts[++window.stage] = window.edits.length;
}

/** @hot */
function writeMask(mask: InlineMask, start: number, end: number, code: number): void {
  const window = mask.window;
  if (window) {
    window.edits.push(start, end, code);
  } else if (code === MaskCode.Brackets) {
    const codes = mask.codes;
    codes[start] = 91;
    codes.fill(97, start + 1, end - 1);
    codes[end - 1] = 93;
  } else {
    mask.codes.fill(code, start, end);
  }
  mask.lastEdit = Math.max(mask.lastEdit, end);
}

/** @hot */
function nextEvent(mask: InlineMask, start: number, end: number, events: number): number {
  const next = mask.nextEvent;
  for (let i = start; i < end;) {
    const pos = next[i];
    if (pos >= end) break;
    if (eventCode[inlineMaskCode(mask, pos)] & events) return pos;
    i = pos + 1;
  }
  return end;
}

/** @hot */
function referenceLabelEnd(mask: InlineMask, start: number, end: number): number {
  let first = start;
  while (first < end && isStringWhitespace(inlineMaskCode(mask, first))) first++;
  if (first < end && inlineMaskCode(mask, first) === 93) return -1;

  let pos = start;
  let length = 0;
  while (pos < end) {
    const event = nextEvent(mask, pos, end, Event.OpenBracket | Event.CloseBracket | Event.Backslash);
    length += event - pos;
    if (event === end || length > 999) break;
    const code = inlineMaskCode(mask, event);
    if (code === 93) return event > start ? event + 1 : -1;
    if (code === 91 || length === 999) break;
    pos = event + 2;
    length++;
  }
  return -1;
}

/** @hot */
function nestedLabelEnd(mask: InlineMask, pos: number, end: number): number {
  let level = 1;
  pos++;
  while (pos < end) {
    pos = nextEvent(mask, pos, end, Event.OpenBracket | Event.CloseBracket | Event.Backslash);
    if (pos === end) break;
    const code = inlineMaskCode(mask, pos++);
    if (code === 92) pos++;
    else if (code === 91) {
      if (++level > 2) break;
    } else if (--level === 0) return pos;
  }
  return -1;
}

/** @hot */
function ticksEnd(mask: InlineMask, pos: number, end: number): number {
  while (pos < end && inlineMaskCode(mask, pos) === 96) pos++;
  return pos;
}

/** @hot */
function fullReferenceEnd(mask: InlineMask, pos: number, end: number): number {
  let alternative = -1;
  for (let count = 0; count <= 999; count++) {
    pos = nextEvent(mask, pos, end, Event.OpenBracket | Event.CloseBracket | Event.Backslash | Event.Tick);
    if (pos === end) break;
    const code = inlineMaskCode(mask, pos);
    if (code === 93) {
      if (pos + 2 < end && inlineMaskCode(mask, pos + 1) === 91) {
        const ref = referenceLabelEnd(mask, pos + 2, end);
        if (ref >= 0) return ref;
      }
      break;
    }
    if (count === 999) break;
    if (code === 91) {
      pos = nestedLabelEnd(mask, pos, end);
      if (pos < 0) break;
    } else if (code === 92) {
      pos += 2;
      if (pos >= end) break;
    } else {
      const openEnd = ticksEnd(mask, pos, end);
      if (openEnd - pos > 1 && openEnd + 2 < end && inlineMaskCode(mask, openEnd) === 93 && inlineMaskCode(mask, openEnd + 1) === 91) {
        const ref = referenceLabelEnd(mask, openEnd + 2, end);
        if (ref >= 0) alternative = ref;
      }
      const close = nextEvent(mask, openEnd, end, Event.Tick);
      if (close === end) break;
      pos = ticksEnd(mask, close, end);
    }
  }
  return alternative;
}

/** @hot */
function referenceEnd(mask: InlineMask, start: number, end: number): number {
  const open = inlineMaskCode(mask, start) === 33 ? start + 1 : start;
  if (open >= end || inlineMaskCode(mask, open) !== 91) return -1;
  const full = fullReferenceEnd(mask, open + 1, end);
  if (full >= 0) return full;
  const short = referenceLabelEnd(mask, open + 1, end);
  if (short < 0) return -1;
  if (short + 1 < end && inlineMaskCode(mask, short) === 91 && inlineMaskCode(mask, short + 1) === 93
    && (short + 2 === end || inlineMaskCode(mask, short + 2) !== 40)) return short + 2;
  return short === end || inlineMaskCode(mask, short) !== 40 ? short : -1;
}

/** @hot */
function referenceStart(mask: InlineMask, start: number, end: number): number {
  let ref = start;
  for (let i = start + 1; i < end;) {
    const open = nextEvent(mask, i, end, Event.OpenBracket);
    if (open === end) break;
    ref = open;
    i = open + 1;
  }
  return ref;
}

/** @hot */
function blockCodeEnd(mask: InlineMask, start: number, end: number): number {
  const open = ticksEnd(mask, start, end);
  const close = nextEvent(mask, open, end, Event.Tick);
  if (close === end) return -1;
  const limit = ticksEnd(mask, close, end);
  return limit - close === open - start ? limit : -1;
}

/** @hot */
function blockLinkEnd(mask: InlineMask, start: number, end: number): number {
  let pos = start + 1;
  while (pos < end) {
    pos = nextEvent(mask, pos, end, Event.OpenBracket | Event.CloseBracket | Event.Tick);
    if (pos === end) return -1;
    const code = inlineMaskCode(mask, pos);
    if (code === 93) break;
    if (code === 91) return -1;
    pos = blockCodeEnd(mask, pos, end);
    if (pos < 0) return -1;
  }
  if (pos + 1 >= end || inlineMaskCode(mask, pos + 1) !== 40) return -1;
  let depth = 0;
  pos += 2;
  while (pos < end) {
    pos = nextEvent(mask, pos, end, Event.OpenParen | Event.CloseParen | Event.Backslash);
    if (pos === end) break;
    const code = inlineMaskCode(mask, pos++);
    if (code === 41) {
      if (depth === 0) return pos;
      depth = 0;
    } else if (code === 40) {
      if (depth) break;
      depth = 1;
    } else {
      pos++;
    }
  }
  return -1;
}

/** @hot */
function blockAngleEnd(mask: InlineMask, start: number, end: number): number {
  if (inlineMaskCode(mask, start + 1) === 32) return -1;
  const pos = nextEvent(mask, start + 1, end, Event.OpenAngle | Event.CloseAngle);
  return pos < end && inlineMaskCode(mask, pos) === 62 ? pos + 1 : -1;
}

/** @hot */
function hasTextLink(mask: InlineMask, source: string, start: number, end: number, rules: Rules, links: Links): boolean {
  for (let pos = start; pos < end;) {
    const i = nextEvent(mask, pos, end, Event.OpenBracket | Event.Tick | Event.OpenAngle);
    if (i === end) break;
    const searchStart = pos;
    pos = i + 1;
    const code = inlineMaskCode(mask, i);
    let after = -1;
    if (code === 91) {
      after = blockLinkEnd(mask, i, end);
      if (after >= 0 && (i === start || inlineMaskCode(mask, i - 1) !== 33) && rules.inline.link.test(sourceText(source, i, after))) return true;
    } else if (code === 96 && (i === start || ((supportsLookbehind || i > searchStart) && inlineMaskCode(mask, i - 1) !== 96))) {
      after = blockCodeEnd(mask, i, end);
    } else if (code === 60) {
      after = blockAngleEnd(mask, i, end);
    }
    if (after >= 0) pos = after;
  }
  for (let pos = start; pos < end;) {
    const i = nextEvent(mask, pos, end, Event.OpenBracket | Event.Bang);
    if (i === end) break;
    pos = i + 1;
    const after = referenceEnd(mask, i, end);
    if (after < 0) continue;
    const ref = referenceStart(mask, i, after);
    if (inlineMaskCode(mask, i) !== 33 && Object.hasOwn(links, normalizeLabel(source, ref + 1, after - 1))
      && (ref <= i + 1 || !hasTextLink(mask, source, i + 1, ref - 1, rules, links))) return true;
    pos = after;
  }
  return false;
}

/** @hot */
export function maskReferences(mask: InlineMask, source: string, start: number, end: number, rules: Rules, links: Links): void {
  for (let pos = start; pos < end;) {
    const i = nextEvent(mask, pos, end, Event.OpenBracket | Event.Bang);
    if (i === end) break;
    pos = i + 1;
    const after = referenceEnd(mask, i, end);
    if (after < 0) continue;
    mask.spans.push(i, after);
    const ref = referenceStart(mask, i, after);
    if (Object.hasOwn(links, normalizeLabel(source, ref + 1, after - 1))) {
      if (ref > i + 1 && inlineMaskCode(mask, i) !== 33 && hasTextLink(mask, source, i + 1, ref - 1, rules, links)) {
        maskReferences(mask, source, i + 1, ref - 1, rules, links);
        writeMask(mask, ref - 1, ref, MaskCode.CloseBracket);
        writeMask(mask, ref, after, MaskCode.Brackets);
      } else {
        writeMask(mask, i, after, MaskCode.Brackets);
      }
    }
    pos = after;
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
export function delimiterOpener(mask: InlineMask, source: string, offset: number, limit: number, delimiter: number, gfm: boolean, pedantic: boolean): number {
  const end = mask.openerEnds[offset];
  const length = end - offset;
  if (end >= limit || (delimiter === 126 && (!gfm || length > 2))) return 0;
  const next = source.charCodeAt(end);
  if (isStringWhitespace(next)) return 0;
  if ((next === 126 && gfm && delimiter !== 126)
    || !isInlinePunctuation(next, source, end)
    || (pedantic && isOpenQuote(next, source, end))) return length;
  return -length;
}

/** @hot */
export function maskEscapes(mask: InlineMask, source: string, start: number, end: number): void {
  for (let pos = start; pos < end;) {
    const i = nextEvent(mask, pos, end, Event.Tick | Event.Backslash);
    if (i === end) break;
    pos = i + 1;
    if (inlineMaskCode(mask, i) === 92) {
      if (pos < end && isInlinePunctuation(inlineMaskCode(mask, pos), source, pos)) {
        const width = pos + 1 < end && source.codePointAt(pos)! > 0xffff ? 3 : 2;
        pos = i + width;
        writeMask(mask, i, pos, MaskCode.Plus);
        mask.spans.push(i, pos);
      }
    } else {
      const open = ticksEnd(mask, i, end);
      const width = open - i;
      pos = open;
      for (let close = nextEvent(mask, open, end, Event.Tick); close < end;) {
        const next = ticksEnd(mask, close, end);
        if (next - close === width) {
          mask.spans.push(i, next);
          for (let inner = nextEvent(mask, open, close, Event.Tick); inner < close;) {
            const after = ticksEnd(mask, inner, close);
            writeMask(mask, inner, after, MaskCode.Plus);
            inner = nextEvent(mask, after, close, Event.Tick);
          }
          pos = next;
          break;
        }
        close = nextEvent(mask, next, end, Event.Tick);
      }
    }
  }
}

/** @hotIgnore Output: one string of at most end minus start UTF-16 units for an HTML range or user mask. */
export function inlineMaskText(mask: InlineMask, start: number, end: number): string {
  const codes = mask.codes;
  let text = '';
  if (mask.window) {
    for (let i = start; i < end; i++) text += String.fromCharCode(inlineMaskCode(mask, i));
    return text;
  }
  for (let i = start; i < end; i += 4096) {
    text += String.fromCharCode(...codes.subarray(i, Math.min(i + 4096, end)));
  }
  return text;
}

/** @hot */
function htmlMaskEnd(mask: InlineMask, source: string, start: number, end: number, rules: Rules, lastEdit: number): number {
  const { tag, autolink } = rules.inline;
  const cursor = rules.cursor?.inline;
  if (start >= lastEdit) {
    const match = execAt(tag, source, start, cursor?.tag) || execAt(autolink, source, start, cursor?.autolink);
    if (!match) return -1;
    if (start + match[0].length <= end) return start + match[0].length;
  }
  while (inlineMaskCode(mask, end - 1) !== 62) end--;
  const text = inlineMaskText(mask, start, end);
  const match = tag.exec(text) || autolink.exec(text);
  return match ? start + match[0].length : -1;
}

/** @hot */
export function maskBlocks(mask: InlineMask, source: string, left: number, end: number, rules: Rules): void {
  const lastEdit = mask.lastEdit;
  for (let pos = left; pos < end;) {
    const i = nextEvent(mask, pos, end, Event.OpenBracket | Event.Tick | Event.OpenAngle);
    if (i === end) break;
    const searchStart = pos;
    pos = i + 1;
    const code = inlineMaskCode(mask, i);
    let after = -1;
    if (code === 91) after = blockLinkEnd(mask, i, end);
    else if (code === 96 && (i === left || ((supportsLookbehind || i > searchStart) && inlineMaskCode(mask, i - 1) !== 96))) after = blockCodeEnd(mask, i, end);
    else if (code === 60 && blockAngleEnd(mask, i, end) >= 0) after = htmlMaskEnd(mask, source, i, end, rules, lastEdit);
    if (after < 0) continue;
    mask.spans.push(i, after);
    writeMask(mask, i, after, MaskCode.Brackets);
    pos = after;
  }
}

// A stage can consume a span without changing its codes. A child boundary
// inside that span can expose candidates that the parent had to skip.
/** @hot */
export function crossesMaskBoundary(mask: InlineMask, start: number, end: number): boolean {
  const spans = mask.spans;
  for (let i = 0; i < spans.length; i += 2) {
    const from = spans[i];
    const to = spans[i + 1];
    if ((from < start && to > start) || (from < end && to > end)) return true;
  }
  return false;
}

const unicodeDelimiterPunctuation = /[\p{P}\p{S}]/uy;

/** @hot */
function delimiterClass(src: string, offset: number, tildeIsWord: boolean): number {
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
  mask: InlineMask;
}

/** @hot */
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

/** @hot */
function addInlineRun(runs: InlineRuns, start: number, end: number, code: number): void {
  const index = runs.length;
  if (index + 5 > runs.entries.length) {
    const expanded = new Int32Array(Math.max(48, runs.entries.length * 2));
    expanded.set(runs.entries);
    runs.entries = expanded;
  }
  const entries = runs.entries;
  entries[index] = start;
  entries[index + 1] = end;
  entries[index + 2] = code;
  runs.length += 5;
}

/** @hot */
export function effectiveInlineStart(runs: InlineRuns, index: number, limit: number): number {
  const entries = runs.entries;
  const start = entries[index];
  const code = entries[index + 2];
  if (inlineMaskCode(runs.mask, start) === code) return start;
  return start + 1 < Math.min(limit, entries[index + 1]) && inlineMaskCode(runs.mask, start + 1) === code ? start + 1 : -1;
}

/** @hot */
export function maskDelimiterClass(runs: InlineRuns, source: string, pos: number, tildeIsWord: boolean): number {
  if (pos < 0 || pos >= source.length) return 0;
  const code = inlineMaskCode(runs.mask, pos);
  if (code === source.charCodeAt(pos)) return delimiterClass(source, pos, tildeIsWord);
  return code === 97 ? 2 : 1;
}

/** @hot */
export function inlineWindowHints(runs: InlineRuns, start: number, end: number, hints: CloserHints): void {
  let star = -1;
  let underscore = -1;
  let tilde = -1;
  const entries = runs.entries;
  for (let i = inlineRunAt(runs, end) - 5; i >= 0 && entries[i + 1] > start; i -= 5) {
    const pos = effectiveInlineStart(runs, i, end);
    if (pos <= start) continue;
    const prev = inlineMaskCode(runs.mask, pos - 1);
    if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12) continue;
    const code = entries[i + 2];
    if (code === 42 && star < 0) star = pos;
    else if (code === 95 && underscore < 0) underscore = pos;
    else if (code === 126 && tilde < 0) tilde = pos;
    if (star >= 0 && underscore >= 0 && tilde >= 0) break;
  }
  hints.star = star;
  hints.underscore = underscore;
  hints.tilde = tilde;
}

/** @hot */
export function delimiterBefore(mask: InlineMask, pos: number): number {
  const last = inlineMaskCode(mask, pos - 1);
  if (last >= 0xdc00 && last <= 0xdfff) {
    const high = inlineMaskCode(mask, pos - 2);
    if (high >= 0xd800 && high <= 0xdbff) return pos - 2;
  }
  return pos - 1;
}

/** @hot */
export function classifyInlineRuns(runs: InlineRuns, source: string): void {
  const entries = runs.entries;
  for (let i = 0; i < runs.length; i += 5) {
    const start = effectiveInlineStart(runs, i, source.length);
    if (start < 0) continue;
    const tildeIsWord = entries[i + 2] === 42 && runs.gfm;
    const before = delimiterBefore(runs.mask, start);
    entries[i + 3] = (maskDelimiterClass(runs, source, before, tildeIsWord) << 1) | (start - before - 1);
    entries[i + 4] = maskDelimiterClass(runs, source, entries[i + 1], tildeIsWord);
  }
}

export interface CloserHints {
  star: number;
  underscore: number;
  tilde: number;
}

/** @hot */
export function projectInlineRuns(runs: InlineRuns, root: InlineRuns, start: number, end: number, removed: number[]): void {
  runs.length = 0;
  runs.gfm = root.gfm;
  let removedBefore = 0;
  for (let i = inlineRunAt(root, start); i < root.length && root.entries[i] < end; i += 5) {
    const from = root.entries[i] - start;
    const to = Math.min(root.entries[i + 1], end) - start;
    while (removedBefore < removed.length && removed[removedBefore] < from) removedBefore++;
    const first = from - removedBefore;
    const last = to - removedBefore;
    runs.mask.openerEnds.fill(last, first, last);
    addInlineRun(runs, first, last, root.entries[i + 2]);
  }
}
