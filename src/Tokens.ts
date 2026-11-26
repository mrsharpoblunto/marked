/* eslint-disable no-use-before-define */

export type MarkedToken = (
  Tokens.Blockquote
  | Tokens.Br
  | Tokens.Checkbox
  | Tokens.Code
  | Tokens.Codespan
  | Tokens.Def
  | Tokens.Del
  | Tokens.Em
  | Tokens.Escape
  | Tokens.Heading
  | Tokens.Hr
  | Tokens.HTML
  | Tokens.Image
  | Tokens.Link
  | Tokens.List
  | Tokens.ListItem
  | Tokens.Paragraph
  | Tokens.Space
  | Tokens.Strong
  | Tokens.Table
  | Tokens.Tag
  | Tokens.Text
);

export type Token = (
  MarkedToken
  | Tokens.Generic);

interface KindedToken {
  kind?: number;
}

export namespace Tokens {
  export interface Blockquote extends KindedToken {
    type: 'blockquote';
    raw: string;
    text: string;
    tokens: Token[];
  }

  export interface Br extends KindedToken {
    type: 'br';
    raw: string;
  }

  export interface Checkbox extends KindedToken {
    type: 'checkbox';
    raw: string;
    checked: boolean;
  }

  export interface Code extends KindedToken {
    type: 'code';
    raw: string;
    codeBlockStyle?: 'indented';
    lang?: string;
    text: string;
    escaped?: boolean;
  }

  export interface Codespan extends KindedToken {
    type: 'codespan';
    raw: string;
    text: string;
  }

  export interface Def extends KindedToken {
    type: 'def';
    raw: string;
    tag: string;
    href: string;
    title: string;
  }

  export interface Del extends KindedToken {
    type: 'del';
    raw: string;
    text: string;
    tokens: Token[];
  }

  export interface Em extends KindedToken {
    type: 'em';
    raw: string;
    text: string;
    tokens: Token[];
  }

  export interface Escape extends KindedToken {
    type: 'escape';
    raw: string;
    text: string;
  }

  export interface Generic {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [index: string]: any;
    type: string;
    raw: string;
    tokens?: Token[];
  }

  export interface Heading extends KindedToken {
    type: 'heading';
    raw: string;
    depth: number;
    text: string;
    tokens: Token[];
  }

  export interface Hr extends KindedToken {
    type: 'hr';
    raw: string;
  }

  export interface HTML extends KindedToken {
    type: 'html';
    raw: string;
    pre: boolean;
    text: string;
    block: boolean;
  }

  export interface Image extends KindedToken {
    type: 'image';
    raw: string;
    href: string;
    title: string | null;
    text: string;
    tokens: Token[];
  }

  export interface Link extends KindedToken {
    type: 'link';
    raw: string;
    href: string;
    title?: string | null;
    text: string;
    tokens: Token[];
    /**
     * Set for autolinks and extended (GFM) urls, where character references are
     * not resolved, so the destination and text are literal.
     */
    autolink?: boolean;
  }

  export interface List extends KindedToken {
    type: 'list';
    raw: string;
    ordered: boolean;
    start: number | '';
    loose: boolean;
    items: ListItem[];
  }

  export interface ListItem extends KindedToken {
    type: 'list_item';
    raw: string;
    task: boolean;
    checked?: boolean;
    loose: boolean;
    text: string;
    tokens: Token[];
  }

  export interface Paragraph extends KindedToken {
    type: 'paragraph';
    raw: string;
    pre?: boolean;
    text: string;
    tokens: Token[];
  }

  export interface Space extends KindedToken {
    type: 'space';
    raw: string;
  }

  export interface Strong extends KindedToken {
    type: 'strong';
    raw: string;
    text: string;
    tokens: Token[];
  }

  export interface Table extends KindedToken {
    type: 'table';
    raw: string;
    align: Array<'center' | 'left' | 'right' | null>;
    header: TableCell[];
    rows: TableCell[][];
  }

  export interface TableCell {
    text: string;
    tokens: Token[];
    header: boolean;
    align: 'center' | 'left' | 'right' | null;
  }

  export interface TableRow<P = string> {
    text: P;
  }

  export interface Tag extends KindedToken {
    type: 'html';
    raw: string;
    inLink: boolean;
    inRawBlock: boolean;
    text: string;
    block: boolean;
  }

  export interface Text extends KindedToken {
    type: 'text';
    raw: string;
    text: string;
    tokens?: Token[];
    escaped?: boolean;
  }
}

export type Links = Record<string, Pick<Tokens.Link | Tokens.Image, 'href' | 'title'>>;

export type TokensList = Token[] & {
  links: Links;
};
