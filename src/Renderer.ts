import { _defaults } from './defaults.ts';
import {
  cleanUrl,
  escapeHtmlEntities,
} from './helpers.ts';
import { other } from './rules.ts';
import type { MarkedOptions } from './MarkedOptions.ts';
import type { Token, Tokens } from './Tokens.ts';
import type { _Parser } from './Parser.ts';

// Literal code, escaped punctuation and autolinks must survive the later
// alt-attribute escaping. Copy tokens so rendering the image cannot change
// the token tree.
/** @hotIgnore Visits the image token tree and copies tokens that need escaping. */
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

  /** @hot */
  space(token: Tokens.Space): RendererOutput {
    return '' as RendererOutput;
  }

  /** @hot */
  code({ text, lang, escaped }: Tokens.Code): RendererOutput {
    // hot-path: allow RegExp returns an array. Index zero is the full match.
    const langString = (lang || '').match(other.notSpaceStart)?.[0];

    // An empty code block has no content, so it must not gain a newline.
    // hot-path: allow Replacement normalizes Markdown text or escapes HTML.
    const code = text ? text.replace(other.endingNewline, '') + '\n' : '';

    if (!langString) {
      // hot-path: allow The renderer builds the output HTML string.
      return '<pre><code>'
        + (escaped ? code : escapeHtmlEntities(code, true))
        + '</code></pre>\n' as RendererOutput;
    }

    // hot-path: allow The renderer builds the output HTML string.
    return '<pre><code class="language-'
      + escapeHtmlEntities(langString)
      + '">'
      + (escaped ? code : escapeHtmlEntities(code, true))
      + '</code></pre>\n' as RendererOutput;
  }

  /** @hot */
  blockquote({ tokens }: Tokens.Blockquote): RendererOutput {
    const body = this.parser.parse(tokens);
    // hot-path: allow The renderer builds the output HTML string.
    return `<blockquote>\n${body}</blockquote>\n` as RendererOutput;
  }

  /** @hot */
  html({ text }: Tokens.HTML | Tokens.Tag): RendererOutput {
    return text as RendererOutput;
  }

  /** @hot */
  def(token: Tokens.Def): RendererOutput {
    return '' as RendererOutput;
  }

  /** @hot */
  heading({ tokens, depth }: Tokens.Heading): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n` as RendererOutput;
  }

  /** @hot */
  hr(token: Tokens.Hr): RendererOutput {
    return '<hr>\n' as RendererOutput;
  }

  /** @hot */
  list(token: Tokens.List): RendererOutput {
    const ordered = token.ordered;
    const start = token.start;

    let body = '';
    for (let j = 0; j < token.items.length; j++) {
      const item = token.items[j];
      // hot-path: allow The renderer builds the output HTML string.
      body += this.listitem(item);
    }

    const type = ordered ? 'ol' : 'ul';
    // hot-path: allow The renderer builds the output HTML string.
    const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
    // hot-path: allow The renderer builds the output HTML string.
    return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n' as RendererOutput;
  }

  /** @hot */
  listitem(item: Tokens.ListItem): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<li>${this.parser.parse(item.tokens)}</li>\n` as RendererOutput;
  }

  /** @hot */
  checkbox({ checked }: Tokens.Checkbox): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return '<input '
      + (checked ? 'checked="" ' : '')
      + 'disabled="" type="checkbox"> ' as RendererOutput;
  }

  /** @hot */
  paragraph({ tokens }: Tokens.Paragraph): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<p>${this.parser.parseInline(tokens)}</p>\n` as RendererOutput;
  }

  /** @hot */
  table(token: Tokens.Table): RendererOutput {
    let header = '';

    // header
    let cell = '';
    for (let j = 0; j < token.header.length; j++) {
      // hot-path: allow The renderer builds the output HTML string.
      cell += this.tablecell(token.header[j]);
    }
    // hot-path: allow Renderer methods receive temporary values in their public argument shape.
    header += this.tablerow({ text: cell as ParserOutput });

    let body = '';
    for (let j = 0; j < token.rows.length; j++) {
      const row = token.rows[j];

      cell = '';
      for (let k = 0; k < row.length; k++) {
        // hot-path: allow The renderer builds the output HTML string.
        cell += this.tablecell(row[k]);
      }

      // hot-path: allow Renderer methods receive temporary values in their public argument shape.
      body += this.tablerow({ text: cell as ParserOutput });
    }
    // hot-path: allow The renderer builds the output HTML string.
    if (body) body = `<tbody>${body}</tbody>`;

    // hot-path: allow The renderer builds the output HTML string.
    return '<table>\n'
      + '<thead>\n'
      + header
      + '</thead>\n'
      + body
      + '</table>\n' as RendererOutput;
  }

  /** @hot */
  tablerow({ text }: Tokens.TableRow<ParserOutput>): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<tr>\n${text}</tr>\n` as RendererOutput;
  }

  /** @hot */
  tablecell(token: Tokens.TableCell): RendererOutput {
    const content = this.parser.parseInline(token.tokens);
    const type = token.header ? 'th' : 'td';
    const tag = token.align
      // hot-path: allow The renderer builds the output HTML string.
      ? `<${type} align="${token.align}">`
      // hot-path: allow The renderer builds the output HTML string.
      : `<${type}>`;
    // hot-path: allow The renderer builds the output HTML string.
    return tag + content + `</${type}>\n` as RendererOutput;
  }

  /**
   * span level renderer
   */
  /** @hot */
  strong({ tokens }: Tokens.Strong): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<strong>${this.parser.parseInline(tokens)}</strong>` as RendererOutput;
  }

  /** @hot */
  em({ tokens }: Tokens.Em): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<em>${this.parser.parseInline(tokens)}</em>` as RendererOutput;
  }

  /** @hot */
  codespan({ text }: Tokens.Codespan): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<code>${escapeHtmlEntities(text, true)}</code>` as RendererOutput;
  }

  /** @hot */
  br(token: Tokens.Br): RendererOutput {
    return '<br>' as RendererOutput;
  }

  /** @hot */
  del({ tokens }: Tokens.Del): RendererOutput {
    // hot-path: allow The renderer builds the output HTML string.
    return `<del>${this.parser.parseInline(tokens)}</del>` as RendererOutput;
  }

  /** @hot */
  link({ href, title, text, tokens, autolink }: Tokens.Link): RendererOutput {
    // References are not resolved inside an autolink, so every `&` there is
    // literal. Elsewhere only an `&` that cannot start one needs escaping.
    const parsedText = autolink
      ? escapeHtmlEntities(text, true)
      : this.parser.parseInline(tokens) as string;
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return parsedText as RendererOutput;
    }
    href = escapeHtmlEntities(cleanHref, autolink);
    // hot-path: allow The renderer builds the output HTML string.
    let out = '<a href="' + href + '"';
    if (title) {
      // hot-path: allow The renderer builds the output HTML string.
      out += ' title="' + (escapeHtmlEntities(title)) + '"';
    }
    // hot-path: allow The renderer builds the output HTML string.
    out += '>' + parsedText + '</a>';
    return out as RendererOutput;
  }

  /** @hot */
  image({ href, title, text, tokens }: Tokens.Image): RendererOutput {
    if (tokens) {
      text = this.parser.parseInline(imageTextTokens(tokens), this.parser.textRenderer) as string;
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return escapeHtmlEntities(text) as RendererOutput;
    }
    href = cleanHref;

    // hot-path: allow The renderer builds the output HTML string.
    let out = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
    if (title) {
      // hot-path: allow The renderer builds the output HTML string.
      out += ` title="${escapeHtmlEntities(title)}"`;
    }
    // hot-path: allow The renderer builds the output HTML string.
    out += '>';
    return out as RendererOutput;
  }

  /** @hot */
  text(token: Tokens.Text | Tokens.Escape): RendererOutput {
    // hot-path: allow This check reads a field from the public token shape.
    return 'tokens' in token && token.tokens
      ? this.parser.parseInline(token.tokens) as unknown as RendererOutput
      // hot-path: allow This check reads a field from the public token shape.
      : ('escaped' in token && token.escaped ? token.text as RendererOutput : escapeHtmlEntities(token.text) as RendererOutput);
  }
}
