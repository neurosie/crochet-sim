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

/** Solve a symmetric 3x3 system by Cramer's rule. Degenerate arrangements —
 *  a handful of stitches all in a line — give no solution and no correction. */
function solve3(m: Float64Array, bx: number, by: number, bz: number): [number, number, number] {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!(Math.abs(det) > 1e-9)) return [0, 0, 0];
  const dx =
    bx * (m[4] * m[8] - m[5] * m[7]) - m[1] * (by * m[8] - m[5] * bz) + m[2] * (by * m[7] - m[4] * bz);
  const dy =
    m[0] * (by * m[8] - m[5] * bz) - bx * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * bz - by * m[6]);
  const dz =
    m[0] * (m[4] * bz - by * m[7]) - m[1] * (m[3] * bz - by * m[6]) + bx * (m[3] * m[7] - m[4] * m[6]);
  return [dx / det, dy / det, dz / det];
}

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
  /** Area of the patch of fabric each stitch stands for. */
  private readonly areas: Float32Array;
  params: SimParams;
  private grid = new Map<number, number[]>();
  private readonly inertia = new Float64Array(9);
  /** Running measure of how much the system is still moving. */
  energy = 1;
  /** Smoothed `enclosure()`, so the stuffing cannot chatter; -1 until measured. */
  private held = -1;
  /** Fraction of the stuffing the shape can take: 1 for a closed body, 0 for
   *  fabric with no inside to hold any. Only meaningful once stuffed. */
  stuffable = 1;

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
    this.areas = new Float32Array(this.n);
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

  /** Apply the stuffing's outward push, with the net force and net spin taken
   *  back out. Stuffing inside a shape cannot shove or spin the shape as a
   *  whole: on a closed surface the outward pushes cancel on their own, but an
   *  open one — a bowl, or a ruffle with no inside at all — is left with a
   *  large residue that drives the whole model around instead of shaping it. */
  private addPressure(pressure: number) {
    const { pos, force, normals, n } = this;
    let fx = 0, fy = 0, fz = 0;
    let tx = 0, ty = 0, tz = 0;
    for (let i = 0; i < n; i++) {
      const px = normals[i * 3] * pressure, py = normals[i * 3 + 1] * pressure, pz = normals[i * 3 + 2] * pressure;
      fx += px; fy += py; fz += pz;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      tx += y * pz - z * py; ty += z * px - x * pz; tz += x * py - y * px;
    }
    fx /= n; fy /= n; fz /= n;

    // Angular acceleration the residual torque would give the whole model,
    // from its inertia tensor about the centroid (positions are recentred).
    const m = this.inertia.fill(0);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const r2 = x * x + y * y + z * z;
      m[0] += r2 - x * x; m[1] -= x * y; m[2] -= x * z;
      m[3] -= y * x; m[4] += r2 - y * y; m[5] -= y * z;
      m[6] -= z * x; m[7] -= z * y; m[8] += r2 - z * z;
    }
    const [ax, ay, az] = solve3(m, tx, ty, tz);

    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      force[i * 3] += normals[i * 3] * pressure - fx - (ay * z - az * y);
      force[i * 3 + 1] += normals[i * 3 + 1] * pressure - fy - (az * x - ax * z);
      force[i * 3 + 2] += normals[i * 3 + 2] * pressure - fz - (ax * y - ay * x);
    }
  }

  /** Estimate a unit normal per stitch from its row and column neighbours,
   *  oriented consistently outward (away from the centroid on average), and
   *  record the patch of fabric each one stands for. */
  private computeNormals() {
    const { pos, normals, areas, n } = this;
    let orient = 0;
    for (let i = 0; i < n; i++) {
      const rp = this.rowPrev[i], rn = this.rowNext[i];
      let cp = this.colPrev[i], cn = this.colNext[i];
      areas[i] = 0;
      if (rp < 0 || rn < 0 || (cp < 0 && cn < 0)) { normals[i * 3] = normals[i * 3 + 1] = normals[i * 3 + 2] = 0; continue; }
      // Each difference spans two stitches where both neighbours exist and one
      // at the first and last rounds, so the patch is the cross product scaled
      // by however far the two differences actually reach.
      const span = (cp < 0 || cn < 0) ? 2 : 4;
      if (cp < 0) cp = i;
      if (cn < 0) cn = i;
      const tx = pos[rn * 3] - pos[rp * 3], ty = pos[rn * 3 + 1] - pos[rp * 3 + 1], tz = pos[rn * 3 + 2] - pos[rp * 3 + 2];
      const ux = pos[cn * 3] - pos[cp * 3], uy = pos[cn * 3 + 1] - pos[cp * 3 + 1], uz = pos[cn * 3 + 2] - pos[cp * 3 + 2];
      let nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9;
      areas[i] = len / span;
      nx /= len; ny /= len; nz /= len;
      normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
      orient += nx * pos[i * 3] + ny * pos[i * 3 + 1] + nz * pos[i * 3 + 2];
    }
    if (orient < 0) for (let i = 0; i < n * 3; i++) normals[i] = -normals[i];
  }

  /** How much of a closed body the fabric currently makes, from 0 for a shape
   *  with no inside to 1 for a sphere: the volume the surface encloses against
   *  the most any surface of that area could enclose. Stuffing works on the
   *  air a shape holds, so a piece that holds none cannot be stuffed. */
  enclosure(): number {
    const { pos, normals, areas, n } = this;
    this.computeNormals();
    let volume = 0;
    let area = 0;
    for (let i = 0; i < n; i++) {
      volume += (pos[i * 3] * normals[i * 3] + pos[i * 3 + 1] * normals[i * 3 + 1] + pos[i * 3 + 2] * normals[i * 3 + 2]) * areas[i];
      area += areas[i];
    }
    volume /= 3;
    if (area <= 0) return 0;
    const sphere = Math.pow(area, 1.5) / (6 * Math.sqrt(Math.PI));
    return Math.max(0, Math.min(1, volume / sphere));
  }

  step() {
    const { pos, vel, force, n } = this;
    const { dt, damping, springK, repelK, repelRadius, pressure } = this.params;
    force.fill(0);

    // Stuffing: push each stitch outward along the surface normal, as hard as
    // the shape has an inside to hold it.
    if (pressure > 0) {
      // Also refreshes the normals the push itself follows.
      const held = this.enclosure();
      this.held = this.held < 0 ? held : this.held + 0.02 * (held - this.held);
      const t = Math.max(0, Math.min(1, (this.held - 0.05) / 0.15));
      this.stuffable = t * t * (3 - 2 * t);
      if (this.stuffable > 0) this.addPressure(pressure * this.stuffable);
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
