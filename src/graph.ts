// Turns parsed rounds into a stitch graph: one node per stitch, springs
// between neighbouring stitches in a round and between a stitch and the
// stitch(es) it was worked into.

import type { Message, Round, StitchKind, StitchOp } from './parser';

export interface GNode {
  id: number;
  round: number; // 0 = magic ring centre, 1.. = rounds
  kind: StitchKind | 'center';
  parents: number[];
  /** Position within its round. */
  pos: number;
}

export interface GEdge {
  a: number;
  b: number;
  rest: number;
  stiffness: number;
  kind: 'row' | 'col' | 'shear' | 'ring' | 'bend';
}

export interface RoundInfo {
  index: number;
  label: string;
  source: string;
  start: number;
  count: number;
  expectedCount?: number;
}

export interface StitchGraph {
  nodes: GNode[];
  edges: GEdge[];
  rounds: RoundInfo[];
  messages: Message[];
}

/** Stitch dimensions relative to a single crochet width of 1. */
export const DIMS: Record<StitchKind | 'center', { w: number; h: number }> = {
  center: { w: 1, h: 0 },
  ch: { w: 1, h: 0.4 },
  // Row spacing is chosen so the canonical flat circle (6 increases per round)
  // lies flat: 6 * w / (2 * pi) is about 0.95.
  sc: { w: 1, h: 0.95 },
  hdc: { w: 1.05, h: 1.4 },
  dc: { w: 1.1, h: 2.0 },
  tr: { w: 1.15, h: 2.7 },
};

const K_ROW = 1.0;
const K_COL = 1.0;
const K_SHEAR = 0.35;
const K_RING = 0.6;
const K_BEND = 0.15;

/** Radius of a ring of `count` stitches of width `w`, so that neighbouring
 *  stitches are a chord of length w apart. */
export function ringRadius(count: number, w: number): number {
  if (count < 3) return Math.max(0.3, (count * w) / (2 * Math.PI));
  return w / (2 * Math.sin(Math.PI / count));
}

/** Straight-line distance between a point on a ring of radius rp and a point
 *  on the next ring of radius rc, separated by angle dTheta, when the rings
 *  are a slant distance h apart along the fabric. */
function ringDistance(rp: number, rc: number, dTheta: number, h: number): number {
  const dy = ringStep(rp, rc, h);
  return Math.sqrt(Math.max(0, rp * rp + rc * rc - 2 * rp * rc * Math.cos(dTheta) + dy * dy));
}

/** Axial distance between two consecutive rings a slant distance h apart.
 *  Zero when the radius changes faster than the stitch height allows, which
 *  is the fabric ruffling. */
export function ringStep(rp: number, rc: number, h: number): number {
  const dr = rc - rp;
  return Math.sqrt(Math.max(0, h * h - dr * dr));
}

export interface GraphOptions {
  /** Add a centre node closing the final round, as if the hole were sewn shut.
   *  Defaults to true when the last round has 8 stitches or fewer. */
  closeEnd?: boolean;
}

/** Whether a pattern's last round is small enough to count as a closed pole. */
export function endsClosed(rounds: RoundInfo[]): boolean {
  const last = rounds[rounds.length - 1];
  return !!last && last.count > 0 && last.count <= 8;
}

export function buildGraph(rounds: Round[], options: GraphOptions = {}): StitchGraph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const info: RoundInfo[] = [];
  const messages: Message[] = [];
  const edgeSet = new Set<string>();

  const addEdge = (a: number, b: number, rest: number, stiffness: number, kind: GEdge['kind']) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ a, b, rest, stiffness, kind });
  };

  let prev: number[] = [];
  let center: number | undefined;
  // Per-round ring radius and axial step, and per-node angular offset from
  // its first parent, used for rest lengths that span two rounds.
  const ringR: number[] = [];
  const ringDy: number[] = [];
  const thetaOff: number[] = [];

  rounds.forEach((round, ri) => {
    const rIndex = ri + 1;
    const cur: number[] = [];
    const start = nodes.length;

    const newNode = (kind: StitchKind, parents: number[]): number => {
      const id = nodes.length;
      nodes.push({ id, round: rIndex, kind, parents, pos: cur.length });
      cur.push(id);
      return id;
    };

    if (round.chain) {
      for (let i = 0; i < round.chain; i++) newNode('ch', []);
    } else {
      // Expand ops, then any "repeat around" group, then fill.
      const ops: StitchOp[] = [...round.ops];
      const grp = (round as Round & { repeatGroup?: StitchOp[] }).repeatGroup;
      let consumed = 0;
      const consumes = (op: StitchOp) => (op.into === 'next' ? 1 : typeof op.into === 'number' ? op.into : 0);
      for (const op of ops) consumed += consumes(op);
      if (grp && grp.length) {
        const gc = grp.reduce((s, op) => s + consumes(op), 0);
        if (gc > 0) {
          const reps = Math.floor(Math.max(0, prev.length - consumed) / gc);
          for (let r = 0; r < reps; r++) ops.push(...grp);
          consumed += reps * gc;
        }
      }
      if (round.fill) {
        for (let i = consumed; i < prev.length; i++) ops.push({ kind: round.fill, into: 'next' });
      }

      let p = 0;
      let overflow = false;
      for (const op of ops) {
        let parents: number[];
        if (op.into === 'ring') {
          if (center === undefined) {
            center = nodes.length;
            nodes.push({ id: center, round: 0, kind: 'center', parents: [], pos: 0 });
          }
          parents = [center];
        } else if (op.into === 'same') {
          if (cur.length === 0 || p === 0) {
            messages.push({ level: 'error', line: 0, text: `${round.label}: increase has no stitch to work into` });
            parents = prev.length ? [prev[Math.min(p, prev.length - 1)]] : [];
          } else {
            parents = [prev[p - 1]];
          }
        } else {
          const n = op.into === 'next' ? 1 : op.into;
          if (p + n > prev.length) { overflow = true; break; }
          parents = prev.slice(p, p + n);
          p += n;
        }
        newNode(op.kind, parents);
      }
      if (overflow) {
        messages.push({
          level: 'error', line: 0,
          text: `${round.label}: needs more stitches than the previous round has (${prev.length}); extra stitches dropped`,
        });
      } else if (!round.chain && prev.length && p < prev.length) {
        messages.push({ level: 'warn', line: 0, text: `${round.label}: leaves ${prev.length - p} stitch(es) of the previous round unworked` });
      }
    }

    // Edges within the round (row springs), closed into a ring.
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % cur.length];
      if (cur.length < 2) break;
      if (cur.length === 2 && i === 1) break;
      const w = (DIMS[nodes[a].kind].w + DIMS[nodes[b].kind].w) / 2;
      addEdge(a, b, w, K_ROW, 'row');
    }

    // Where each stitch sits horizontally relative to the previous round, in
    // stitch units. Increase stitches fan out either side of their shared
    // parent; a decrease sits midway between its parents.
    const siblings = new Map<number, number[]>();
    for (const id of cur) {
      const par = nodes[id].parents;
      if (par.length === 1 && nodes[par[0]].kind !== 'center') {
        let list = siblings.get(par[0]);
        if (!list) { list = []; siblings.set(par[0], list); }
        list.push(id);
      }
    }
    const localX = (id: number): number => {
      const par = nodes[id].parents;
      const first = nodes[par[0]];
      if (par.length === 1) {
        const sib = siblings.get(par[0])!;
        return first.pos + (sib.indexOf(id) - (sib.length - 1) / 2);
      }
      return first.pos + (par.length - 1) / 2;
    };
    // Row tension spreads the local crowding of increases and decreases over
    // neighbouring stitches, so smooth the spacing between consecutive
    // stitches (in parent units) before turning it into rest lengths.
    const xs = new Map<number, number>();
    const regular = cur.filter((id) => nodes[id].parents.length > 0 && nodes[nodes[id].parents[0]].kind !== 'center');
    if (regular.length > 2 && regular.length === cur.length) {
      const m = cur.length;
      const raw = cur.map(localX);
      let spacing = raw.map((x, i) => {
        let d = raw[(i + 1) % m] - x;
        if (i === m - 1) d += prev.length; // wrap around the ring
        return d;
      });
      for (let pass = 0; pass < 2; pass++) {
        spacing = spacing.map((_, i) => {
          let s = 0;
          for (let k = -2; k <= 2; k++) s += spacing[(i + k + m) % m];
          return s / 5;
        });
      }
      // Rebuild positions, anchored so they deviate least from the local model.
      const rebuilt: number[] = [raw[0]];
      for (let i = 1; i < m; i++) rebuilt.push(rebuilt[i - 1] + spacing[i - 1]);
      const shift = rebuilt.reduce((s, x, i) => s + (raw[i] - x), 0) / m;
      cur.forEach((id, i) => xs.set(id, rebuilt[i] + shift));
    } else {
      for (const id of regular) xs.set(id, localX(id));
    }
    const xOf = (id: number): number => xs.get(id)!;

    // Edges to parents (column springs) and shear springs to the parents' neighbours.
    // Rest lengths come from the local ring geometry: the previous round is a
    // ring sized by its stitch count, this round is a ring sized by its own,
    // and the two are a stitch height apart along the fabric.
    const curW = cur.length ? DIMS[nodes[cur[0]].kind].w : 1;
    const rc = ringRadius(cur.length, curW);
    const rp = prev.length ? ringRadius(prev.length, DIMS[nodes[prev[0]].kind].w) : 0;
    const dThetaPerParent = prev.length ? (2 * Math.PI) / prev.length : 0;
    ringR[rIndex] = rc;
    ringDy[rIndex] = cur.length ? ringStep(rp, rc, DIMS[nodes[cur[0]].kind].h) : 0;
    for (const id of cur) {
      const n = nodes[id];
      const h = DIMS[n.kind].h;
      thetaOff[id] = 0;
      // Bending: weak springs across two stitches so the fabric resists crumpling.
      if (cur.length > 4) {
        const nb2 = cur[(n.pos + 2) % cur.length];
        addEdge(id, nb2, 2 * rc * Math.sin((2 * Math.PI) / cur.length), K_BEND, 'bend');
      }
      if (n.parents.length === 0) continue;
      if (nodes[n.parents[0]].kind === 'center') {
        addEdge(id, n.parents[0], rc, K_RING, 'ring');
        continue;
      }
      const x = xOf(id);
      thetaOff[id] = (x - nodes[n.parents[0]].pos) * dThetaPerParent;
      for (const par of n.parents) {
        addEdge(id, par, ringDistance(rp, rc, Math.abs(x - nodes[par].pos) * dThetaPerParent, h), K_COL, 'col');
      }
      if (prev.length > 2) {
        const firstPos = nodes[n.parents[0]].pos;
        const lastPos = firstPos + n.parents.length - 1;
        const before = prev[(firstPos - 1 + prev.length) % prev.length];
        const after = prev[(lastPos + 1) % prev.length];
        addEdge(id, before, ringDistance(rp, rc, Math.abs(x - (firstPos - 1)) * dThetaPerParent, h), K_SHEAR, 'shear');
        addEdge(id, after, ringDistance(rp, rc, Math.abs(x - (lastPos + 1)) * dThetaPerParent, h), K_SHEAR, 'shear');
      }
      const par = n.parents[0];
      const gp = nodes[par].parents[0];
      if (gp !== undefined && nodes[gp].kind !== 'center') {
        const rgp = ringR[nodes[gp].round];
        const dth = thetaOff[id] + thetaOff[par];
        const dy = ringDy[rIndex] + ringDy[nodes[par].round];
        addEdge(id, gp, Math.sqrt(Math.max(0, rgp * rgp + rc * rc - 2 * rgp * rc * Math.cos(dth) + dy * dy)), K_BEND, 'bend');
      }
    }

    info.push({
      index: rIndex,
      label: round.label,
      source: round.source,
      start,
      count: cur.length,
      expectedCount: round.expectedCount,
    });
    if (round.expectedCount !== undefined && round.expectedCount !== cur.length) {
      messages.push({ level: 'warn', line: 0, text: `${round.label}: pattern says ${round.expectedCount} stitches but this works out to ${cur.length}` });
    }
    prev = cur;
  });

  // Close the final hole with a centre node, like sewing it shut.
  const close = options.closeEnd ?? endsClosed(info);
  if (close && prev.length >= 3) {
    const id = nodes.length;
    nodes.push({ id, round: info.length + 1, kind: 'center', parents: [...prev], pos: 0 });
    const r = ringRadius(prev.length, DIMS[nodes[prev[0]].kind].w);
    for (const p of prev) addEdge(id, p, r, K_RING, 'ring');
  }

  return { nodes, edges, rounds: info, messages };
}
