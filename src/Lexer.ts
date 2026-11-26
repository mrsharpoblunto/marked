import { _Tokenizer, inlineTextAt } from './Tokenizer.ts';
import { _defaults } from './defaults.ts';
import { other, block, inline } from './rules.ts';
import { beginEmStrongDelCloserScan, cachedLastPossibleDelCloserIndex, cachedLastPossibleEmStrongCloserIndex, endEmStrongDelCloserScan, normalizeLabel } from './helpers.ts';
import type { Token, TokensList, Tokens } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/**
 * Block Lexer
 */
export class _Lexer<ParserOutput = string, RendererOutput = string> {
  tokens: TokensList;
  options: MarkedOptions<ParserOutput, RendererOutput>;
  state: {
    inLink: boolean;
    inRawBlock: boolean;
    /** a link was produced in the inline run currently being scanned */
    linkEmitted: boolean;
    /**
     * false while scanning an inline run whose source contains no ')',
     * letting Tokenizer.link bail out before its quadratic backtracking.
     * Anchored once per run by inlineTokens.
     */
    linkParenPossible: boolean;
    top: boolean;
    /** lexing the content of a block quote, whose nested markers the outermost one has expanded */
    inBlockquote: boolean;
    /** the last block token lexed in the current block run, so a tokenizer can check the token before it */
    lastToken?: Token;
  };

  public inlineQueue: { src: string, tokens: Token[] }[];

  private tokenizer: _Tokenizer<ParserOutput, RendererOutput>;

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    // TokenList cannot be created in one go
    this.tokens = [] as unknown as TokensList;
    this.tokens.links = Object.create(null);
    this.options = options || _defaults;
    this.options.tokenizer = this.options.tokenizer || new _Tokenizer<ParserOutput, RendererOutput>();
    this.tokenizer = this.options.tokenizer;
    this.tokenizer.options = this.options;
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
      inBlockquote: false,
    };

    const rules = {
      other,
      block: block.normal,
      inline: inline.normal,
    };

    if (this.options.pedantic) {
      rules.block = block.pedantic;
      rules.inline = inline.pedantic;
    } else if (this.options.gfm) {
      rules.block = block.gfm;
      if (this.options.breaks) {
        rules.inline = inline.breaks;
      } else {
        rules.inline = inline.gfm;
      }
    }
    this.tokenizer.rules = rules;
  }

  /**
   * Expose Rules
   */
  static get rules() {
    return {
      block,
      inline,
    };
  }

  /**
   * Static Lex Method
   */
  /** @hot */
  static lex<ParserOutput = string, RendererOutput = string>(src: string, options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const lexer = new _Lexer<ParserOutput, RendererOutput>(options);
    return lexer.lex(src);
  }

  /**
   * Static Lex Inline Method
   */
  /** @hot */
  static lexInline<ParserOutput = string, RendererOutput = string>(src: string, options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const lexer = new _Lexer<ParserOutput, RendererOutput>(options);
    return lexer.inlineTokens(src);
  }

  /**
   * Preprocessing
   */
  /** @hot */
  lex(src: string) {
    src = src.replace(other.carriageReturn, '\n');

    this.blockTokens(src, this.tokens);

    for (let i = 0; i < this.inlineQueue.length; i++) {
      const next = this.inlineQueue[i];
      // an inline <pre>, <code>, <kbd> or <script> left open ends with the block
      // holding it; carried over, it would stop every later block's text from
      // being escaped
      this.state.inRawBlock = false;
      this.inlineTokens(next.src, next.tokens);
    }
    this.inlineQueue = [];

    return this.tokens;
  }

  /**
   * Lexing
   */
  blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
  blockTokens(src: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
  blockTokens(src: string, tokens: Token[] = [], lastParagraphClipped = false) {
    this.tokenizer.lexer = this;
    // list items and block quotes lex their contents with a nested call, so
    // restore the outer last token when it returns
    const outerLastToken = this.state.lastToken;
    if (this.options.pedantic) {
      src = src.replace(other.tabCharGlobal, '    ').replace(other.spaceLine, '');
    }

    let srcLength = Infinity;
    let lastParagraph: Token | undefined;
    const mergeAdjacentParagraphs = this.options.gfm && !this.options.pedantic
      && this.tokenizer.paragraph === _Tokenizer.prototype.paragraph;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      this.state.lastToken = tokens.at(-1);
      let token: Tokens.Generic | undefined;

      const extensions = this.options.extensions?.block;
      if (extensions?.length) {
        const count = extensions.length;
        for (let i = 0; i < count; i++) {
          if (i in extensions && (token = extensions[i].call({ lexer: this }, src, tokens))) {
            src = src.substring(token.raw.length);
            tokens.push(token);
            break;
          }
        }
        if (token) continue;
      }

      const firstCode = src.charCodeAt(0);
      let marker = firstCode;
      let indent = 0;
      while (marker === 32 && indent < 4) {
        marker = src.charCodeAt(++indent);
      }

      // newline
      if ((firstCode === 10 || firstCode === 32 || firstCode === 9
        || this.tokenizer.space !== _Tokenizer.prototype.space)
        && (token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          // if there's a single \n as a spacer, it's terminating the last line,
          // so move it there so that we don't get unnecessary paragraph tags
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      // code
      if ((indent === 4 || marker === 9
        || this.tokenizer.code !== _Tokenizer.prototype.code)
        && (token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // fences
      if ((marker === 96 || marker === 126
        || this.tokenizer.fences !== _Tokenizer.prototype.fences)
        && (token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // heading
      if ((marker === 35
        || this.tokenizer.heading !== _Tokenizer.prototype.heading)
        && (token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // hr
      if ((marker === 42 || marker === 45 || marker === 95
        || this.tokenizer.hr !== _Tokenizer.prototype.hr)
        && (token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // blockquote
      if ((marker === 62
        || this.tokenizer.blockquote !== _Tokenizer.prototype.blockquote)
        && (token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // list
      if ((marker === 42 || marker === 43 || marker === 45 || (marker >= 48 && marker <= 57)
        || this.tokenizer.list !== _Tokenizer.prototype.list)
        && (token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // html
      if ((marker === 60 || (indent === 4 && this.options.pedantic)
        || this.tokenizer.html !== _Tokenizer.prototype.html)
        && (token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // def
      if ((marker === 91 || (indent === 4 && this.options.pedantic)
        || this.tokenizer.def !== _Tokenizer.prototype.def)
        && (token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          // The first definition of a label wins, but a later one still consumes its text
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = {
              href: token.href,
              title: token.title,
            };
          }
          tokens.push(token);
        }
        continue;
      }

      // table (gfm)
      if ((this.options.gfm && !this.options.pedantic
        || this.tokenizer.table !== _Tokenizer.prototype.table)
        && (token = this.tokenizer.table(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // lheading
      if (token = this.tokenizer.lheading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // top-level paragraph
      // prevent paragraph consuming extensions by clipping 'src' to extension start
      let cutSrc = src;
      const startExtensions = this.options.extensions?.startBlock;
      if (startExtensions?.length) {
        let startIndex = Infinity;
        const tempSrc = src.slice(1);
        const count = startExtensions.length;
        for (let i = 0; i < count; i++) {
          if (!(i in startExtensions)) continue;
          const tempStart = startExtensions[i].call({ lexer: this }, tempSrc);
          if (typeof tempStart === 'number' && tempStart >= 0) {
            startIndex = Math.min(startIndex, tempStart);
          }
        }
        if (startIndex < Infinity && startIndex >= 0) {
          cutSrc = src.substring(0, startIndex + 1);
        }
      }
      if (this.state.top && (token = this.tokenizer.paragraph(cutSrc))) {
        const lastToken = tokens.at(-1);
        // A table-shaped header rejected by the table tokenizer is still
        // paragraph continuation, not a new block. Keep custom paragraph
        // tokenizers' choice to emit separate paragraphs unchanged.
        if ((lastParagraphClipped || (lastToken === lastParagraph && mergeAdjacentParagraphs)) && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1)!.src = lastToken.text;
          lastParagraph = lastToken;
        } else {
          tokens.push(token);
          lastParagraph = token;
        }
        lastParagraphClipped = cutSrc.length !== src.length;
        src = src.substring(token.raw.length);
        continue;
      }

      // text
      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    this.state.top = true;
    this.state.lastToken = outerLastToken;
    return tokens;
  }

  inline(src: string, tokens: Token[] = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  /**
   * Does this link text hold a link already? An image does not count: an image
   * may hold a link, a link may not.
   */
  /** @hot */
  private linkInText(text: string): boolean {
    if (!text.includes('[')) {
      return false;
    }

    const linkRule = this.tokenizer.rules.inline.link;
    for (const match of text.matchAll(this.tokenizer.rules.inline.blockSkip)) {
      // blockSkip also matches code spans and html, and the `!` of an image is
      // left out of the match, so read the character before it.
      if (linkRule.test(match[0]) && text.charCodeAt(match.index - 1) !== 33) {
        return true;
      }
    }

    for (const match of text.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charCodeAt(0) === 33 || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      // a candidate holding a link is not a link either, so it does not count
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) {
        continue;
      }
      return true;
    }

    return false;
  }

  /**
   * Lexing/Compiling
   */
  /** @hot */
  inlineTokens(src: string, tokens: Token[] = []): Token[] {
    this.tokenizer.lexer = this;
    // One paren scan per inline run, shared with Tokenizer.link: without a
    // ')' ahead the link regex cannot match, and skipping it avoids its
    // quadratic backtracking over unterminated-link inputs like
    // `'[a](b'.repeat(n)`. Extension tokenizers can pass generated text to
    // nested runs, so each run must check its own source.
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = src.includes(')');
    try {
      return this.#inlineTokensInner(src, tokens);
    } finally {
      // Restore the outer run's flag for the rest of its loop.
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  /** @hot */
  #inlineTokensInner(src: string, tokens: Token[]): Token[] {
    // The masked source is only read by emStrong and del, which need a *, _ or
    // ~ to start. Skip building it for a run without one, unless a custom
    // tokenizer or an emStrongMask hook may read it.
    const hasDelimiter = src.includes('*') || src.includes('_') || src.includes('~');
    const maskedSrc = hasDelimiter
      || this.options.hooks?.emStrongMask
      || this.tokenizer.emStrong !== _Tokenizer.prototype.emStrong
      || this.tokenizer.del !== _Tokenizer.prototype.del
      ? this.#maskSrc(src)
      : src;

    // Without a delimiter no opener can match, so nothing reads the closer scan.
    if (!hasDelimiter) {
      return this.#tokenizeInlines(src, maskedSrc, tokens);
    }

    // One scan of this maskedSrc for the last emphasis, strong, and
    // strikethrough closers, shared by every opener in the pass. Popped
    // when the pass ends so the source is not retained (#4099).
    beginEmStrongDelCloserScan(this.tokenizer, maskedSrc);
    try {
      return this.#tokenizeInlines(src, maskedSrc, tokens);
    } finally {
      endEmStrongDelCloserScan(this.tokenizer);
    }
  }

  /** @hot */
  #tokenizeInlines(src: string, maskedSrc: string, tokens: Token[]): Token[] {
    let keepPrevChar = false;
    let prevChar = '';
    let offset = 0;
    let lastOffset = -1;
    const maskOffset = maskedSrc.length - src.length;
    while (offset < src.length) {
      if (offset === lastOffset) {
        this.infiniteLoopError(src.charCodeAt(offset));
        break;
      }
      lastOffset = offset;
      let remaining: string | undefined;

      if (!keepPrevChar) {
        prevChar = '';
      }
      keepPrevChar = false;

      let token: Tokens.Generic | undefined;

      // extensions
      const extensions = this.options.extensions?.inline;
      if (extensions?.length) {
        const count = extensions.length;
        for (let i = 0; i < count; i++) {
          if (i in extensions && (token = extensions[i].call({ lexer: this }, remaining ??= src.slice(offset), tokens))) {
            offset += token.raw.length;
            tokens.push(token);
            break;
          }
        }
        if (token) continue;
      }

      const firstCode = src.charCodeAt(offset);
      // escape
      if ((firstCode === 92
        || this.tokenizer.escape !== _Tokenizer.prototype.escape)
        && (token = this.tokenizer.escape(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // tag
      if ((firstCode === 60
        || this.tokenizer.tag !== _Tokenizer.prototype.tag)
        && (token = this.tokenizer.tag(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // link
      if ((firstCode === 91 || firstCode === 33
        || this.tokenizer.link !== _Tokenizer.prototype.link)
        && (token = this.tokenizer.link(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // reflink, nolink
      if ((firstCode === 91 || firstCode === 33
        || this.tokenizer.reflink !== _Tokenizer.prototype.reflink)
        && (token = this.tokenizer.reflink(remaining ??= src.slice(offset), this.tokens.links))) {
        offset += token.raw.length;
        const lastToken = tokens.at(-1);
        if (token.type === 'text' && lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // #4099 follow-up: for a run of `*` or `_` with no possible closer
      // anywhere ahead in maskedSrc, every opener position fails identically
      // and the outer loop walks the run char-by-char, giving O(n^2) time.
      // Consume the whole run as literal text in one step.
      if (firstCode === 42 || firstCode === 95) {
        const pos = maskOffset + offset;
        const lastCloser = cachedLastPossibleEmStrongCloserIndex(this.tokenizer, maskedSrc, firstCode);
        if (lastCloser <= pos) {
          let runEnd = offset + 1;
          while (runEnd < src.length && src.charCodeAt(runEnd) === firstCode) runEnd++;
          const raw = src.slice(offset, runEnd);
          const lastToken = tokens.at(-1);
          if (lastToken?.type === 'text' && !lastToken.escaped) {
            lastToken.raw += raw;
            lastToken.text += raw;
          } else {
            tokens.push({ type: 'text', raw, text: raw, escaped: false } as Tokens.Text);
          }
          offset = runEnd;
          prevChar = raw[0];
          keepPrevChar = true;
          continue;
        }
      } else if (firstCode === 126) {
        const pos = maskOffset + offset;
        const lastCloser = cachedLastPossibleDelCloserIndex(this.tokenizer, maskedSrc);
        if (lastCloser <= pos) {
          let runEnd = offset + 1;
          while (runEnd < src.length && src.charCodeAt(runEnd) === 126 /* ~ */) runEnd++;
          const raw = src.slice(offset, runEnd);
          const lastToken = tokens.at(-1);
          if (lastToken?.type === 'text' && !lastToken.escaped) {
            lastToken.raw += raw;
            lastToken.text += raw;
          } else {
            tokens.push({ type: 'text', raw, text: raw, escaped: false } as Tokens.Text);
          }
          offset = runEnd;
          prevChar = raw[0];
          keepPrevChar = true;
          continue;
        }
      }

      // em & strong
      if ((firstCode === 42 || firstCode === 95
        || this.tokenizer.emStrong !== _Tokenizer.prototype.emStrong)
        && (token = this.tokenizer.emStrong(remaining ??= src.slice(offset), maskedSrc, prevChar))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // code
      if ((firstCode === 96
        || this.tokenizer.codespan !== _Tokenizer.prototype.codespan)
        && (token = this.tokenizer.codespan(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // br
      if ((firstCode === 32 || firstCode === 92 || firstCode === 10
        || this.tokenizer.br !== _Tokenizer.prototype.br)
        && (token = this.tokenizer.br(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // del (gfm)
      if ((firstCode === 126
        || this.tokenizer.del !== _Tokenizer.prototype.del)
        && (token = this.tokenizer.del(remaining ??= src.slice(offset), maskedSrc, prevChar))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // autolink
      if ((firstCode === 60
        || this.tokenizer.autolink !== _Tokenizer.prototype.autolink)
        && (token = this.tokenizer.autolink(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // url (gfm)
      if (!this.state.inLink
        && ((this.options.gfm && !this.options.pedantic
          && ((firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122)
            || (firstCode >= 48 && firstCode <= 57) || firstCode === 46 || firstCode === 95
            || firstCode === 43 || firstCode === 45))
          || this.tokenizer.url !== _Tokenizer.prototype.url)
        && (token = this.tokenizer.url(remaining ??= src.slice(offset)))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // text
      // prevent inlineText consuming extensions by clipping 'src' to extension start
      let cutSrc: string | undefined;
      const startExtensions = this.options.extensions?.startInline;
      if (startExtensions?.length) {
        let startIndex = Infinity;
        const tempSrc = src.slice(offset + 1);
        const count = startExtensions.length;
        for (let i = 0; i < count; i++) {
          if (!(i in startExtensions)) continue;
          const tempStart = startExtensions[i].call({ lexer: this }, tempSrc);
          if (typeof tempStart === 'number' && tempStart >= 0) {
            startIndex = Math.min(startIndex, tempStart);
          }
        }
        if (startIndex < Infinity && startIndex >= 0) {
          cutSrc = src.slice(offset, offset + startIndex + 1);
        }
      }
      if (token = this.tokenizer.inlineText === _Tokenizer.prototype.inlineText
        ? this.tokenizer[inlineTextAt](cutSrc ?? src, cutSrc === undefined ? offset : 0)
        : this.tokenizer.inlineText(cutSrc ?? remaining ?? src.slice(offset))) {
        offset += token.raw.length;
        const lastChar = token.raw.slice(-1);
        if (lastChar !== '_') { // Track prevChar before string of ____ started
          prevChar = lastChar;
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      this.infiniteLoopError(src.charCodeAt(offset));
      break;
    }

    return tokens;
  }

  /**
   * Mask links, code spans, raw html and autolinks. blockSkip finds every
   * `<...>` run, but only real raw html and autolinks take precedence over
   * emphasis: other text in angle brackets, like `<*name*>`, stays unmasked so
   * emphasis can open and close in it. A tag may also run past the first `>`,
   * as in `<a title=">">`, so mask the whole tag.
   */
  /** @hot */
  #maskBlocks(src: string): string {
    const { blockSkip, tag, autolink } = this.tokenizer.rules.inline;
    let masked = '';
    let last = 0;
    let match: RegExpExecArray | null;
    blockSkip.lastIndex = 0;
    while ((match = blockSkip.exec(src))) {
      const start = match.index + (match[2] ? match[2].length : 0);
      let end = match.index + match[0].length;
      if (src.charCodeAt(start) === 60) {
        const rest = src.slice(start);
        const html = tag.exec(rest) || autolink.exec(rest);
        if (!html) {
          blockSkip.lastIndex = start + 1;
          continue;
        }
        end = start + html[0].length;
        blockSkip.lastIndex = end;
      }
      masked += src.slice(last, start) + '[' + 'a'.repeat(end - start - 2) + ']';
      last = end;
    }
    return last === 0 ? src : masked + src.slice(last);
  }

  /**
   * Mask links, code, html and escapes so emStrong and del do not see their
   * delimiters inside them.
   */
  /** @hot */
  #maskSrc(src: string): string {
    // String with links masked to avoid interference with em and strong
    let maskedSrc = src;

    // Mask out reflinks
    if (this.tokens.links && src.includes('[')) {
      const reflinkSearch = this.tokenizer.rules.inline.reflinkSearch;
      const maskReflink = (match0: string): string => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        // CommonMark: "Links may not contain other links, at any level of
        // nesting." A candidate whose text already holds one never becomes a
        // link, so flattening the whole span would hide the emphasis that
        // does still apply inside it. Mask the links it holds instead.
        // Images are exempt: their text is flattened into an alt attribute.
        if (refStart > 1 && match0.charCodeAt(0) !== 33) {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearch, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
    }

    // Mask out escaped characters.
    // Every mask must keep the length it replaces: emStrong and del line
    // maskedSrc up with src by slicing from the end. `anyPunctuation` matches
    // unicode punctuation, so an escaped astral character is 3 code units.
    // A backslash inside a code span is literal, not an escape. Mask the
    // backticks inside the span instead, so blockSkip still skips all of it.
    maskedSrc = maskedSrc.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) {
        return '+'.repeat(match0.length);
      }
      if (code) {
        return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return match0;
    });

    // Mask out other blocks
    maskedSrc = this.#maskBlocks(maskedSrc);

    // Mask out blocks from extensions
    maskedSrc = this.options.hooks?.emStrongMask?.call({ lexer: this }, maskedSrc) ?? maskedSrc;

    return maskedSrc;
  }

  /** @hotIgnore Only runs when tokenization fails to advance. */
  private infiniteLoopError(byte: number) {
    const errMsg = 'Infinite loop on byte: ' + byte;
    if (this.options.silent) {
      console.error(errMsg);
    } else {
      throw new Error(errMsg);
    }
  }
}
