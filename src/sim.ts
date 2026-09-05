// Spring-mass relaxation of the stitch graph in 3D.
//
// Each stitch is a point mass. Edges are springs with a rest length; nearby
// non-adjacent stitches repel so the fabric cannot pass through itself and
// has some thickness. The shape (sphere, cone, tube...) emerges from the
// pattern's increases and decreases alone.

import { DIMS, ringRadius, ringRise, ringStep, type StitchGraph } from './graph';

export interface SimParams {
  dt: number;
  damping: number;
  springK: number;
  repelK: number;
  repelRadius: number;
  stepsPerFrame: number;
  /** Outward force along the surface normal, i.e. stuffing. 0 = unstuffed. */
  pressure: number;
}

export const DEFAULT_PARAMS: SimParams = {
  dt: 0.08,
  damping: 0.9,
  springK: 8,
  repelK: 6,
  repelRadius: 1.1,
  stepsPerFrame: 4,
  pressure: 0,
};

export class Simulation {
  readonly n: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  private readonly force: Float32Array;
  private readonly ea: Int32Array;
  private readonly eb: Int32Array;
  private readonly rest: Float32Array;
  private readonly stiff: Float32Array;
  private readonly adjacent: Set<number>[];
  /** Neighbour indices used to estimate surface normals; -1 where none. */
  private readonly rowPrev: Int32Array;
  private readonly rowNext: Int32Array;
  private readonly colPrev: Int32Array;
  private readonly colNext: Int32Array;
  private readonly normals: Float32Array;
  params: SimParams;
  private grid = new Map<number, number[]>();
  /** Running measure of how much the system is still moving. */
  energy = 1;

  constructor(readonly graph: StitchGraph, params: Partial<SimParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.n = graph.nodes.length;
    this.pos = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.force = new Float32Array(this.n * 3);
    const m = graph.edges.length;
    this.ea = new Int32Array(m);
    this.eb = new Int32Array(m);
    this.rest = new Float32Array(m);
    this.stiff = new Float32Array(m);
    this.adjacent = Array.from({ length: this.n }, () => new Set<number>());
    graph.edges.forEach((e, i) => {
      this.ea[i] = e.a; this.eb[i] = e.b; this.rest[i] = e.rest; this.stiff[i] = e.stiffness;
      this.adjacent[e.a].add(e.b); this.adjacent[e.b].add(e.a);
    });

    this.rowPrev = new Int32Array(this.n).fill(-1);
    this.rowNext = new Int32Array(this.n).fill(-1);
    this.colPrev = new Int32Array(this.n).fill(-1);
    this.colNext = new Int32Array(this.n).fill(-1);
    this.normals = new Float32Array(this.n * 3);
    for (const r of graph.rounds) {
      if (r.count < 3) continue;
      for (let i = 0; i < r.count; i++) {
        this.rowPrev[r.start + i] = r.start + ((i - 1 + r.count) % r.count);
        this.rowNext[r.start + i] = r.start + ((i + 1) % r.count);
      }
    }
    for (const nd of graph.nodes) {
      if (nd.kind === 'center') continue;
      const p = nd.parents[0];
      if (p !== undefined) {
        this.colPrev[nd.id] = p;
        if (this.colNext[p] === -1) this.colNext[p] = nd.id;
      }
    }
    this.initialLayout();
  }

  /** Lay each round out as a circle whose circumference matches its stitch
   *  count, stepping up by however much height is left after the change in
   *  radius. This makes the start a surface of revolution close to the final
   *  shape: flat pieces start flat, tubes start as tubes, spheres as spheres.
   *
   *  A round can only lean out by one stitch height per round, so a pattern
   *  that increases faster than that gets a ring too small to hold its
   *  stitches. That surplus is what ruffles, and it is laid out as a wave
   *  deep enough to take up the extra length — a fold for the relaxation to
   *  grow, rather than a perfectly symmetric ring it would have to buckle. */
  private initialLayout() {
    const { nodes, rounds } = this.graph;
    let y = 0;
    let prevRadius = 0;
    const angleOf = new Float32Array(this.n);
    const lobes = this.ruffleLobes();
    for (const r of rounds) {
      const count = r.count;
      if (count === 0) continue;
      const first = nodes[r.start];
      const h = DIMS[first.kind].h;
      const w = DIMS[first.kind].w;
      const nominal = ringRadius(count, w);
      // The magic ring's centre is a point, not a ring, so the first round is
      // free to sit at whatever radius its stitch count asks for.
      const radius = prevRadius > 0 ? prevRadius + ringRise(prevRadius, nominal, h) : nominal;
      // Keep a small step so coincident rings do not start exactly on top of each other.
      y += Math.max(0.05 * h, ringStep(prevRadius, nominal, h));
      prevRadius = radius;
      // Extra arc length a wave of `lobes` folds must absorb to fit the round
      // on a ring this size: a sine of amplitude A stretches the circumference
      // by about (A * lobes)^2 / (4 * radius^2).
      const surplus = count * w / (2 * Math.PI * radius) - 1;
      const amp = surplus > 0 ? (2 * radius * Math.sqrt(surplus)) / lobes : 0;
      // Start the round at the angle of its first parent so stitches sit above their parents.
      let a0 = 0;
      const fp = first.parents[0];
      if (fp !== undefined && nodes[fp].kind !== 'center') a0 = angleOf[fp];
      for (let i = 0; i < count; i++) {
        const id = r.start + i;
        const a = a0 + (i / count) * Math.PI * 2;
        angleOf[id] = a;
        this.pos[id * 3] = Math.cos(a) * radius + (Math.random() - 0.5) * 0.05;
        this.pos[id * 3 + 1] = y + amp * Math.sin(lobes * a) + (Math.random() - 0.5) * 0.05;
        this.pos[id * 3 + 2] = Math.sin(a) * radius + (Math.random() - 0.5) * 0.05;
      }
    }
    // Magic ring centre sits below round 1; a closing centre sits above the last round.
    for (const nd of nodes) if (nd.kind === 'center') {
      const top = nd.parents.length > 0;
      this.pos[nd.id * 3] = 0; this.pos[nd.id * 3 + 1] = top ? y + 0.3 : 0.3; this.pos[nd.id * 3 + 2] = 0;
    }
    this.recenter();
  }

  /** How many folds to start a ruffled piece with. Fabric folds on a
   *  wavelength of roughly a dozen stitches, measured on the widest round
   *  that has more stitches than its ring can hold; a piece that ruffles
   *  nowhere never uses this. */
  private ruffleLobes(): number {
    const { nodes, rounds } = this.graph;
    let widest = 0;
    let prevRadius = 0;
    for (const r of rounds) {
      if (r.count === 0) continue;
      const { w, h } = DIMS[nodes[r.start].kind];
      const nominal = ringRadius(r.count, w);
      const radius = prevRadius > 0 ? prevRadius + ringRise(prevRadius, nominal, h) : nominal;
      if (radius < nominal) widest = Math.max(widest, r.count);
      prevRadius = radius;
    }
    return Math.min(16, Math.max(3, Math.round(widest / 12)));
  }

  /** Estimate a unit normal per stitch from its row and column neighbours,
   *  oriented consistently outward (away from the centroid on average). */
  private computeNormals() {
    const { pos, normals, n } = this;
    let orient = 0;
    for (let i = 0; i < n; i++) {
      const rp = this.rowPrev[i], rn = this.rowNext[i];
      let cp = this.colPrev[i], cn = this.colNext[i];
      if (rp < 0 || rn < 0 || (cp < 0 && cn < 0)) { normals[i * 3] = normals[i * 3 + 1] = normals[i * 3 + 2] = 0; continue; }
      if (cp < 0) cp = i;
      if (cn < 0) cn = i;
      const tx = pos[rn * 3] - pos[rp * 3], ty = pos[rn * 3 + 1] - pos[rp * 3 + 1], tz = pos[rn * 3 + 2] - pos[rp * 3 + 2];
      const ux = pos[cn * 3] - pos[cp * 3], uy = pos[cn * 3 + 1] - pos[cp * 3 + 1], uz = pos[cn * 3 + 2] - pos[cp * 3 + 2];
      let nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9;
      nx /= len; ny /= len; nz /= len;
      normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
      orient += nx * pos[i * 3] + ny * pos[i * 3 + 1] + nz * pos[i * 3 + 2];
    }
    if (orient < 0) for (let i = 0; i < n * 3; i++) normals[i] = -normals[i];
  }

  step() {
    const { pos, vel, force, n } = this;
    const { dt, damping, springK, repelK, repelRadius, pressure } = this.params;
    force.fill(0);

    // Stuffing: push each stitch outward along the surface normal.
    if (pressure > 0) {
      this.computeNormals();
      for (let i = 0; i < n * 3; i++) force[i] += pressure * this.normals[i];
    }

    // Springs
    for (let i = 0; i < this.ea.length; i++) {
      const a = this.ea[i] * 3, b = this.eb[i] * 3;
      const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
      const f = springK * this.stiff[i] * (len - this.rest[i]) / len;
      force[a] += f * dx; force[a + 1] += f * dy; force[a + 2] += f * dz;
      force[b] -= f * dx; force[b + 1] -= f * dy; force[b + 2] -= f * dz;
    }

    // Repulsion via a uniform grid
    const cell = repelRadius;
    const grid = this.grid;
    grid.clear();
    const key = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
    const cx = new Int32Array(n), cy = new Int32Array(n), cz = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      cx[i] = Math.floor(pos[i * 3] / cell); cy[i] = Math.floor(pos[i * 3 + 1] / cell); cz[i] = Math.floor(pos[i * 3 + 2] / cell);
      const k = key(cx[i], cy[i], cz[i]);
      let list = grid.get(k);
      if (!list) { list = []; grid.set(k, list); }
      list.push(i);
    }
    const r2 = repelRadius * repelRadius;
    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      const adj = this.adjacent[i];
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const list = grid.get(key(cx[i] + ox, cy[i] + oy, cz[i] + oz));
        if (!list) continue;
        for (const j of list) {
          if (j <= i || adj.has(j)) continue;
          const jx = j * 3;
          const dx = pos[jx] - pos[ix], dy = pos[jx + 1] - pos[ix + 1], dz = pos[jx + 2] - pos[ix + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r2 || d2 < 1e-9) continue;
          const d = Math.sqrt(d2);
          const f = repelK * (repelRadius - d) / d;
          force[ix] -= f * dx; force[ix + 1] -= f * dy; force[ix + 2] -= f * dz;
          force[jx] += f * dx; force[jx + 1] += f * dy; force[jx + 2] += f * dz;
        }
      }
    }

    // Integrate
    let e = 0;
    for (let i = 0; i < n * 3; i++) {
      vel[i] = (vel[i] + force[i] * dt) * damping;
      pos[i] += vel[i] * dt;
      e += vel[i] * vel[i];
    }
    this.energy = e / Math.max(1, n);
    this.recenter();
  }

  private recenter() {
    const { pos, n } = this;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) { sx += pos[i * 3]; sy += pos[i * 3 + 1]; sz += pos[i * 3 + 2]; }
    sx /= n; sy /= n; sz /= n;
    for (let i = 0; i < n; i++) { pos[i * 3] -= sx; pos[i * 3 + 1] -= sy; pos[i * 3 + 2] -= sz; }
  }

  /** Radius of the bounding sphere around the origin, for camera framing. */
  extent(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      m = Math.max(m, x * x + y * y + z * z);
    }
    return Math.sqrt(m);
  }
}
