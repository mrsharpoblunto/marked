/** @hot */
export function blockLineEnd(src: string, start: number): number {
  let end = start;
  while (end < src.length && src.charCodeAt(end) !== 10) end++;
  return end;
}

/** @hot */
export function blockContentStart(src: string, start: number): number {
  let code = src.charCodeAt(start);
  while (code === 32 || code === 9) code = src.charCodeAt(++start);
  return start;
}

/** @hot */
export function blockIndent(src: string, start: number, content: number): number {
  let width = 0;
  for (let i = start; i < content; i++) {
    width += src.charCodeAt(i) === 9 ? 4 - (width & 3) : 1;
  }
  return width;
}

/** @hot */
export function blockIndentEnd(src: string, start: number): number {
  let end = start;
  while (end - start < 4 && src.charCodeAt(end) === 32) end++;
  if (end - start < 4 && src.charCodeAt(end) === 9) return end + 1;
  return end - start === 4 ? end : start;
}

/** @hot */
export function thematicBreakEnd(src: string, markerAt: number): number {
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
