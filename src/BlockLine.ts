/** @hot */
export function blockLineEnd(src: BlockSource, start: number): number {
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

  constructor(private readonly source: BlockSource) {}

  append(start: number, end: number, padding: number) {
    const offset = this.length + (this.#rows.length ? 1 : 0);
    this.#rows.push(offset, start, end, padding);
    this.length = offset + padding + end - start;
  }

  /** @hot */
  #find(offset: number): number {
    const rows = this.#rows;
    let row = this.#row;
    while (row > 0 && rows[row] > offset) row -= 4;
    while (row + 4 < rows.length && rows[row + 4] <= offset) row += 4;
    this.#row = row;
    return row;
  }

  /** @hot */
  charCodeAt(offset: number): number {
    if (offset < 0 || offset >= this.length) return NaN;
    const row = this.#find(offset);
    const rows = this.#rows;
    const content = offset - rows[row] - rows[row + 3];
    if (content < 0) return 32;
    const physical = rows[row + 1] + content;
    return physical < rows[row + 2] ? this.source.charCodeAt(physical) : 10;
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
        text += this.source.slice(from, through);
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
