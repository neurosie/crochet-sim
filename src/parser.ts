// Parses amigurumi-style crochet notation into per-round stitch operations.
//
// Supported forms (case-insensitive):
//   R1: 6 sc in MR            R2: inc x6           R3: (sc, inc) x6
//   R4: *2 sc, inc* rep 6     R5-8: sc around      R9: [sc, dec] x6 (12)
//   ch 12                     2 dc in next st      sc in next 3 st
//   sc2tog / dec              hdc inc / dc dec     sl st (ignored)

export type StitchKind = 'sc' | 'hdc' | 'dc' | 'tr' | 'ch';

export interface StitchOp {
  kind: StitchKind;
  /** 'next' works into the next unworked stitch, 'same' into the same stitch as
   *  the previous op (an increase), 'ring' into the magic ring, and a number
   *  N > 1 means the op is worked across the next N stitches (a decrease). */
  into: 'next' | 'same' | 'ring' | number;
}

export interface Round {
  /** 1-based round number as it will be worked. */
  index: number;
  label: string;
  source: string;
  ops: StitchOp[];
  /** If set, after the explicit ops, work this stitch into every remaining stitch. */
  fill?: StitchKind;
  /** Stitch count the pattern author annotated, e.g. the "(18)" at the end. */
  expectedCount?: number;
  /** A chain start: `ch N` creates N foundation stitches worked in a ring. */
  chain?: number;
}

export interface Message {
  level: 'error' | 'warn';
  line: number;
  text: string;
}

export interface ParsedPattern {
  rounds: Round[];
  messages: Message[];
}

const STITCHES: Record<string, StitchKind> = {
  sc: 'sc', hdc: 'hdc', dc: 'dc', tr: 'tr', ch: 'ch',
  'single': 'sc', 'half': 'hdc', 'double': 'dc', 'treble': 'tr',
};

type Token =
  | { t: 'num'; v: number }
  | { t: 'word'; v: string }
  | { t: 'punct'; v: string };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const re = /(\d+)|([a-z]+)|([()\[\]*,+=\-])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) out.push({ t: 'num', v: parseInt(m[1], 10) });
    else if (m[2]) out.push({ t: 'word', v: m[2].toLowerCase() });
    else out.push({ t: 'punct', v: m[3] });
  }
  return out;
}

class RoundParser {
  private i = 0;
  fill?: StitchKind;
  chain?: number;
  expectedCount?: number;
  warnings: string[] = [];

  constructor(private toks: Token[]) {}

  private peek(o = 0): Token | undefined { return this.toks[this.i + o]; }
  private next(): Token | undefined { return this.toks[this.i++]; }
  private isWord(w: string, o = 0): boolean { const t = this.peek(o); return !!t && t.t === 'word' && t.v === w; }
  private isPunct(p: string, o = 0): boolean { const t = this.peek(o); return !!t && t.t === 'punct' && t.v === p; }
  private isNum(o = 0): boolean { const t = this.peek(o); return !!t && t.t === 'num'; }
  private numAt(o = 0): number { return (this.peek(o) as { v: number }).v; }
  private done(): boolean { return this.i >= this.toks.length; }

  parse(): StitchOp[] {
    const ops = this.sequence();
    if (!this.done()) {
      this.warnings.push(`unexpected "${this.describe(this.peek()!)}"`);
    }
    return ops;
  }

  private describe(t: Token): string { return String(t.v); }

  /** A comma-separated list of items, stopping at a closing bracket or asterisk. */
  private sequence(closer?: string): StitchOp[] {
    const ops: StitchOp[] = [];
    for (;;) {
      while (this.isPunct(',') || this.isPunct('+') || this.isWord('and') || this.isWord('then')) this.next();
      if (this.done()) break;
      if (closer && this.isPunct(closer)) break;
      const before = this.i;
      const item = this.item();
      if (item) ops.push(...item);
      if (this.i === before) {
        // Nothing consumed: skip the token so we always make progress.
        this.warnings.push(`ignored "${this.describe(this.next()!)}"`);
      }
    }
    return ops;
  }

  /** Optional repeat suffix: "x6", "x 6", "6 times", "rep 6", "repeat 6 times", "*6" */
  private repeatSuffix(): number {
    if (this.isWord('x') && this.isNum(1)) { this.next(); return (this.next() as { v: number }).v; }
    if (this.isPunct('*') && this.isNum(1)) { this.next(); return (this.next() as { v: number }).v; }
    if ((this.isWord('rep') || this.isWord('repeat')) ) {
      this.next();
      if (this.isWord('x')) this.next();
      if (this.isNum()) {
        const n = (this.next() as { v: number }).v;
        if (this.isWord('times') || this.isWord('time')) this.next();
        return n;
      }
      if (this.isWord('around')) { this.next(); return -1; }
      return 1;
    }
    if (this.isNum() && (this.isWord('times', 1) || this.isWord('time', 1))) {
      const n = (this.next() as { v: number }).v; this.next(); return n;
    }
    // "x6" glued: tokenizer splits "x6" into word x + num 6 already.
    return 1;
  }

  private item(): StitchOp[] | null {
    // Grouped repeat: ( ... ) xN, [ ... ] xN, * ... * rep N
    if (this.isPunct('(') || this.isPunct('[')) {
      const open = (this.next() as { v: string }).v;
      const close = open === '(' ? ')' : ']';
      // Bare "(18)" at the end is a stitch-count annotation.
      if (this.isNum() && this.isPunct(close, 1)) {
        this.expectedCount = this.numAt(); this.next(); this.next();
        return [];
      }
      const inner = this.sequence(close);
      if (this.isPunct(close)) this.next(); else this.warnings.push(`missing "${close}"`);
      return this.repeated(inner);
    }
    if (this.isPunct('*')) {
      this.next();
      const inner = this.sequence('*');
      if (this.isPunct('*')) this.next();
      // "* ... * rep 6" or "repeat from * 5 more times"
      if (this.isWord('repeat') && this.isWord('from', 1)) { this.next(); this.next(); if (this.isPunct('*')) this.next(); }
      return this.repeated(inner, true);
    }
    // "= 18" stitch count annotation
    if (this.isPunct('=') && this.isNum(1)) { this.next(); this.expectedCount = (this.next() as { v: number }).v; return []; }
    // Bare trailing number is also treated as a count annotation.
    if (this.isNum() && this.i === this.toks.length - 1) { this.expectedCount = (this.next() as { v: number }).v; return []; }

    // Leading count: "2 sc", "6 sc in MR", "3 dc in next st"
    let count: number | undefined;
    if (this.isNum()) { count = (this.next() as { v: number }).v; }

    const t = this.peek();
    if (!t || t.t !== 'word') {
      if (count !== undefined) { this.i--; return null; }
      return null;
    }
    const w = t.v;

    // Words we ignore entirely.
    if (['join', 'turn', 'fo', 'fasten', 'off', 'blo', 'flo', 'st', 'sts', 'stitch', 'stitches', 'each', 'the', 'st', 'sp', 'with', 'to', 'in', 'of', 'next', 'more', 'do', 'not', 'don', 'continue', 'cont', 'stuff', 'stuffing', 'firmly', 'lightly', 'now', 'end'].includes(w)) {
      this.next(); return [];
    }
    if (w === 'sl' || w === 'slst' || w === 'ss' || w === 'slip') {
      this.next(); if (this.isWord('st')) this.next(); if (this.isWord('to')) this.next(); if (this.isWord('join')) this.next();
      return [];
    }
    if (w === 'mr' || w === 'magic' || w === 'ring' || w === 'circle' || w === 'loop') {
      // "MR 6" / "magic ring, 6 sc"
      this.next(); if (this.isWord('ring') || this.isWord('circle') || this.isWord('loop')) this.next();
      if (count === undefined && this.isNum() && (this.isWord('sc', 1) || this.isWord('hdc', 1) || this.isWord('dc', 1))) {
        return null; // let the following "6 sc" item parse and get its 'in MR' from context
      }
      if (count !== undefined || this.isNum()) {
        const n = count ?? (this.next() as { v: number }).v;
        return Array.from({ length: n }, () => ({ kind: 'sc' as StitchKind, into: 'ring' as const }));
      }
      return [];
    }
    if (w === 'ch' || w === 'chain') {
      this.next();
      const n = count ?? (this.isNum() ? (this.next() as { v: number }).v : 1);
      if (this.chain === undefined && n > 1) { this.chain = n; return []; }
      return []; // turning chains etc. are ignored
    }
    if (w === 'around') { this.next(); this.fill = 'sc'; return []; }

    // Stitch prefix for inc/dec: "dc inc", "hdc dec"
    let kind: StitchKind | undefined = STITCHES[w];
    let word = w;
    if (kind) {
      this.next();
      // "single crochet" / "double crochet"
      if (this.isWord('crochet')) this.next();
      if (this.isWord('inc') || this.isWord('increase') || this.isWord('dec') || this.isWord('decrease') || this.isWord('tog')) {
        word = (this.peek() as { v: string }).v; // consumed by the inc/dec branch below
      } else if (this.isNum() && this.isWord('tog', 1)) {
        // sc2tog
        const n = (this.next() as { v: number }).v; this.next();
        return this.repeatOps([{ kind, into: n }], count ?? this.repeatSuffix());
      } else {
        word = kind;
      }
    }
    // ch is only a foundation chain in this parser.
    if (kind === 'ch') return [];

    if (word === 'inc' || word === 'increase') {
      this.next();
      kind ??= 'sc';
      const k = kind;
      const ops: StitchOp[] = [{ kind: k, into: 'next' }, { kind: k, into: 'same' }];
      this.skipInto();
      return this.repeatOps(ops, count ?? this.repeatSuffix());
    }
    if (word === 'dec' || word === 'decrease' || word === 'tog' || word === 'invdec' || word === 'inv') {
      this.next();
      if (word === 'inv' && this.isWord('dec')) this.next();
      kind ??= 'sc';
      this.skipInto();
      return this.repeatOps([{ kind, into: 2 }], count ?? this.repeatSuffix());
    }
    if (word === 'sctog' || word === 'sc2tog') { this.next(); return this.repeatOps([{ kind: 'sc', into: 2 }], count ?? this.repeatSuffix()); }

    if (kind) {
      // Plain stitch, possibly "in next N st", "in same st", "in MR", "around", "in each st around"
      const k = kind;
      let into: StitchOp['into'] = 'next';
      let n = count ?? 1;
      let multiIntoOne = false;
      let across: number | undefined;
      if (this.isWord('in') || this.isWord('into')) {
        this.next();
        if (this.isWord('the')) this.next();
        if (this.isWord('mr') || this.isWord('magic') || this.isWord('ring') || this.isWord('loop') || this.isWord('circle')) {
          while (this.isWord('mr') || this.isWord('magic') || this.isWord('ring') || this.isWord('loop') || this.isWord('circle')) this.next();
          into = 'ring';
        } else if (this.isWord('same')) {
          this.next(); this.skipStWords(); into = 'same';
        } else if (this.isWord('each')) {
          this.next(); this.skipStWords(); if (this.isWord('around')) this.next();
          if (n > 1) {
            // "2 sc in each st around": an increase in every stitch
            const grp: StitchOp[] = [{ kind: k, into: 'next' }];
            for (let j = 1; j < n; j++) grp.push({ kind: k, into: 'same' });
            this.repeatAroundGroup = grp;
          } else {
            this.fill = k;
          }
          return [];
        } else if (this.isWord('next')) {
          this.next();
          if (this.isNum()) { across = (this.next() as { v: number }).v; }
          this.skipStWords();
          if (across !== undefined && count === undefined) { n = across; across = undefined; }
          else if (across !== undefined && count !== undefined) {
            // "2 sc in next 2 st" = 2 sc in each of next 2 → 4 stitches worked in pairs
            multiIntoOne = true;
          } else if (count !== undefined && count > 1) {
            multiIntoOne = true;
          }
        } else {
          this.skipStWords();
        }
      } else if (this.isWord('around')) {
        this.next(); this.fill = k; return [];
      } else if (this.isWord('together') || this.isWord('tog')) {
        this.next(); return this.repeatOps([{ kind: k, into: n }], this.repeatSuffix());
      }
      if (this.isWord('around')) { this.next(); this.fill = k; }

      let ops: StitchOp[];
      if (multiIntoOne) {
        // count stitches into one stitch, repeated across `across` stitches
        const grp: StitchOp[] = [{ kind: k, into: 'next' }];
        for (let j = 1; j < (count ?? 1); j++) grp.push({ kind: k, into: 'same' });
        ops = this.repeatOps(grp, across ?? 1);
      } else if (into === 'same') {
        ops = Array.from({ length: n }, () => ({ kind: k, into: 'same' as const }));
      } else if (into === 'ring') {
        ops = Array.from({ length: n }, () => ({ kind: k, into: 'ring' as const }));
      } else {
        ops = Array.from({ length: n }, () => ({ kind: k, into: 'next' as const }));
      }
      return this.repeatOps(ops, this.repeatSuffix());
    }

    // Unknown word
    if (count !== undefined) this.i--; // put the count back for the caller's warning
    return null;
  }

  private skipStWords() {
    while (this.isWord('st') || this.isWord('sts') || this.isWord('stitch') || this.isWord('stitches') || this.isWord('sc') && this.isWord('st', 1)) this.next();
  }

  private skipInto() {
    if (this.isWord('in') || this.isWord('into')) {
      this.next();
      while (this.isWord('next') || this.isWord('the') || this.isWord('same') || this.isNum() || this.isWord('st') || this.isWord('sts') || this.isWord('stitch') || this.isWord('stitches')) this.next();
    }
  }

  private repeated(inner: StitchOp[], star = false): StitchOp[] {
    let n = this.repeatSuffix();
    if (star && n === 1 && this.isNum()) {
      // "* ... * 5 more times" → total 6
      n = (this.next() as { v: number }).v;
      if (this.isWord('more')) { this.next(); n += 1; }
      if (this.isWord('times') || this.isWord('time')) this.next();
    }
    if (n === -1) { // "rep around": repeat until the round is used up — approximate as fill
      this.fill = inner[0]?.kind ?? 'sc';
      this.repeatAroundGroup = inner;
      return [];
    }
    return this.repeatOps(inner, n);
  }

  /** Group to repeat until the previous round is consumed ("rep around"). */
  repeatAroundGroup?: StitchOp[];

  private repeatOps(ops: StitchOp[], n: number): StitchOp[] {
    if (n === -1) { this.repeatAroundGroup = ops; this.fill = ops[0]?.kind ?? 'sc'; return []; }
    const out: StitchOp[] = [];
    for (let j = 0; j < n; j++) out.push(...ops);
    return out;
  }
}

const LABEL_RE = /^\s*(?:r(?:nd|ound|ow)?s?\.?)\s*(\d+)\s*(?:(?:-|–|to|through)\s*(\d+))?\s*[:.)\-]?\s*/i;

export function parsePattern(text: string): ParsedPattern {
  const messages: Message[] = [];
  const rounds: Round[] = [];
  const lines = text.split(/\r?\n/);
  let nextIndex = 1;

  lines.forEach((raw, li) => {
    const lineNo = li + 1;
    const line = raw.replace(/(\/\/|#).*$/, '').trim();
    if (!line) return;

    let body = line;
    let label = '';
    let from = nextIndex;
    let to = nextIndex;
    const lm = LABEL_RE.exec(line);
    if (lm) {
      from = parseInt(lm[1], 10);
      to = lm[2] ? parseInt(lm[2], 10) : from;
      body = line.slice(lm[0].length);
      label = lm[0].trim().replace(/[:.]$/, '');
      if (from !== nextIndex) {
        messages.push({ level: 'warn', line: lineNo, text: `round numbering jumps to ${from} (expected ${nextIndex})` });
      }
      if (to < from) { messages.push({ level: 'error', line: lineNo, text: `bad round range ${from}-${to}` }); to = from; }
    }
    if (!body.trim()) return;

    const toks = tokenize(body);
    const p = new RoundParser(toks);
    const ops = p.parse();
    for (const w of p.warnings) messages.push({ level: 'warn', line: lineNo, text: w });

    // Implicit magic ring: round 1 written as "6 sc" with no "in MR" is treated as a ring start.
    if (rounds.length === 0 && p.chain === undefined) {
      for (const op of ops) if (op.into === 'next') op.into = 'ring';
      if (ops.length === 0 && p.fill) {
        messages.push({ level: 'error', line: lineNo, text: 'first round needs a stitch count, e.g. "6 sc in MR" or "ch 12"' });
      }
    } else {
      if (ops.some((o) => o.into === 'ring')) {
        messages.push({ level: 'error', line: lineNo, text: 'magic ring stitches are only allowed in the first round' });
      }
    }
    if (p.chain !== undefined && rounds.length > 0) {
      messages.push({ level: 'warn', line: lineNo, text: 'a foundation chain after round 1 is treated as a plain stitch' });
      p.chain = undefined;
    }
    if (ops.length === 0 && !p.fill && p.chain === undefined && !p.repeatAroundGroup) {
      messages.push({ level: 'warn', line: lineNo, text: `no stitches recognised in "${body.trim()}"` });
      return;
    }

    for (let r = from; r <= to; r++) {
      rounds.push({
        index: rounds.length + 1,
        label: label ? (from === to ? label : `R${r}`) : `R${rounds.length + 1}`,
        source: body.trim(),
        ops: ops.map((o) => ({ ...o })),
        fill: p.fill,
        expectedCount: p.expectedCount,
        chain: p.chain,
        ...(p.repeatAroundGroup ? { repeatGroup: p.repeatAroundGroup } : {}),
      } as Round);
    }
    nextIndex = to + 1;
  });

  return { rounds, messages };
}

/** Number of stitches a round produces, given the previous round's count. */
export function roundStitchCount(round: Round, prevCount: number): number {
  if (round.chain) return round.chain;
  let consumed = 0;
  let produced = 0;
  for (const op of round.ops) {
    produced++;
    if (op.into === 'next') consumed++;
    else if (typeof op.into === 'number') consumed += op.into;
  }
  const grp = (round as Round & { repeatGroup?: StitchOp[] }).repeatGroup;
  if (grp && grp.length) {
    let gc = 0;
    for (const op of grp) { if (op.into === 'next') gc++; else if (typeof op.into === 'number') gc += op.into; }
    if (gc > 0) {
      const reps = Math.floor(Math.max(0, prevCount - consumed) / gc);
      produced += reps * grp.length;
      consumed += reps * gc;
    }
  }
  if (round.fill) produced += Math.max(0, prevCount - consumed);
  return produced;
}
