/** @hot */
export function blockLineEnd(src: BlockSource, start: number): number {
  if (typeof src !== 'string') {
    const end = src.indexOf('\n', start);
    return end < 0 ? src.length : end;
  }
  let end = start;
  while (end < src.length && src.charCodeAt(end) !== 10) end++;
  return end;
}

/** @hot */
export function blockContentStart(src: BlockSource, start: number): number {
  let code = src.charCodeAt(start);
  while (code === 32 || code === 9) code = src.charCodeAt(++start);
  return start;
}

/** @hot */
export function blockIndent(src: BlockSource, start: number, content: number): number {
  let width = 0;
  for (let i = start; i < content; i++) {
    width += src.charCodeAt(i) === 9 ? 4 - (width & 3) : 1;
  }
  return width;
}

/** @hot */
export function blockIndentEnd(src: BlockSource, start: number): number {
  let end = start;
  while (end - start < 4 && src.charCodeAt(end) === 32) end++;
  if (end - start < 4 && src.charCodeAt(end) === 9) return end + 1;
  return end - start === 4 ? end : start;
}

/** @hot */
export function thematicBreakEnd(src: BlockSource, markerAt: number): number {
  const marker = src.charCodeAt(markerAt);
  let count = 0;
  let end = markerAt;
  while (end < src.length) {
    const code = src.charCodeAt(end);
    if (code === marker) count++;
    else if (code !== 32 && code !== 9) break;
    end++;
  }
  return count >= 3 && (end === src.length || src.charCodeAt(end) === 10) ? end : -1;
}

export type BlockSource = string | BlockLineView;

/**
 * Each row gives its virtual start, original content range, and virtual
 * indentation. Line feeds between rows have no entry in the source range.
 */
export class BlockLineView {
  length = 0;
  #rows: number[] = [];
  #row = 0;
  #start = 0;
  #end = -1;
  #content = 0;
  #physical = 0;
  #original: string;

  constructor(private readonly source: BlockSource) {
    this.#original = typeof source === 'string' ? source : source.#original;
  }

  append(start: number, end: number, padding: number) {
    const offset = this.length + (this.#rows.length ? 1 : 0);
    this.length = offset + padding + end - start;
    const parent = this.source;
    if (typeof parent !== 'string' && end > start) {
      parent.#find(start);
      const content = parent.#content;
      const padded = Math.max(0, Math.min(end, content) - start);
      const first = Math.max(0, start - content);
      end = parent.#physical + first + (end - start - padded);
      start = parent.#physical + first;
      padding += padded;
    }
    this.#rows.push(offset, start, end, padding);
  }

  /** @hot */
  #find(offset: number): number {
    const rows = this.#rows;
    let row = this.#row;
    while (row > 0 && rows[row] > offset) row -= 4;
    while (row + 4 < rows.length && rows[row + 4] <= offset) row += 4;
    this.#row = row;
    this.#start = rows[row];
    this.#physical = rows[row + 1];
    this.#content = this.#start + rows[row + 3];
    this.#end = this.#content + rows[row + 2] - this.#physical;
    return row;
  }

  /** @hot */
  charCodeAt(offset: number): number {
    if (offset < 0 || offset >= this.length) return NaN;
    if (offset < this.#start || offset > this.#end) this.#find(offset);
    if (offset < this.#content) return 32;
    if (offset === this.#end) return 10;
    return this.#original.charCodeAt(this.#physical + offset - this.#content);
  }

  /** @hot */
  indexOf(char: string, start = 0): number {
    const code = char.charCodeAt(0);
    if (code === 10 && start < this.length) {
      const next = this.#rows[this.#find(start) + 4] - 1;
      return next < this.length ? next : -1;
    }
    for (let i = Math.max(0, start); i < this.length; i++) {
      if (this.charCodeAt(i) === code) return i;
    }
    return -1;
  }

  /** @hot */
  lastIndexOf(char: string, start: number): number {
    const code = char.charCodeAt(0);
    for (let i = Math.min(start, this.length - 1); i >= 0; i--) {
      if (this.charCodeAt(i) === code) return i;
    }
    return -1;
  }

  /** @hot */
  slice(start = 0, end = this.length): string {
    let pos = start < 0 ? Math.max(0, this.length + start) : start;
    const limit = end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length);
    let text = '';
    const rows = this.#rows;
    while (pos < limit) {
      const row = this.#find(pos);
      const content = rows[row] + rows[row + 3];
      if (pos < content) {
        const next = Math.min(content, limit);
        text += ' '.repeat(next - pos);
        pos = next;
      }
      const from = rows[row + 1] + pos - content;
      const through = Math.min(rows[row + 2], from + limit - pos);
      if (from < through) {
        text += this.#original.slice(from, through);
        pos += through - from;
      }
      if (pos < limit) {
        text += '\n';
        pos++;
      }
    }
    return text;
  }
}
