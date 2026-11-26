import { _Renderer, imageTextTokens, rendererSlots } from './Renderer.ts';
import { _TextRenderer, TextMode, textRendererSlots } from './TextRenderer.ts';
import { _defaults } from './defaults.ts';
import { emit } from './OutputBuffer.ts';
import type { OutputBuffer } from './OutputBuffer.ts';
import type { MarkedToken, Token } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/**
 * Parsing & Compiling
 */
export class _Parser<ParserOutput = string, RendererOutput = string> {
  options: MarkedOptions<ParserOutput, RendererOutput>;
  renderer: _Renderer<ParserOutput, RendererOutput>;
  textRenderer: _TextRenderer<RendererOutput>;
  #slots: _Renderer<ParserOutput, RendererOutput>;
  #textSlots: _TextRenderer<RendererOutput> | undefined;

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    this.options = options || _defaults;
    const suppliedRenderer = this.options.renderer;
    this.renderer = suppliedRenderer || new _Renderer<ParserOutput, RendererOutput>();
    this.options.renderer = this.renderer;
    this.#slots = suppliedRenderer ? rendererSlots(suppliedRenderer) : this.renderer;
    this.renderer.options = this.options;
    this.renderer.parser = this;
    this.textRenderer = new _TextRenderer<RendererOutput>();
    this.textRenderer.parser = this;
  }

  /**
   * Static Parse Method
   */
  /** @hot */
  static parse<ParserOutput = string, RendererOutput = string>(tokens: Token[], options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const parser = new _Parser<ParserOutput, RendererOutput>(options);
    return parser.parse(tokens);
  }

  /**
   * Static Parse Inline Method
   */
  /** @hot */
  static parseInline<ParserOutput = string, RendererOutput = string>(tokens: Token[], options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const parser = new _Parser<ParserOutput, RendererOutput>(options);
    return parser.parseInline(tokens);
  }

  /**
   * Parse Loop
   */
  /** @hot */
  parse(tokens: Token[]): ParserOutput {
    const output = { html: '' };
    this.#textSlots = undefined;
    this.renderBlocks(tokens, output);
    return output.html as ParserOutput;
  }

  /** @internal */
  /** @hot */
  renderBlocks(tokens: Token[], output: OutputBuffer): void {
    this.renderer.parser = this;
    const previous = output.html;
    const renderer = this.#slots;
    const extensions = this.options.extensions?.renderers;

    for (let i = 0; i < tokens.length; i++) {
      const anyToken = tokens[i];

      const extended = extensions ? renderExtension(extensions, this, anyToken, output) : 0;
      if (extended === 2) continue;

      const token = anyToken as MarkedToken;

      switch (token.type) {
        case 'space': {
          renderer.spaceAt(token, output);
          break;
        }
        case 'hr': {
          renderer.hrAt(token, output);
          break;
        }
        case 'heading': {
          renderer.headingAt(token, output);
          break;
        }
        case 'code': {
          renderer.codeAt(token, output);
          break;
        }
        case 'table': {
          renderer.tableAt(token, output);
          break;
        }
        case 'blockquote': {
          renderer.blockquoteAt(token, output);
          break;
        }
        case 'list': {
          renderer.listAt(token, output);
          break;
        }
        case 'checkbox': {
          renderer.checkboxAt(token, output);
          break;
        }
        case 'html': {
          renderer.htmlAt(token, output);
          break;
        }
        case 'def': {
          renderer.defAt(token, output);
          break;
        }
        case 'paragraph': {
          renderer.paragraphAt(token, output);
          break;
        }
        case 'text': {
          renderer.textAt(token, output);
          break;
        }

        default: {
          if (extended === 1) break;
          const errMsg = 'Token with "' + token.type + '" type was not found.';
          if (this.options.silent) {
            console.error(errMsg);
            output.html = previous;
            return;
          } else {
            throw new Error(errMsg);
          }
        }
      }
    }
  }

  /**
   * Parse Inline Tokens
   */
  /** @hot */
  parseInline(tokens: Token[], renderer: _Renderer<ParserOutput, RendererOutput> | _TextRenderer<RendererOutput> = this.renderer): ParserOutput {
    const output = { html: '' };
    const slots = renderer === this.renderer
      ? this.#slots
      : renderer instanceof _TextRenderer ? textRendererSlots(renderer) : rendererSlots(renderer);
    const previousTextSlots = this.#textSlots;
    this.#textSlots = undefined;
    try {
      this.renderInlines(tokens, output, slots);
      return output.html as ParserOutput;
    } finally {
      this.#textSlots = previousTextSlots;
    }
  }

  /** @internal */
  renderText(tokens: Token[], output: OutputBuffer): void {
    const renderer = this.#textSlots ??= textRendererSlots(this.textRenderer);
    if (renderer !== this.textRenderer || this.options.extensions?.renderers) {
      this.renderInlines(imageTextTokens(tokens), output, renderer);
      return;
    }
    const previous = renderer.imageMode;
    renderer.imageMode = TextMode.Image;
    try {
      this.renderInlines(tokens, output, renderer);
    } finally {
      renderer.imageMode = previous;
    }
  }

  /** @internal */
  /** @hot */
  renderInlines(tokens: Token[], output: OutputBuffer, renderer: _Renderer<ParserOutput, RendererOutput> | _TextRenderer<RendererOutput> = this.#slots): void {
    this.renderer.parser = this;
    const previous = output.html;
    const extensions = this.options.extensions?.renderers;

    for (let i = 0; i < tokens.length; i++) {
      const anyToken = tokens[i];

      const extended = extensions ? renderExtension(extensions, this, anyToken, output) : 0;
      if (extended === 2) continue;

      const token = anyToken as MarkedToken;

      switch (token.type) {
        case 'escape': {
          renderer.escapeAt(token, output);
          break;
        }
        case 'html': {
          renderer.htmlAt(token, output);
          break;
        }
        case 'link': {
          renderer.linkAt(token, output);
          break;
        }
        case 'image': {
          renderer.imageAt(token, output);
          break;
        }
        case 'checkbox': {
          renderer.checkboxAt(token, output);
          break;
        }
        case 'strong': {
          renderer.strongAt(token, output);
          break;
        }
        case 'em': {
          renderer.emAt(token, output);
          break;
        }
        case 'codespan': {
          renderer.codespanAt(token, output);
          break;
        }
        case 'br': {
          renderer.brAt(token, output);
          break;
        }
        case 'del': {
          renderer.delAt(token, output);
          break;
        }
        case 'text': {
          renderer.textAt(token, output);
          break;
        }
        default: {
          if (extended === 1) break;
          const errMsg = 'Token with "' + token.type + '" type was not found.';
          if (this.options.silent) {
            console.error(errMsg);
            output.html = previous;
            return;
          } else {
            throw new Error(errMsg);
          }
        }
      }
    }
  }
}

/** @hotIgnore User adapter: at most one parser context per renderer extension call. */
function renderExtension<P, R>(
  extensions: NonNullable<NonNullable<MarkedOptions<P, R>['extensions']>['renderers']>,
  parser: _Parser<P, R>, token: Token, output: OutputBuffer,
): number {
  if (!Object.hasOwn(extensions, token.type)) return 0;
  const render = extensions[token.type];
  if (!render) return 0;
  const text = render.call({ parser }, token);
  if (text === false) return 1;
  emit(output, text ?? '');
  return 2;
}
