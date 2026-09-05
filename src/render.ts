// Three.js view of the simulation: stitches as small spheres, springs as lines.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { StitchGraph } from './graph';
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
  private dummy = new THREE.Object3D();
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

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
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
    const dist = r / Math.tan((this.camera.fov * Math.PI) / 360);
    this.camera.position.set(0, dist * 0.35, dist);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  update() {
    if (!this.sim || !this.nodeMesh || !this.lines || !this.edgeIdx) return;
    const p = this.sim.pos;
    for (let i = 0; i < this.sim.n; i++) {
      this.dummy.position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.dummy.updateMatrix();
      this.nodeMesh.setMatrixAt(i, this.dummy.matrix);
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
