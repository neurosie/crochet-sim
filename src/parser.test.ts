import { describe, expect, it } from 'vitest';
import { parsePattern, roundStitchCount } from './parser';
import { buildGraph } from './graph';
import { Simulation } from './sim';

function counts(text: string): number[] {
  const { rounds } = parsePattern(text);
  const out: number[] = [];
  let prev = 0;
  for (const r of rounds) { const c = roundStitchCount(r, prev); out.push(c); prev = c; }
  return out;
}

describe('parsePattern', () => {
  it('parses a classic sphere', () => {
    expect(counts(`R1: 6 sc in MR
R2: inc x6
R3: (sc, inc) x6
R4: (2 sc, inc) x6
R5-7: sc around
R8: (2 sc, dec) x6
R9: (sc, dec) x6
R10: dec x6`)).toEqual([6, 12, 18, 24, 24, 24, 24, 18, 12, 6]);
  });

  it('accepts alternative spellings', () => {
    expect(counts(`Rnd 1: MR 6
Rnd 2: 2 sc in each st around
Rnd 3: *sc in next st, 2 sc in next st* rep 6 times
Rnd 4: [sc in next 2 st, inc] x 6 (24)
Rnd 5: sc in each st around
Rnd 6: sc2tog x12
Rnd 7: *dec* repeat 6 times`)).toEqual([6, 12, 18, 24, 24, 12, 6]);
  });

  it('handles chain starts and other stitch heights', () => {
    expect(counts(`ch 12
R2-4: sc around
R5: dc inc x12
R6: hdc around`)).toEqual([12, 12, 12, 12, 24, 24]);
  });

  it('handles "repeat around" groups', () => {
    expect(counts(`R1: 8 sc in MR
R2: (sc, inc) rep around`)).toEqual([8, 12]);
  });

  it('reports stitch count mismatches', () => {
    const parsed = parsePattern(`R1: 6 sc in MR\nR2: inc x6 (13)`);
    const g = buildGraph(parsed.rounds);
    expect(g.messages.some((m) => m.text.includes('pattern says 13'))).toBe(true);
  });

  it('errors when a round consumes too many stitches', () => {
    const parsed = parsePattern(`R1: 6 sc in MR\nR2: sc x7`);
    const g = buildGraph(parsed.rounds);
    expect(g.messages.some((m) => m.level === 'error')).toBe(true);
    expect(g.rounds[1].count).toBe(6);
  });

  it('strips comments and blank lines', () => {
    expect(counts(`// head\nR1: 6 sc in MR # start\n\nR2: inc x6`)).toEqual([6, 12]);
  });
});

describe('buildGraph', () => {
  it('links stitches to parents and neighbours', () => {
    const g = buildGraph(parsePattern(`R1: 6 sc in MR\nR2: inc x6`).rounds);
    const stitches = g.nodes.filter((n) => n.kind !== 'center');
    expect(stitches.length).toBe(18);
    const r2 = g.nodes.filter((n) => n.round === 2);
    // Each pair of increase stitches shares a parent.
    expect(r2[0].parents).toEqual(r2[1].parents);
    expect(r2[2].parents).not.toEqual(r2[1].parents);
    expect(g.edges.filter((e) => e.kind === 'row').length).toBe(18);
    expect(g.edges.filter((e) => e.kind === 'col').length).toBe(12);
    expect(g.edges.filter((e) => e.kind === 'ring').length).toBe(6);
  });

  it('decrease stitches have two parents', () => {
    const g = buildGraph(parsePattern(`R1: 6 sc in MR\nR2: dec x3`).rounds);
    const r2 = g.nodes.filter((n) => n.round === 2);
    expect(r2.length).toBe(3);
    expect(r2.every((n) => n.parents.length === 2)).toBe(true);
  });

  it('keeps rest lengths short when a pattern increases faster than it can lie flat', () => {
    // Doubling every round makes hyperbolic fabric. A stitch is still only a
    // stitch long, however far apart the rounds' nominal ring radii are: the
    // surplus has to show up as ruffling, not as stretched springs.
    const g = buildGraph(parsePattern(`R1: 6 sc in MR\nR2: inc x6\nR3: inc x12\nR4: inc x24\nR5: inc x48`).rounds);
    const cross = g.edges.filter((e) => e.kind === 'col' || e.kind === 'shear');
    expect(cross.length).toBeGreaterThan(0);
    // A shear spring spans at most a couple of stitches; nothing should need more.
    expect(Math.max(...cross.map((e) => e.rest))).toBeLessThan(2.5);
    expect(Math.max(...g.edges.map((e) => e.rest))).toBeLessThan(3);
  });
});

describe('Simulation', () => {
  const SPHERE = `R1: 6 sc in MR\nR2: inc x6\nR3: (sc, inc) x6\nR4: (2 sc, inc) x6\nR5-8: sc around\nR9: (2 sc, dec) x6\nR10: (sc, dec) x6\nR11: dec x6`;
  const RUFFLE = `R1: 6 sc in MR\nR2: inc x6\nR3: inc x12\nR4: inc x24\nR5: inc x48`;

  const settle = (pattern: string, pressure: number) => {
    const sim = new Simulation(buildGraph(parsePattern(pattern).rounds), { pressure });
    for (let i = 0; i < 2000; i++) sim.step();
    return sim;
  };

  it('tells a shape that holds air from one that does not', () => {
    expect(settle(SPHERE, 0.6).enclosure()).toBeGreaterThan(0.7);
    expect(settle(RUFFLE, 0.6).enclosure()).toBeLessThan(0.2);
  });

  it('comes to rest when a shape with no inside is stuffed', () => {
    // Stuffing a ruffle used to drive it around for ever, because pressure on
    // an open surface has a large net force and nothing to push against.
    const loose = settle(RUFFLE, 0);
    const stuffed = settle(RUFFLE, 1.8);
    expect(stuffed.stuffable).toBeLessThan(0.05);
    expect(stuffed.energy).toBeLessThan(Math.max(1e-5, loose.energy * 50));
  });

  it('still rounds out a closed shape', () => {
    const loose = settle(SPHERE, 0);
    const stuffed = settle(SPHERE, 0.6);
    expect(stuffed.stuffable).toBe(1);
    expect(stuffed.enclosure()).toBeGreaterThan(loose.enclosure());
    expect(stuffed.enclosure()).toBeGreaterThan(0.95);
    expect(stuffed.energy).toBeLessThan(1e-6);
  });
});
