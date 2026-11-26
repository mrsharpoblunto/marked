import type { Tokens } from './Tokens.ts';
import type { _Parser } from './Parser.ts';
import { emit } from './OutputBuffer.ts';
import type { OutputBuffer } from './OutputBuffer.ts';

/**
 * TextRenderer
 * returns only the textual part of the token
 */
export class _TextRenderer<RendererOutput = string> {
  parser!: _Parser<unknown, RendererOutput>;
  // no need for block level renderers
  strong({ text, tokens }: Tokens.Strong): RendererOutput;
  strong(token: Tokens.Strong): RendererOutput {
    const output = { html: '' };
    this.strongAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
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
  codespanAt(token: Tokens.Codespan, output: OutputBuffer): void {
    emit(output, token.text);
  }

  del({ text, tokens }: Tokens.Del): RendererOutput;
  del(token: Tokens.Del): RendererOutput {
    const output = { html: '' };
    this.delAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
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
  textAt(token: Tokens.Text | Tokens.Escape | Tokens.Tag, output: OutputBuffer): void {
    emit(output, token.text);
  }

  link({ text, tokens }: Tokens.Link): RendererOutput;
  link(token: Tokens.Link): RendererOutput {
    const output = { html: '' };
    this.linkAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  linkAt(token: Tokens.Link, output: OutputBuffer): void {
    if (token.tokens) {
      this.parser.renderInlines(token.tokens, output, this);
    } else {
      emit(output, token.text);
    }
  }

  image({ text, tokens }: Tokens.Image): RendererOutput;
  image(token: Tokens.Image): RendererOutput {
    const output = { html: '' };
    this.imageAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
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
