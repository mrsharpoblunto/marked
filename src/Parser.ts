import { _Renderer } from './Renderer.ts';
import { _TextRenderer } from './TextRenderer.ts';
import { _defaults } from './defaults.ts';
import type { MarkedToken, Token, Tokens } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/**
 * Parsing & Compiling
 */
export class _Parser<ParserOutput = string, RendererOutput = string> {
  options: MarkedOptions<ParserOutput, RendererOutput>;
  renderer: _Renderer<ParserOutput, RendererOutput>;
  textRenderer: _TextRenderer<RendererOutput>;
  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    this.options = options || _defaults;
    this.options.renderer = this.options.renderer || new _Renderer<ParserOutput, RendererOutput>();
    this.renderer = this.options.renderer;
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
    // hot-path: allow Each public call needs its own instance for options and recursive calls.
    const parser = new _Parser<ParserOutput, RendererOutput>(options);
    return parser.parse(tokens);
  }

  /**
   * Static Parse Inline Method
   */
  /** @hot */
  static parseInline<ParserOutput = string, RendererOutput = string>(tokens: Token[], options?: MarkedOptions<ParserOutput, RendererOutput>) {
    // hot-path: allow Each public call needs its own instance for options and recursive calls.
    const parser = new _Parser<ParserOutput, RendererOutput>(options);
    return parser.parseInline(tokens);
  }

  /**
   * Parse Loop
   */
  /** @hot */
  parse(tokens: Token[]): ParserOutput {
    this.renderer.parser = this;
    let out = '';

    for (let i = 0; i < tokens.length; i++) {
      const anyToken = tokens[i];

      // Run any renderer extensions
      const rendererExt = this.options.extensions?.renderers;
      // hot-path: allow Extensions use the public token names and callback context.
      if (rendererExt && Object.hasOwn(rendererExt, anyToken.type) && rendererExt[anyToken.type]) {
        const genericToken = anyToken as Tokens.Generic;
        // hot-path: allow Extensions use the public token names and callback context.
        const ret = rendererExt[genericToken.type].call({ parser: this }, genericToken);
        // hot-path: allow The extension fallback accepts only built-in token types.
        if (ret !== false || !['space', 'hr', 'heading', 'code', 'table', 'blockquote', 'list', 'checkbox', 'html', 'def', 'paragraph', 'text'].includes(genericToken.type)) {
          // hot-path: allow The renderer builds the output HTML string.
          out += ret === false ? '' : ret ?? '';
          continue;
        }
      }

      const token = anyToken as MarkedToken;

      // hot-path: allow Public token types are strings.
      switch (token.type) {
        case 'space': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.space(token);
          break;
        }
        case 'hr': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.hr(token);
          break;
        }
        case 'heading': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.heading(token);
          break;
        }
        case 'code': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.code(token);
          break;
        }
        case 'table': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.table(token);
          break;
        }
        case 'blockquote': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.blockquote(token);
          break;
        }
        case 'list': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.list(token);
          break;
        }
        case 'checkbox': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.checkbox(token);
          break;
        }
        case 'html': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.html(token);
          break;
        }
        case 'def': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.def(token);
          break;
        }
        case 'paragraph': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.paragraph(token);
          break;
        }
        case 'text': {
          // hot-path: allow The renderer builds the output HTML string.
          out += this.renderer.text(token);
          break;
        }

        default: {
          // hot-path: allow Public token types are strings.
          const errMsg = 'Token with "' + token.type + '" type was not found.';
          if (this.options.silent) {
            // hot-path: allow Report an invalid token only in silent mode.
            console.error(errMsg);
            return '' as ParserOutput;
          } else {
            throw new Error(errMsg);
          }
        }
      }
    }

    return out as ParserOutput;
  }

  /**
   * Parse Inline Tokens
   */
  /** @hot */
  parseInline(tokens: Token[], renderer: _Renderer<ParserOutput, RendererOutput> | _TextRenderer<RendererOutput> = this.renderer): ParserOutput {
    this.renderer.parser = this;
    let out = '';

    for (let i = 0; i < tokens.length; i++) {
      const anyToken = tokens[i];

      // Run any renderer extensions
      const rendererExt = this.options.extensions?.renderers;
      // hot-path: allow Extensions use the public token names and callback context.
      if (rendererExt && Object.hasOwn(rendererExt, anyToken.type) && rendererExt[anyToken.type]) {
        // hot-path: allow Extensions use the public token names and callback context.
        const ret = rendererExt[anyToken.type].call({ parser: this }, anyToken);
        // hot-path: allow The extension fallback accepts only built-in token types.
        if (ret !== false || !['escape', 'html', 'link', 'image', 'checkbox', 'strong', 'em', 'codespan', 'br', 'del', 'text'].includes(anyToken.type)) {
          // hot-path: allow The renderer builds the output HTML string.
          out += ret === false ? '' : ret ?? '';
          continue;
        }
      }

      const token = anyToken as MarkedToken;

      // hot-path: allow Public token types are strings.
      switch (token.type) {
        case 'escape': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.text(token);
          break;
        }
        case 'html': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.html(token);
          break;
        }
        case 'link': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.link(token);
          break;
        }
        case 'image': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.image(token);
          break;
        }
        case 'checkbox': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.checkbox(token);
          break;
        }
        case 'strong': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.strong(token);
          break;
        }
        case 'em': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.em(token);
          break;
        }
        case 'codespan': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.codespan(token);
          break;
        }
        case 'br': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.br(token);
          break;
        }
        case 'del': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.del(token);
          break;
        }
        case 'text': {
          // hot-path: allow The renderer builds the output HTML string.
          out += renderer.text(token);
          break;
        }
        default: {
          // hot-path: allow Public token types are strings.
          const errMsg = 'Token with "' + token.type + '" type was not found.';
          if (this.options.silent) {
            // hot-path: allow Report an invalid token only in silent mode.
            console.error(errMsg);
            return '' as ParserOutput;
          } else {
            throw new Error(errMsg);
          }
        }
      }
    }
    return out as ParserOutput;
  }
}
