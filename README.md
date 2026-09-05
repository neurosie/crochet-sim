# Crochet Sim

Simulates and visualises crochet patterns worked in the round (amigurumi).
Paste a pattern, and the shape it produces emerges from the stitches alone.

```
npm install
npm run dev      # http://localhost:5173
npm test         # parser and graph tests
npm run build    # typecheck + production bundle in dist/
```

## How it works

1. `src/parser.ts` turns pattern text into per-round stitch operations.
   One round per line; labels like `R1:`, `Rnd 3:`, `R5-8:` are optional.
   Understands `sc hdc dc tr`, `inc`, `dec` / `sc2tog`, `(…) x6`, `*…* rep 6`,
   `sc around`, `2 sc in each st around`, `N sc in MR`, `ch N`, and trailing
   stitch counts like `(18)` which are checked against the expansion.
2. `src/graph.ts` builds a graph: one node per stitch, springs to the stitches
   either side in the round and to the stitch(es) it was worked into, plus
   weaker shear and bending springs. Rest lengths come from stitch dimensions
   and local ring geometry, so increases and decreases create curvature. A
   round can only lean out by one stitch height, so a pattern that increases
   faster than that (doubling every round, say) makes surplus fabric that
   ruffles rather than springs that stretch.
3. `src/sim.ts` relaxes the graph in 3D: springs, short-range repulsion so the
   fabric has thickness, and optional outward pressure along the surface
   normal to model stuffing. Stuffing pushes on the air the piece holds, so it
   scales with how much of a closed body the fabric makes and does nothing at
   all to something with no inside, like a flat circle or a ruffle.
4. `src/render.ts` draws it with Three.js. Drag to orbit, scroll to zoom; on a
   touch screen, one finger orbits and two pinch and pan. "Recenter" puts the
   whole piece back in view.

On a narrow screen the shape takes the top of the window and stays there while
the pattern and the round table scroll underneath it.

Units: a single crochet is 1 wide and 0.95 tall. Other stitches scale from that.
