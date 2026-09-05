// Three.js view of the simulation: stitches as small spheres, springs as lines.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DIMS, type StitchGraph } from './graph';
import type { Simulation } from './sim';

const KIND_COLORS: Record<string, number> = {
  center: 0xffffff,
  ch: 0x999999,
  sc: 0xf4a261,
  hdc: 0x2a9d8f,
  dc: 0x8ecae6,
  tr: 0xc77dff,
};

export class Renderer {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private nodeMesh?: THREE.InstancedMesh;
  private lines?: THREE.LineSegments;
  private sim?: Simulation;
  private edgeIdx?: Int32Array;
  /** Per stitch: the two nodes whose difference points along the stitch, and
   *  how much to stretch the marker along it. */
  private axisFrom?: Int32Array;
  private axisTo?: Int32Array;
  private scales?: Float32Array;
  private dummy = new THREE.Object3D();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly dir = new THREE.Vector3();
  colorMode: 'kind' | 'round' = 'round';

  constructor(private container: HTMLElement) {
    this.scene.background = new THREE.Color(0x1a1a1f);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(0, 6, 22);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);

    // The view's own box changes without the window doing so — the address bar
    // sliding away on a phone, or the panel reflowing beside it — so watch the
    // container rather than the window.
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setSimulation(sim: Simulation) {
    this.sim = sim;
    const g: StitchGraph = sim.graph;
    if (this.nodeMesh) { this.scene.remove(this.nodeMesh); this.nodeMesh.geometry.dispose(); }
    if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); }

    const geo = new THREE.SphereGeometry(0.28, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 });
    this.nodeMesh = new THREE.InstancedMesh(geo, mat, g.nodes.length);
    const color = new THREE.Color();
    const nRounds = Math.max(1, g.rounds.length);
    g.nodes.forEach((nd, i) => {
      if (this.colorMode === 'kind' || nd.kind === 'center') color.setHex(KIND_COLORS[nd.kind] ?? 0xffffff);
      else color.setHSL((nd.round / nRounds) * 0.85, 0.65, 0.55);
      this.nodeMesh!.setColorAt(i, color);
    });
    this.scene.add(this.nodeMesh);

    // A stitch stands on the one it was worked into, so that is the direction
    // it is tall in. Round 1 has only the magic ring below it, which is a
    // point rather than a stitch, so those look upward to their own children
    // instead.
    const firstChild = new Int32Array(g.nodes.length).fill(-1);
    for (const nd of g.nodes) {
      const p = nd.parents[0];
      if (p !== undefined && firstChild[p] === -1) firstChild[p] = nd.id;
    }
    this.axisFrom = new Int32Array(g.nodes.length).fill(-1);
    this.axisTo = new Int32Array(g.nodes.length).fill(-1);
    this.scales = new Float32Array(g.nodes.length * 3);
    const sc = DIMS.sc;
    g.nodes.forEach((nd, i) => {
      const p = nd.parents[0];
      if (p !== undefined && g.nodes[p].kind !== 'center') { this.axisFrom![i] = p; this.axisTo![i] = i; }
      else if (firstChild[i] >= 0) { this.axisFrom![i] = i; this.axisTo![i] = firstChild[i]; }
      const d = DIMS[nd.kind];
      // A single crochet is the unit, so it stays the round bead it always was.
      const long = nd.kind === 'center' ? 1 : d.h / sc.h;
      const wide = nd.kind === 'center' ? 1 : d.w / sc.w;
      this.scales![i * 3] = wide; this.scales![i * 3 + 1] = long; this.scales![i * 3 + 2] = wide;
    });

    // Only draw the springs that correspond to yarn; shear and bend springs clutter the view.
    const drawn = g.edges.filter((e) => e.kind === 'row' || e.kind === 'col' || e.kind === 'ring');
    this.edgeIdx = new Int32Array(drawn.length * 2);
    drawn.forEach((e, i) => { this.edgeIdx![i * 2] = e.a; this.edgeIdx![i * 2 + 1] = e.b; });
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(drawn.length * 6), 3));
    this.lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.55 }));
    this.scene.add(this.lines);

    this.frame();
    this.update();
  }

  /** Move the camera so the whole piece is visible. */
  frame() {
    if (!this.sim) return;
    const r = Math.max(3, this.sim.extent() * 1.4);
    // The field of view is the vertical one, so on a view taller than it is
    // wide — a phone held upright — it is the width that has to fit.
    const halfV = (this.camera.fov * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    const dist = r / Math.tan(Math.min(halfV, halfH));
    this.camera.position.set(0, dist * 0.35, dist);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  update() {
    if (!this.sim || !this.nodeMesh || !this.lines || !this.edgeIdx) return;
    const p = this.sim.pos;
    const { axisFrom, axisTo, scales, dir, up, dummy } = this;
    for (let i = 0; i < this.sim.n; i++) {
      dummy.position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      dummy.quaternion.identity();
      if (axisFrom && axisTo && axisFrom[i] >= 0) {
        const a = axisFrom[i] * 3, b = axisTo[i] * 3;
        dir.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        if (dir.lengthSq() > 1e-12) dummy.quaternion.setFromUnitVectors(up, dir.normalize());
      }
      if (scales) dummy.scale.set(scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2]);
      dummy.updateMatrix();
      this.nodeMesh.setMatrixAt(i, dummy.matrix);
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < this.edgeIdx.length; i++) {
      const id = this.edgeIdx[i] * 3;
      arr[i * 3] = p[id]; arr[i * 3 + 1] = p[id + 1]; arr[i * 3 + 2] = p[id + 2];
    }
    attr.needsUpdate = true;
    this.lines.geometry.computeBoundingSphere();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
