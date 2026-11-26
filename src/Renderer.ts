import { _defaults } from './defaults.ts';
import {
  cleanUrl,
  escapeHtmlEntities,
} from './helpers.ts';
import { other } from './rules.ts';
import { emit } from './OutputBuffer.ts';
import type { OutputBuffer } from './OutputBuffer.ts';
import type { MarkedOptions } from './MarkedOptions.ts';
import type { Token, Tokens } from './Tokens.ts';
import type { _Parser } from './Parser.ts';

// Literal code, escaped punctuation and autolinks must survive the later
// alt-attribute escaping. Copy tokens so rendering the image cannot change
// the token tree.
function imageTextTokens(tokens: Token[], literal = false): Token[] {
  let copy: Token[] | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let next: Token = token;
    if (token.type === 'codespan' || token.type === 'escape' || (literal && token.type === 'text')) {
      const text = escapeHtmlEntities(token.text, true);
      if (text !== token.text) {
        next = { ...token, text };
      }
    } else if (token.type === 'link' && token.autolink) {
      const text = escapeHtmlEntities(token.text, true);
      const children = token.tokens;
      const nextChildren = children
        ? (children.length === 1 && children[0].type === 'text' && children[0].text === token.text
          ? (text !== token.text ? [{ ...children[0], text }] : children)
          : imageTextTokens(children, true))
        : children;
      if (text !== token.text || nextChildren !== children) {
        next = nextChildren !== children
          ? { ...token, text, tokens: nextChildren }
          : { ...token, text };
      }
    } else if ('tokens' in token && token.tokens) {
      const nextChildren = imageTextTokens(token.tokens, literal);
      if (nextChildren !== token.tokens) {
        next = { ...token, tokens: nextChildren };
      }
    }
    if (next !== token) {
      if (!copy) {
        copy = tokens.slice(0, i);
      }
      copy.push(next);
    } else if (copy) {
      copy.push(token);
    }
  }
  return copy || tokens;
}

/**
 * Renderer
 */
export class _Renderer<ParserOutput = string, RendererOutput = string> {
  options: MarkedOptions<ParserOutput, RendererOutput>;
  parser!: _Parser<ParserOutput, RendererOutput>; // set by the parser
  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    this.options = options || _defaults;
  }

  space(token: Tokens.Space): RendererOutput {
    const output = { html: '' };
    this.spaceAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  spaceAt(token: Tokens.Space, output: OutputBuffer): void {

  }

  code({ text, lang, escaped }: Tokens.Code): RendererOutput;
  code(token: Tokens.Code): RendererOutput {
    const output = { html: '' };
    this.codeAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  codeAt(token: Tokens.Code, output: OutputBuffer): void {
    const { text, lang, escaped } = token;
    const langString = (lang || '').match(other.notSpaceStart)?.[0];
    if (langString) {
      emit(output, '<pre><code class="language-');
      emit(output, escapeHtmlEntities(langString));
      emit(output, '">');
    } else {
      emit(output, '<pre><code>');
    }
    if (text) {
      const code = text.replace(other.endingNewline, '');
      emit(output, escaped ? code : escapeHtmlEntities(code, true));
      emit(output, '\n');
    }
    emit(output, '</code></pre>\n');
  }

  blockquote({ tokens }: Tokens.Blockquote): RendererOutput;
  blockquote(token: Tokens.Blockquote): RendererOutput {
    const output = { html: '' };
    this.blockquoteAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  blockquoteAt(token: Tokens.Blockquote, output: OutputBuffer): void {
    emit(output, '<blockquote>\n');
    this.parser.renderBlocks(token.tokens, output);
    emit(output, '</blockquote>\n');
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

  def(token: Tokens.Def): RendererOutput {
    const output = { html: '' };
    this.defAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  defAt(token: Tokens.Def, output: OutputBuffer): void {

  }

  heading({ tokens, depth }: Tokens.Heading): RendererOutput;
  heading(token: Tokens.Heading): RendererOutput {
    const output = { html: '' };
    this.headingAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  headingAt(token: Tokens.Heading, output: OutputBuffer): void {
    const { depth, tokens } = token;
    emit(output, '<h');
    emit(output, depth);
    emit(output, '>');
    this.parser.renderInlines(tokens, output);
    emit(output, '</h');
    emit(output, depth);
    emit(output, '>\n');
  }

  hr(token: Tokens.Hr): RendererOutput {
    const output = { html: '' };
    this.hrAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  hrAt(token: Tokens.Hr, output: OutputBuffer): void {
    emit(output, '<hr>\n');
  }

  list(token: Tokens.List): RendererOutput {
    const output = { html: '' };
    _Renderer.prototype.listAt.call(rendererSlots(this), token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  listAt(token: Tokens.List, output: OutputBuffer): void {
    if (token.ordered) {
      emit(output, '<ol');
      if (token.start !== 1) {
        emit(output, ' start="');
        emit(output, token.start);
        emit(output, '"');
      }
      emit(output, '>\n');
    } else {
      emit(output, '<ul>\n');
    }
    for (let i = 0; i < token.items.length; i++) {
      this.listitemAt(token.items[i], output);
    }
    emit(output, token.ordered ? '</ol>\n' : '</ul>\n');
  }

  listitem(item: Tokens.ListItem): RendererOutput {
    const output = { html: '' };
    this.listitemAt(item, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  listitemAt(item: Tokens.ListItem, output: OutputBuffer): void {
    emit(output, '<li>');
    this.parser.renderBlocks(item.tokens, output);
    emit(output, '</li>\n');
  }

  checkbox({ checked }: Tokens.Checkbox): RendererOutput;
  checkbox(token: Tokens.Checkbox): RendererOutput {
    const output = { html: '' };
    this.checkboxAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  checkboxAt(token: Tokens.Checkbox, output: OutputBuffer): void {
    emit(output, token.checked
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ');
  }

  paragraph({ tokens }: Tokens.Paragraph): RendererOutput;
  paragraph(token: Tokens.Paragraph): RendererOutput {
    const output = { html: '' };
    this.paragraphAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  paragraphAt(token: Tokens.Paragraph, output: OutputBuffer): void {
    emit(output, '<p>');
    this.parser.renderInlines(token.tokens, output);
    emit(output, '</p>\n');
  }

  table(token: Tokens.Table): RendererOutput {
    const output = { html: '' };
    _Renderer.prototype.tableAt.call(rendererSlots(this), token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  tableAt(token: Tokens.Table, output: OutputBuffer): void {
    emit(output, '<table>\n<thead>\n');
    this.tableCellsAt(token.header, output);
    emit(output, '</thead>\n');
    if (token.rows.length) {
      const beforeBody = output.html;
      emit(output, '<tbody>');
      const bodyStart = output.html.length;
      for (let i = 0; i < token.rows.length; i++) {
        this.tableCellsAt(token.rows[i], output);
      }
      if (output.html.length === bodyStart) {
        output.html = beforeBody;
      } else {
        emit(output, '</tbody>');
      }
    }
    emit(output, '</table>\n');
  }

  tablerow({ text }: Tokens.TableRow<ParserOutput>): RendererOutput;
  tablerow(token: Tokens.TableRow<ParserOutput>): RendererOutput {
    const output = { html: '' };
    this.tablerowAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  tablerowAt(token: Tokens.TableRow<ParserOutput>, output: OutputBuffer): void {
    emit(output, '<tr>\n');
    emit(output, token.text);
    emit(output, '</tr>\n');
  }

  tablecell(token: Tokens.TableCell): RendererOutput {
    const output = { html: '' };
    this.tablecellAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  tablecellAt(token: Tokens.TableCell, output: OutputBuffer): void {
    emit(output, token.header ? '<th' : '<td');
    if (token.align) {
      emit(output, ' align="');
      emit(output, token.align);
      emit(output, '"');
    }
    emit(output, '>');
    this.parser.renderInlines(token.tokens, output);
    emit(output, token.header ? '</th>\n' : '</td>\n');
  }

  /**
   * span level renderer
   */
  strong({ tokens }: Tokens.Strong): RendererOutput;
  strong(token: Tokens.Strong): RendererOutput {
    const output = { html: '' };
    this.strongAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  strongAt(token: Tokens.Strong, output: OutputBuffer): void {
    emit(output, '<strong>');
    this.parser.renderInlines(token.tokens, output);
    emit(output, '</strong>');
  }

  em({ tokens }: Tokens.Em): RendererOutput;
  em(token: Tokens.Em): RendererOutput {
    const output = { html: '' };
    this.emAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  emAt(token: Tokens.Em, output: OutputBuffer): void {
    emit(output, '<em>');
    this.parser.renderInlines(token.tokens, output);
    emit(output, '</em>');
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
    emit(output, '<code>');
    emit(output, escapeHtmlEntities(token.text, true));
    emit(output, '</code>');
  }

  br(token: Tokens.Br): RendererOutput {
    const output = { html: '' };
    this.brAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  brAt(token: Tokens.Br, output: OutputBuffer): void {
    emit(output, '<br>');
  }

  del({ tokens }: Tokens.Del): RendererOutput;
  del(token: Tokens.Del): RendererOutput {
    const output = { html: '' };
    this.delAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  delAt(token: Tokens.Del, output: OutputBuffer): void {
    emit(output, '<del>');
    this.parser.renderInlines(token.tokens, output);
    emit(output, '</del>');
  }

  link({ href, title, text, tokens, autolink }: Tokens.Link): RendererOutput;
  link(token: Tokens.Link): RendererOutput {
    const output = { html: '' };
    this.linkAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  linkAt(token: Tokens.Link, output: OutputBuffer): void {
    const { title, text, tokens, autolink } = token;
    const href = cleanUrl(token.href);
    if (href !== null) {
      emit(output, '<a href="');
      emit(output, escapeHtmlEntities(href, autolink));
      emit(output, '"');
      if (title) {
        emit(output, ' title="');
        emit(output, escapeHtmlEntities(title));
        emit(output, '"');
      }
      emit(output, '>');
    }
    if (autolink) {
      emit(output, escapeHtmlEntities(text, true));
    } else {
      this.parser.renderInlines(tokens, output);
    }
    if (href !== null) emit(output, '</a>');
  }

  image({ href, title, text, tokens }: Tokens.Image): RendererOutput;
  image(token: Tokens.Image): RendererOutput {
    const output = { html: '' };
    this.imageAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  imageAt(token: Tokens.Image, output: OutputBuffer): void {
    const { href, title, tokens } = token;
    let text = token.text;
    if (tokens) {
      const previous = output.html;
      output.html = '';
      this.parser.renderText(imageTextTokens(tokens), output);
      text = output.html;
      output.html = previous;
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      emit(output, escapeHtmlEntities(text));
      return;
    }
    emit(output, '<img src="');
    emit(output, escapeHtmlEntities(cleanHref));
    emit(output, '" alt="');
    emit(output, escapeHtmlEntities(text));
    emit(output, '"');
    if (title) {
      emit(output, ' title="');
      emit(output, escapeHtmlEntities(title));
      emit(output, '"');
    }
    emit(output, '>');
  }

  text(token: Tokens.Text | Tokens.Escape): RendererOutput {
    const output = { html: '' };
    this.textAt(token, output);
    return output.html as RendererOutput;
  }

  /** @internal */
  /** @hot */
  textAt(token: Tokens.Text | Tokens.Escape, output: OutputBuffer): void {
    if ('tokens' in token && token.tokens) {
      this.parser.renderInlines(token.tokens, output);
    } else {
      emit(output, 'escaped' in token && token.escaped ? token.text : escapeHtmlEntities(token.text));
    }
  }

  /** @internal */
  tableCellsAt(cells: Tokens.TableCell[], output: OutputBuffer): void {
    emit(output, '<tr>\n');
    for (let i = 0; i < cells.length; i++) {
      this.tablecellAt(cells[i], output);
    }
    emit(output, '</tr>\n');
  }
}

const rendererMethods = ['space', 'code', 'blockquote', 'html', 'def', 'heading', 'hr', 'list', 'listitem', 'checkbox', 'paragraph', 'table', 'tablerow', 'tablecell', 'strong', 'em', 'codespan', 'br', 'del', 'link', 'image', 'text'] as const;
const configuredRenderers = new WeakMap<object, unknown>();

// The checker cannot follow slots that call user renderers.
function createRendererSlots<P, R>(renderer: _Renderer<P, R>): _Renderer<P, R> {
  let slots = renderer;
  for (const name of rendererMethods) {
    const method = renderer[name];
    if (method === _Renderer.prototype[name]) continue;
    if (slots === renderer) slots = Object.create(renderer);
    const render = method as (this: _Renderer<P, R>, token: Token | Tokens.TableCell | Tokens.TableRow<P>) => R;
    Object.defineProperty(slots, name + 'At', {
      value(token: Token, output: OutputBuffer) {
        emit(output, render.call(renderer, token));
      },
    });
    if (name === 'tablerow') {
      Object.defineProperty(slots, 'tableCellsAt', {
        value(cells: Tokens.TableCell[], output: OutputBuffer) {
          const previous = output.html;
          output.html = '';
          for (let i = 0; i < cells.length; i++) {
            slots.tablecellAt(cells[i], output);
          }
          const text = output.html;
          output.html = previous;
          slots.tablerowAt({ text: text as P }, output);
        },
      });
    }
  }
  return slots;
}

export function configureRenderer<P, R>(renderer: _Renderer<P, R>): void {
  configuredRenderers.set(renderer, createRendererSlots(renderer));
}

export function rendererSlots<P, R>(renderer: _Renderer<P, R>): _Renderer<P, R> {
  return configuredRenderers.get(renderer) as _Renderer<P, R> | undefined ?? createRendererSlots(renderer);
}
