import { tokenKind, TokenKind } from './tokenKind.ts';
import { createText } from './tokenFactories.ts';
import { _Tokenizer } from './Tokenizer.ts';
import { _defaults } from './defaults.ts';
import { other, block, inline, type Rules } from './rules.ts';
import { callMaskHook, hookSlots } from './HookDispatch.ts';
import { execAt, normalizeLabel, preparedLexerRules, scanCloserHints, scanInlineRuns, sourceText } from './helpers.ts';
import type { CloserHints, InlineRuns } from './helpers.ts';
import { copyInlineCodes, inlineMaskText, maskBlocks, maskEscapes, maskReferences } from './InlineMask.ts';
import type { Token, TokensList, Tokens } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

const standardReferenceMask = inline.normal.reflinkSearch;
const standardEscapeMask = inline.normal.anyPunctuationOutsideCode;
const standardBlockMask = inline.normal.blockSkip;
const standardNoDelCloser = inline.normal.delRDelim;

const tokenizerFlags = {
  space: 1 << 0,
  code: 1 << 1,
  fences: 1 << 2,
  heading: 1 << 3,
  hr: 1 << 4,
  blockquote: 1 << 5,
  list: 1 << 6,
  html: 1 << 7,
  def: 1 << 8,
  table: 1 << 9,
  lheading: 1 << 10,
  paragraph: 1 << 11,
  text: 1 << 12,
  escape: 1 << 13,
  tag: 1 << 14,
  link: 1 << 15,
  reflink: 1 << 16,
  emStrong: 1 << 17,
  codespan: 1 << 18,
  br: 1 << 19,
  del: 1 << 20,
  autolink: 1 << 21,
  url: 1 << 22,
  inlineText: 1 << 23,
};

const blockRuleDispatch = ['code', 'fences', 'heading', 'hr', 'blockquote', 'list', 'html', 'def', 'table', 'paragraph', 'lheading', 'text'] as const;
let rulesExposed = false;

const tokenizerMethods = Object.keys(tokenizerFlags) as TokenizerMethod[];
type TokenizerMethod = keyof typeof tokenizerFlags;

type UserTokenizer = (src: string, ...args: unknown[]) => unknown;

function adaptTokenizer(context: unknown, method: UserTokenizer, offsetIndex: number) {
  function adapted(src: string, ...args: unknown[]) {
    const offset = args[offsetIndex] as number;
    args.length = offsetIndex;
    return method.call(context, src.slice(offset), ...args);
  }
  return adapted;
}

interface TokenizerDispatch<P, R> {
  slots: _Tokenizer<P, R>;
  replaced: number;
}

const tokenizerDispatches = new WeakMap<object, unknown>();

// These adapters call user code. The checker cannot follow the slots to them.
function createTokenizerDispatch<P, R>(tokenizer: _Tokenizer<P, R>): TokenizerDispatch<P, R> {
  let slots = tokenizer;
  let replaced = 0;
  for (const name of tokenizerMethods) {
    const method = tokenizer[name];
    if (method === _Tokenizer.prototype[name]) continue;
    if (replaced === 0) slots = Object.create(tokenizer);
    replaced |= tokenizerFlags[name];
    const offsetIndex = name === 'emStrong' || name === 'del' ? 2 : name === 'reflink' ? 1 : 0;
    Object.defineProperty(slots, name + 'At', { value: adaptTokenizer(tokenizer, method as UserTokenizer, offsetIndex) });
  }
  return { slots, replaced };
}

export function configureTokenizer<P, R>(tokenizer: _Tokenizer<P, R>): void {
  tokenizerDispatches.set(tokenizer, createTokenizerDispatch(tokenizer));
}

/** @hotIgnore User adapter: one source suffix per cursor position and one context per extension. */
function callExtensions<P, R>(
  extensions: NonNullable<NonNullable<MarkedOptions['extensions']>['block']>,
  lexer: _Lexer<P, R>, src: string, offset: number, tokens: Token[],
): Tokens.Generic | undefined {
  const suffix = src.slice(offset);
  const count = extensions.length;
  for (let i = 0; i < count; i++) {
    if (!(i in extensions)) continue;
    const token = extensions[i].call({ lexer }, suffix, tokens);
    if (token) return token;
  }
}

/** @hotIgnore User adapter: at most two source strings and one context per start callback. */
function clipForExtensions<P, R>(
  extensions: NonNullable<NonNullable<MarkedOptions['extensions']>['startBlock']>,
  lexer: _Lexer<P, R>, src: string, offset: number,
): string {
  let startIndex = Infinity;
  const suffix = src.slice(offset + 1);
  const count = extensions.length;
  for (let i = 0; i < count; i++) {
    if (!(i in extensions)) continue;
    const start = extensions[i].call({ lexer }, suffix);
    if (typeof start === 'number' && start >= 0) startIndex = Math.min(startIndex, start);
  }
  return startIndex < Infinity ? src.slice(0, offset + startIndex + 1) : src;
}

const knownLexers: (_Lexer<unknown, unknown> | undefined)[] = [];

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

  #slots: _Tokenizer<ParserOutput, RendererOutput>;
  #replaced = 0;
  #defaultKinds: boolean;
  #closers = { star: -1, underscore: -1, tilde: -1 };
  #runTables: InlineRuns[] = [];
  #runDepth = 0;
  #userMaskRules = false;
  #userDelimiters = false;
  #maskHook: ((src: string) => string) | undefined;
  #extensions: Pick<NonNullable<MarkedOptions['extensions']>, 'block' | 'inline' | 'startBlock' | 'startInline'> | null | undefined;

  #runningKnown = false;

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    // TokenList cannot be created in one go
    this.tokens = [] as unknown as TokensList;
    this.tokens.links = Object.create(null);
    this.options = options || _defaults;
    const suppliedTokenizer = this.options.tokenizer;
    this.tokenizer = suppliedTokenizer || new _Tokenizer<ParserOutput, RendererOutput>();
    this.options.tokenizer = this.tokenizer;
    this.#slots = this.tokenizer;
    if (suppliedTokenizer) {
      const dispatch = tokenizerDispatches.get(suppliedTokenizer) as TokenizerDispatch<ParserOutput, RendererOutput> | undefined
        ?? createTokenizerDispatch(suppliedTokenizer);
      this.#slots = dispatch.slots;
      this.#replaced = dispatch.replaced;
    }
    this.#extensions = this.options.extensions;
    this.#defaultKinds = !suppliedTokenizer && !this.#extensions && !this.options.hooks;
    this.#maskHook = this.options.hooks ? hookSlots(this.options.hooks).emStrongMask : undefined;
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

    const rules: Rules = {
      other,
      block: block.normal,
      inline: inline.normal,
      cursor: preparedLexerRules.normal,
    };

    if (this.options.pedantic) {
      rules.cursor = preparedLexerRules.pedantic;
      rules.block = block.pedantic;
      rules.inline = inline.pedantic;
    } else if (this.options.gfm) {
      rules.block = block.gfm;
      if (this.options.breaks) {
        rules.cursor = preparedLexerRules.breaks;
        rules.inline = inline.breaks;
      } else {
        rules.cursor = preparedLexerRules.gfm;
        rules.inline = inline.gfm;
      }
    }
    // A replacement regex can recognize a prefix outside the default grammar.
    // Select those dispatch entries before the first block is read.
    if (rulesExposed || suppliedTokenizer) {
      for (const name of blockRuleDispatch) {
        if (rules.block[name] !== rules.cursor!.block[name].original) this.#replaced |= tokenizerFlags[name];
      }
    }
    this.#userMaskRules = rules.inline.reflinkSearch !== standardReferenceMask
      || rules.inline.anyPunctuationOutsideCode !== standardEscapeMask || rules.inline.blockSkip !== standardBlockMask;
    this.#userDelimiters = !!this.#maskHook || !!(this.#replaced & (tokenizerFlags.emStrong | tokenizerFlags.del))
      || rules.cursor!.inline.star.original !== rules.inline.emStrongRDelimAst
      || rules.cursor!.inline.underscore.original !== rules.inline.emStrongRDelimUnd
      || (rules.inline.delRDelim !== standardNoDelCloser && rules.cursor!.inline.tilde?.original !== rules.inline.delRDelim);
    this.tokenizer.rules = rules;
  }

  /**
   * Expose Rules
   */
  static get rules() {
    rulesExposed = true;
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

  /** @internal */
  static lexKnown<P, R>(src: string, options: MarkedOptions<P, R>, blockMode: boolean): Token[] {
    if (rulesExposed) return blockMode ? _Lexer.lex(src, options) : _Lexer.lexInline(src, options);
    const mode = options.pedantic ? 4 : options.gfm ? (options.breaks ? 3 : 2) : 0;
    let lexer = knownLexers[mode] as _Lexer<P, R> | undefined;
    if (lexer && lexer.#runningKnown) return blockMode ? _Lexer.lex(src, options) : _Lexer.lexInline(src, options);
    if (lexer) {
      lexer.options = options;
      options.tokenizer = lexer.tokenizer;
      lexer.tokenizer.options = options;
      lexer.tokens = [] as unknown as TokensList;
      lexer.tokens.links = Object.create(null);
      const state = lexer.state;
      state.inLink = false;
      state.inRawBlock = false;
      state.linkEmitted = false;
      state.linkParenPossible = true;
      state.top = true;
      state.inBlockquote = false;
      state.lastToken = undefined;
      lexer.inlineQueue.length = 0;
    } else {
      lexer = new _Lexer(options);
      knownLexers[mode] = lexer as unknown as _Lexer<unknown, unknown>;
    }
    lexer.#runningKnown = true;
    try {
      return blockMode ? lexer.lex(src) : lexer.inlineTokens(src);
    } finally {
      lexer.#runningKnown = false;
    }
  }

  /**
   * Preprocessing
   */
  /** @hot */
  lex(src: string) {
    if (src.indexOf('\r') !== -1) src = src.replace(other.carriageReturn, '\n');

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

  /** @internal */
  /** @hot */
  blockKind(token: Token | undefined): number {
    return this.#kind(token);
  }

  /** @internal */
  /** @hot */
  canResumeContainer(): boolean {
    return this.#defaultKinds && !this.options.pedantic && this.#replaced === 0;
  }

  /** @hot */
  #kind(token: Token | undefined): number {
    if (!token) return 0;
    return (this.#defaultKinds ? token.kind : undefined) ?? tokenKind(token);
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

    let offset = 0;
    let previousOffset = -1;
    let lastParagraph: Token | undefined;
    const mergeAdjacentParagraphs = this.options.gfm && !this.options.pedantic
      && !(this.#replaced & tokenizerFlags.paragraph);
    while (offset < src.length) {
      if (offset > previousOffset) {
        previousOffset = offset;
      } else {
        this.infiniteLoopError(src.charCodeAt(offset));
        break;
      }

      this.state.lastToken = tokens.at(-1);
      let token: Tokens.Generic | undefined;

      const extensions = this.#extensions?.block;
      if (extensions?.length && (token = callExtensions(extensions, this, src, offset, tokens))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      const firstCode = src.charCodeAt(offset);
      let marker = firstCode;
      let indent = 0;
      while (marker === 32 && indent < 4) {
        marker = src.charCodeAt(offset + ++indent);
      }

      // newline
      if ((firstCode === 10 || firstCode === 32 || firstCode === 9
        || (this.#replaced & tokenizerFlags.space))
        && (token = this.#slots.spaceAt(src, offset))) {
        offset += token.raw.length;
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
        || (this.#replaced & tokenizerFlags.code))
        && (token = this.#slots.codeAt(src, offset))) {
        offset += token.raw.length;
        const lastToken = tokens.at(-1) as Tokens.Paragraph | Tokens.Text | undefined;
        // An indented code block cannot interrupt a paragraph.
        const kind = this.#kind(lastToken);
        if (lastToken && (kind === TokenKind.Paragraph || kind === TokenKind.Text)) {
          appendText(lastToken, token.raw, token.text, true);
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // fences
      if ((marker === 96 || marker === 126
        || (this.#replaced & tokenizerFlags.fences))
        && (token = this.#slots.fencesAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // heading
      if ((marker === 35
        || (this.#replaced & tokenizerFlags.heading))
        && (token = this.#slots.headingAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // hr
      if ((marker === 42 || marker === 45 || marker === 95
        || (this.#replaced & tokenizerFlags.hr))
        && (token = this.#slots.hrAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // blockquote
      if ((marker === 62
        || (this.#replaced & tokenizerFlags.blockquote))
        && (token = this.#slots.blockquoteAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // list
      if ((marker === 42 || marker === 43 || marker === 45 || (marker >= 48 && marker <= 57)
        || (this.#replaced & tokenizerFlags.list))
        && (token = this.#slots.listAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // html
      if ((marker === 60 || (indent === 4 && this.options.pedantic)
        || (this.#replaced & tokenizerFlags.html))
        && (token = this.#slots.htmlAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // def
      if ((marker === 91 || (indent === 4 && this.options.pedantic)
        || (this.#replaced & tokenizerFlags.def))
        && (token = this.#slots.defAt(src, offset))) {
        offset += token.raw.length;
        const lastToken = tokens.at(-1) as Tokens.Paragraph | Tokens.Text | undefined;
        const kind = this.#kind(lastToken);
        if (lastToken && (kind === TokenKind.Paragraph || kind === TokenKind.Text)) {
          appendText(lastToken, token.raw, token.raw, true);
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
      if (((this.options.gfm && !this.options.pedantic)
        || (this.#replaced & tokenizerFlags.table))
        && (token = this.#slots.tableAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // lheading
      if (token = this.#slots.lheadingAt(src, offset)) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // top-level paragraph
      // prevent paragraph consuming extensions by clipping 'src' to extension start
      const startExtensions = this.#extensions?.startBlock;
      const cutSrc = startExtensions?.length ? clipForExtensions(startExtensions, this, src, offset) : src;
      if (this.state.top && (token = this.#slots.paragraphAt(cutSrc, offset))) {
        const lastToken = tokens.at(-1) as Tokens.Paragraph | undefined;
        // A table-shaped header rejected by the table tokenizer is still
        // paragraph continuation, not a new block. Keep custom paragraph
        // tokenizers' choice to emit separate paragraphs unchanged.
        if ((lastParagraphClipped || (lastToken === lastParagraph && mergeAdjacentParagraphs)) && lastToken && this.#kind(lastToken) === TokenKind.Paragraph) {
          appendText(lastToken, token.raw, token.text, true);
          this.inlineQueue.pop();
          this.inlineQueue.at(-1)!.src = lastToken.text;
          lastParagraph = lastToken;
        } else {
          tokens.push(token);
          lastParagraph = token;
        }
        lastParagraphClipped = cutSrc.length !== src.length;
        offset += token.raw.length;
        continue;
      }

      // text
      if (token = this.#slots.textAt(src, offset)) {
        offset += token.raw.length;
        const lastToken = tokens.at(-1) as Tokens.Text | undefined;
        if (lastToken && this.#kind(lastToken) === TokenKind.Text) {
          appendText(lastToken, token.raw, token.text, true);
          this.inlineQueue.pop();
          this.inlineQueue.at(-1)!.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (offset < src.length) {
        this.infiniteLoopError(src.charCodeAt(offset));
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

    const { link, blockSkip, reflinkSearch } = this.tokenizer.rules.inline;
    let match: RegExpExecArray | null;
    const previousBlockIndex = blockSkip.lastIndex;
    blockSkip.lastIndex = 0;
    try {
      while ((match = blockSkip.exec(text))) {
        // The match omits the leading exclamation mark of an image.
        if (text.charCodeAt(match.index - 1) !== 33 && link.test(match[0])) return true;
      }
    } finally {
      blockSkip.lastIndex = previousBlockIndex;
    }

    const previousRefIndex = reflinkSearch.lastIndex;
    reflinkSearch.lastIndex = 0;
    try {
      while ((match = reflinkSearch.exec(text))) {
        const match0 = match[0];
        const refStart = match0.lastIndexOf('[');
        if (match0.charCodeAt(0) === 33 || !Object.hasOwn(this.tokens.links, normalizeLabel(match0, refStart + 1, match0.length - 1))) {
          continue;
        }
        if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) continue;
        return true;
      }
    } finally {
      reflinkSearch.lastIndex = previousRefIndex;
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
    const hasDelimiter = src.includes('*') || src.includes('_') || src.includes('~');
    if (!hasDelimiter && !this.#userDelimiters) return this.#tokenizeInlines(src, src, tokens, undefined);
    const hints = this.#closers;
    const { star, underscore, tilde } = hints;
    const depth = this.#runDepth++;
    const runs = this.#runTables[depth] ??= {
      entries: new Int32Array(0), length: 0, gfm: false,
      mask: { codes: new Uint16Array(0), length: 0, changed: false },
    };
    try {
      const rules = this.tokenizer.rules;
      let userMask: string | undefined;
      if (this.#userMaskRules) {
        userMask = this.#applyUserMaskRules(src);
      } else {
        const mask = runs.mask;
        copyInlineCodes(mask, src);
        if (src.includes('[')) maskReferences(mask, src, 0, src.length, rules, this.tokens.links);
        if (src.includes('\\') || src.includes('`')) maskEscapes(mask, src);
        if (src.includes('[') || src.includes('`') || src.includes('<')) maskBlocks(mask, src, rules);
      }
      if (this.#userDelimiters || this.#userMaskRules) {
        const masked = this.#maskedForUser(src, runs, userMask);
        if (hasDelimiter) scanCloserHints(masked, hints, undefined);
        else hints.star = hints.underscore = hints.tilde = -1;
        return this.#tokenizeInlines(src, masked, tokens, undefined);
      }
      runs.gfm = !!this.options.gfm && !this.options.pedantic;
      scanInlineRuns(src, hints, runs);
      return this.#tokenizeInlines(src, src, tokens, runs);
    } finally {
      this.#runDepth = depth;
      hints.star = star;
      hints.underscore = underscore;
      hints.tilde = tilde;
    }
  }

  /** @hotIgnore User adapter: one masked string and one hook call per inline run. */
  #maskedForUser(src: string, runs: InlineRuns, masked: string | undefined): string {
    const mask = runs.mask;
    const input = masked ?? (mask.changed ? inlineMaskText(mask, 0, mask.length) : src);
    return this.#maskHook ? callMaskHook(this.#maskHook, this, input) : input;
  }

  /** @hot */
  #tokenizeInlines(src: string, maskedSrc: string, tokens: Token[], runs: InlineRuns | undefined): Token[] {
    const base = maskedSrc.length - src.length;
    let keepPrevChar = false;
    let prevChar = '';
    let offset = 0;
    let previousOffset = -1;
    while (offset < src.length) {
      if (offset > previousOffset) {
        previousOffset = offset;
      } else {
        this.infiniteLoopError(src.charCodeAt(offset));
        break;
      }

      if (!keepPrevChar) {
        prevChar = '';
      }
      keepPrevChar = false;

      let token: Tokens.Generic | undefined;

      // extensions
      const extensions = this.#extensions?.inline;
      if (extensions?.length && (token = callExtensions(extensions, this, src, offset, tokens))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      const firstCode = src.charCodeAt(offset);
      // escape
      if ((firstCode === 92
        || (this.#replaced & tokenizerFlags.escape))
        && (token = this.#slots.escapeAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // tag
      if ((firstCode === 60
        || (this.#replaced & tokenizerFlags.tag))
        && (token = this.#slots.tagAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // link
      if ((firstCode === 91 || firstCode === 33
        || (this.#replaced & tokenizerFlags.link))
        && (token = this.#slots.linkAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // reflink, nolink
      if ((firstCode === 91 || firstCode === 33
        || (this.#replaced & tokenizerFlags.reflink))
        && (token = this.#slots.reflinkAt(src, this.tokens.links, offset))) {
        offset += token.raw.length;
        const lastToken = tokens.at(-1) as Tokens.Text | undefined;
        if (lastToken && this.#kind(token) === TokenKind.Text && this.#kind(lastToken) === TokenKind.Text) {
          appendText(lastToken, token.raw, token.text, false);
        } else {
          tokens.push(token);
        }
        continue;
      }

      // #4099 follow-up: for a run of `*` or `_` with no possible closer
      // anywhere ahead in maskedSrc, every opener position fails identically
      // and the outer loop walks the run char-by-char, giving O(n^2) time.
      // Consume the whole run as literal text in one step.
      if (firstCode === 42 || firstCode === 95 || firstCode === 126) {
        const pos = base + offset;
        const lastCloser = firstCode === 42
          ? this.#closers.star
          : firstCode === 95 ? this.#closers.underscore : this.#closers.tilde;
        if (lastCloser <= pos) {
          let runEnd = offset + 1;
          while (runEnd < src.length && src.charCodeAt(runEnd) === firstCode) runEnd++;
          const raw = sourceText(src, offset, runEnd);
          const lastToken = tokens.at(-1) as Tokens.Text | undefined;
          if (lastToken && this.#kind(lastToken) === TokenKind.Text && !lastToken.escaped) {
            appendText(lastToken, raw, raw, false);
          } else {
            tokens.push(createText(raw, raw, false) as Tokens.Text);
          }
          offset = runEnd;
          prevChar = raw[0];
          keepPrevChar = true;
          continue;
        }
      }

      // em & strong
      if ((firstCode === 42 || firstCode === 95
        || (this.#replaced & tokenizerFlags.emStrong))
        && (token = this.#slots.emStrongAt(src, maskedSrc, prevChar, offset, firstCode === 42 ? this.#closers.star : this.#closers.underscore, runs, base))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // code
      if ((firstCode === 96
        || (this.#replaced & tokenizerFlags.codespan))
        && (token = this.#slots.codespanAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // br
      if ((firstCode === 32 || firstCode === 92 || firstCode === 10
        || (this.#replaced & tokenizerFlags.br))
        && (token = this.#slots.brAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // del (gfm)
      if ((firstCode === 126
        || (this.#replaced & tokenizerFlags.del))
        && (token = this.#slots.delAt(src, maskedSrc, prevChar, offset, this.#closers.tilde, runs, base))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // autolink
      if ((firstCode === 60
        || (this.#replaced & tokenizerFlags.autolink))
        && (token = this.#slots.autolinkAt(src, offset))) {
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
          || (this.#replaced & tokenizerFlags.url))
        && (token = this.#slots.urlAt(src, offset))) {
        offset += token.raw.length;
        tokens.push(token);
        continue;
      }

      // text
      // prevent inlineText consuming extensions by clipping 'src' to extension start
      const startExtensions = this.#extensions?.startInline;
      const cutSrc = startExtensions?.length ? clipForExtensions(startExtensions, this, src, offset) : src;
      if (token = this.#slots.inlineTextAt(cutSrc, offset)) {
        offset += token.raw.length;
        const last = token.raw.length - 1;
        if (token.raw.charCodeAt(last) !== 95) { // Keep the character before underscores.
          prevChar = token.raw.charAt(last);
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1) as Tokens.Text | undefined;
        if (lastToken && this.#kind(lastToken) === TokenKind.Text) {
          appendText(lastToken, token.raw, token.text, false);
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (offset < src.length) {
        this.infiniteLoopError(src.charCodeAt(offset));
        break;
      }
    }

    return tokens;
  }

  /** @hotIgnore User adapter: up to three full-length mask strings for replaced inline rules. */
  #applyUserMaskRules(src: string): string {
    // String with links masked to avoid interference with em and strong
    let maskedSrc = src;

    // Mask out reflinks
    if (this.tokens.links && src.includes('[')) {
      const reflinkSearch = this.tokenizer.rules.inline.reflinkSearch;
      const maskReflink = (match0: string): string => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0, refStart + 1, match0.length - 1))) {
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
    if (maskedSrc.includes('\\') || maskedSrc.includes('`')) {
      maskedSrc = maskedSrc.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, maskCodeAndEscapes);
    }

    const { blockSkip, tag, autolink } = this.tokenizer.rules.inline;
    const cursor = this.tokenizer.rules.cursor?.inline;
    const ranges: number[] = [];
    let match: RegExpExecArray | null;
    blockSkip.lastIndex = 0;
    while ((match = blockSkip.exec(maskedSrc))) {
      const start = match.index + (match[2] ? match[2].length : 0);
      let end = match.index + match[0].length;
      if (maskedSrc.charCodeAt(start) === 60) {
        const html = execAt(tag, maskedSrc, start, cursor?.tag) || execAt(autolink, maskedSrc, start, cursor?.autolink);
        if (!html) {
          blockSkip.lastIndex = start + 1;
          continue;
        }
        end = start + html[0].length;
        blockSkip.lastIndex = end;
      }
      ranges.push(start, end);
    }
    return ranges.length ? materializeUserBlockMask(maskedSrc, ranges) : maskedSrc;
  }

  /** @hotIgnore Output: one message and at most one Error per stalled lex. */
  private infiniteLoopError(byte: number) {
    const errMsg = 'Infinite loop on byte: ' + byte;
    if (this.options.silent) {
      console.error(errMsg);
    } else {
      throw new Error(errMsg);
    }
  }
}

/** @hotIgnore Output: at most two appends to each of the token's raw and text fields. */
function appendText(token: Tokens.Text | Tokens.Paragraph, raw: string, text: string, newLine: boolean): void {
  if (newLine) {
    if (token.raw.charCodeAt(token.raw.length - 1) !== 10) token.raw += '\n';
    token.text += '\n';
  }
  token.raw += raw;
  token.text += text;
}

function materializeUserBlockMask(src: string, ranges: number[]): string {
  let masked = '';
  let last = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const start = ranges[i];
    const end = ranges[i + 1];
    masked += src.slice(last, start) + '[' + 'a'.repeat(end - start - 2) + ']';
    last = end;
  }
  ranges.length = 0;
  return masked + src.slice(last);
}

function maskCodeAndEscapes(match: string, ticks: string | undefined, punctuation: string | undefined): string {
  if (punctuation) return '+'.repeat(match.length);
  if (ticks) return ticks + match.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
  return match;
}
