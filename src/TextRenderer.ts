import type { Tokens } from './Tokens.ts';
import type { _Parser } from './Parser.ts';
import { emit } from './OutputBuffer.ts';
import { escapeHtmlEntities } from './helpers.ts';
import type { OutputBuffer } from './OutputBuffer.ts';

export const enum TextMode {
  Plain,
  Image,
  Literal,
}

/**
 * TextRenderer
 * returns only the textual part of the token
 */
export class _TextRenderer<RendererOutput = string> {
  parser!: _Parser<unknown, RendererOutput>;
  /** @internal */
  imageMode = TextMode.Plain;
  strong({ text, tokens }: Tokens.Strong): RendererOutput;
  strong(token: Tokens.Strong): RendererOutput {
    const output = { html: '' };
    this.strongAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  strongAt(token: Tokens.Strong, output: OutputBuffer): void {
    if (token.tokens) {
      this.parser.renderInlines(token.tokens, output, this);
    } else {
      emit(output, token.text);
    }
  }

  em({ text, tokens }: Tokens.Em): RendererOutput;
  em(token: Tokens.Em): RendererOutput {
    const output = { html: '' };
    this.emAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  emAt(token: Tokens.Em, output: OutputBuffer): void {
    if (token.tokens) {
      this.parser.renderInlines(token.tokens, output, this);
    } else {
      emit(output, token.text);
    }
  }

  codespan({ text }: Tokens.Codespan): RendererOutput;
  codespan(token: Tokens.Codespan): RendererOutput {
    const output = { html: '' };
    this.codespanAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  codespanAt(token: Tokens.Codespan, output: OutputBuffer): void {
    emit(output, this.imageMode ? escapeHtmlEntities(token.text, true) : token.text);
  }

  del({ text, tokens }: Tokens.Del): RendererOutput;
  del(token: Tokens.Del): RendererOutput {
    const output = { html: '' };
    this.delAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  delAt(token: Tokens.Del, output: OutputBuffer): void {
    if (token.tokens) {
      this.parser.renderInlines(token.tokens, output, this);
    } else {
      emit(output, token.text);
    }
  }

  html({ text }: Tokens.HTML | Tokens.Tag): RendererOutput;
  html(token: Tokens.HTML | Tokens.Tag): RendererOutput {
    const output = { html: '' };
    this.htmlAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  htmlAt(token: Tokens.HTML | Tokens.Tag, output: OutputBuffer): void {
    emit(output, token.text);
  }

  text({ text }: Tokens.Text | Tokens.Escape | Tokens.Tag): RendererOutput;
  text(token: Tokens.Text | Tokens.Escape | Tokens.Tag): RendererOutput {
    const output = { html: '' };
    this.textAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  textAt(token: Tokens.Text | Tokens.Escape | Tokens.Tag, output: OutputBuffer): void {
    emit(output, this.imageMode === TextMode.Literal ? escapeHtmlEntities(token.text, true) : token.text);
  }

  /** @internal */
  /** @hot */
  escapeAt(token: Tokens.Escape, output: OutputBuffer): void {
    if (this.imageMode) {
      emit(output, escapeHtmlEntities(token.text, true));
    } else {
      this.textAt(token, output);
    }
  }

  link({ text, tokens }: Tokens.Link): RendererOutput;
  link(token: Tokens.Link): RendererOutput {
    const output = { html: '' };
    this.linkAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  linkAt(token: Tokens.Link, output: OutputBuffer): void {
    const mode = this.imageMode;
    const literal = mode !== TextMode.Plain && token.autolink;
    if (token.tokens) {
      if (literal) this.imageMode = TextMode.Literal;
      try {
        this.parser.renderInlines(token.tokens, output, this);
      } finally {
        this.imageMode = mode;
      }
    } else {
      emit(output, literal ? escapeHtmlEntities(token.text, true) : token.text);
    }
  }

  image({ text, tokens }: Tokens.Image): RendererOutput;
  image(token: Tokens.Image): RendererOutput {
    const output = { html: '' };
    this.imageAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  imageAt(token: Tokens.Image, output: OutputBuffer): void {
    if (token.tokens) {
      this.parser.renderInlines(token.tokens, output, this);
    } else {
      emit(output, token.text);
    }
  }

  br(): RendererOutput {
    const output = { html: '' };
    this.brAt(undefined, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  brAt(_token: Tokens.Br | undefined, output: OutputBuffer): void {
    emit(output, '\n');
  }

  checkbox({ raw }: Tokens.Checkbox): RendererOutput;
  checkbox(token: Tokens.Checkbox): RendererOutput {
    const output = { html: '' };
    this.checkboxAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  checkboxAt(token: Tokens.Checkbox, output: OutputBuffer): void {
    emit(output, token.raw);
  }
}

const textMethods = ['strong', 'em', 'codespan', 'del', 'html', 'text', 'link', 'image', 'br', 'checkbox'] as const;

// The checker cannot follow slots that call user renderers.
export function textRendererSlots<R>(renderer: _TextRenderer<R>): _TextRenderer<R> {
  let slots = renderer;
  for (const name of textMethods) {
    const method = renderer[name];
    if (method === _TextRenderer.prototype[name]) continue;
    if (slots === renderer) slots = Object.create(renderer);
    const render = method as (...args: unknown[]) => R;
    Object.defineProperty(slots, name + 'At', {
      value(token: Tokens.Generic, output: OutputBuffer) {
        emit(output, render.call(renderer, token));
      },
    });
  }
  return slots;
}
