export interface OutputBuffer {
  html: string;
}

/** @hotIgnore Output: at most one string append per emitted fragment. */
export function emit(output: OutputBuffer, fragment: unknown): void {
  output.html += fragment as string;
}
