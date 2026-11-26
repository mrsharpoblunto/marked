import { tokenKind, TokenKind } from './tokenKind.ts';
import { _Renderer, imageTextTokens, rendererSlots } from './Renderer.ts';
import { _TextRenderer, TextMode, textRendererSlots } from './TextRenderer.ts';
import { _defaults } from './defaults.ts';
import { emit } from './OutputBuffer.ts';
import type { OutputBuffer } from './OutputBuffer.ts';
import type { Token, Tokens } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/**
 * Parsing & Compiling
 */
export class _Parser<ParserOutput = string, RendererOutput = string> {
  options: MarkedOptions<ParserOutput, RendererOutput>;
  renderer: _Renderer<ParserOutput, RendererOutput>;
  textRenderer: _TextRenderer<RendererOutput>;
  #slots: _Renderer<ParserOutput, RendererOutput>;
  #useKinds = false;
  #knownOutput: OutputBuffer | undefined;
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

  /** @internal */
  parseKnown(tokens: Token[], block: boolean): ParserOutput {
    const output = this.#knownOutput ??= { html: '' };
    this.#useKinds = true;
    this.#textSlots = undefined;
    try {
      if (block) this.renderBlocks(tokens, output);
      else this.renderInlines(tokens, output);
      return output.html as ParserOutput;
    } finally {
      output.html = '';
    }
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

      const token = anyToken;

      switch ((this.#useKinds ? token.kind : undefined) ?? tokenKind(token)) {
        case TokenKind.Space: {
          renderer.spaceAt(token as Tokens.Space, output);
          break;
        }
        case TokenKind.Hr: {
          renderer.hrAt(token as Tokens.Hr, output);
          break;
        }
        case TokenKind.Heading: {
          renderer.headingAt(token as Tokens.Heading, output);
          break;
        }
        case TokenKind.Code: {
          renderer.codeAt(token as Tokens.Code, output);
          break;
        }
        case TokenKind.Table: {
          renderer.tableAt(token as Tokens.Table, output);
          break;
        }
        case TokenKind.Blockquote: {
          renderer.blockquoteAt(token as Tokens.Blockquote, output);
          break;
        }
        case TokenKind.List: {
          renderer.listAt(token as Tokens.List, output);
          break;
        }
        case TokenKind.Checkbox: {
          renderer.checkboxAt(token as Tokens.Checkbox, output);
          break;
        }
        case TokenKind.Html: {
          renderer.htmlAt(token as Tokens.HTML | Tokens.Tag, output);
          break;
        }
        case TokenKind.Def: {
          renderer.defAt(token as Tokens.Def, output);
          break;
        }
        case TokenKind.Paragraph: {
          renderer.paragraphAt(token as Tokens.Paragraph, output);
          break;
        }
        case TokenKind.Text: {
          renderer.textAt(token as Tokens.Text, output);
          break;
        }

        default: {
          if (extended === 1) break;
          reportMissingToken(token.type, !!this.options.silent);
          output.html = previous;
          return;
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
  /** @hot */
  renderText(tokens: Token[], output: OutputBuffer): void {
    const renderer = this.#textSlots ??= this.#useKinds ? this.textRenderer : textRendererSlots(this.textRenderer);
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

      const token = anyToken;

      switch ((this.#useKinds ? token.kind : undefined) ?? tokenKind(token)) {
        case TokenKind.Escape: {
          renderer.escapeAt(token as Tokens.Escape, output);
          break;
        }
        case TokenKind.Html: {
          renderer.htmlAt(token as Tokens.HTML | Tokens.Tag, output);
          break;
        }
        case TokenKind.Link: {
          renderer.linkAt(token as Tokens.Link, output);
          break;
        }
        case TokenKind.Image: {
          renderer.imageAt(token as Tokens.Image, output);
          break;
        }
        case TokenKind.Checkbox: {
          renderer.checkboxAt(token as Tokens.Checkbox, output);
          break;
        }
        case TokenKind.Strong: {
          renderer.strongAt(token as Tokens.Strong, output);
          break;
        }
        case TokenKind.Em: {
          renderer.emAt(token as Tokens.Em, output);
          break;
        }
        case TokenKind.Codespan: {
          renderer.codespanAt(token as Tokens.Codespan, output);
          break;
        }
        case TokenKind.Br: {
          renderer.brAt(token as Tokens.Br, output);
          break;
        }
        case TokenKind.Del: {
          renderer.delAt(token as Tokens.Del, output);
          break;
        }
        case TokenKind.Text: {
          renderer.textAt(token as Tokens.Text, output);
          break;
        }
        default: {
          if (extended === 1) break;
          reportMissingToken(token.type, !!this.options.silent);
          output.html = previous;
          return;
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

/** @hotIgnore Output: one message and at most one Error per unknown token. */
function reportMissingToken(type: string, silent: boolean): void {
  const message = 'Token with "' + type + '" type was not found.';
  if (silent) {
    console.error(message);
  } else {
    throw new Error(message);
  }
}
