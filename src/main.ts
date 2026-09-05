import { parsePattern, roundStitchCount, type Message } from './parser';
import { buildGraph, endsClosed } from './graph';
import { Simulation } from './sim';
import { Renderer } from './render';

const PRESETS: Record<string, string> = {
  'Sphere (ball)': `R1: 6 sc in MR
R2: inc x6 (12)
R3: (sc, inc) x6 (18)
R4: (2 sc, inc) x6 (24)
R5: (3 sc, inc) x6 (30)
R6-10: sc around (30)
R11: (3 sc, dec) x6 (24)
R12: (2 sc, dec) x6 (18)
R13: (sc, dec) x6 (12)
R14: dec x6 (6)`,
  'Egg': `R1: 6 sc in MR
R2: inc x6
R3: (sc, inc) x6
R4: (2 sc, inc) x6
R5: (3 sc, inc) x6
R6: (4 sc, inc) x6
R7-11: sc around
R12: (4 sc, dec) x6
R13: sc around
R14: (3 sc, dec) x6
R15: sc around
R16: (2 sc, dec) x6
R17: (sc, dec) x6
R18: dec x6`,
  'Cone': `R1: 6 sc in MR
R2: (sc, inc) x3
R3: (2 sc, inc) x3
R4: (3 sc, inc) x3
R5: (4 sc, inc) x3
R6: (5 sc, inc) x3
R7: (6 sc, inc) x3
R8: (7 sc, inc) x3
R9: (8 sc, inc) x3
R10: (9 sc, inc) x3`,
  'Flat circle': `R1: 6 sc in MR
R2: inc x6
R3: (sc, inc) x6
R4: (2 sc, inc) x6
R5: (3 sc, inc) x6
R6: (4 sc, inc) x6
R7: (5 sc, inc) x6
R8: (6 sc, inc) x6`,
  'Tube': `ch 16
R2-12: sc around`,
  'Bowl': `R1: 6 sc in MR
R2: inc x6
R3: (sc, inc) x6
R4: (2 sc, inc) x6
R5: (3 sc, inc) x6
R6: (4 sc, inc) x6
R7-12: sc around`,
  // Half the round in a taller stitch makes that side of the tube longer, so
  // the body curves away from it — about 95 degrees over eighteen rounds.
  // Shaping the curve with increases and decreases instead would work too,
  // but it drags the fabric around the tube a fraction of a stitch a round
  // and the stitch columns come out spiralling.
  'Banana': `R1: 6 sc in MR
R2: (sc, inc) x3 (9)
R3: (2 sc, inc) x3 (12)
R4-21: 6 hdc, 6 sc (12)
R22: (2 sc, dec) x3 (9)
R23: (sc, dec) x3 (6)
R24-26: sc around (6)`,
  'Ruffle (hyperbolic)': `R1: 6 sc in MR
R2: inc x6
R3: inc x12
R4: inc x24
R5: inc x48`,
  // Nine increases a round where six would lie flat: just enough surplus that
  // the waves build up a round at a time instead of crumpling all at once.
  'Frill (gentle ruffle)': `R1: 9 sc in MR
R2: inc x9 (18)
R3: (sc, inc) x9 (27)
R4: (2 sc, inc) x9 (36)
R5: (3 sc, inc) x9 (45)
R6: (4 sc, inc) x9 (54)
R7: (5 sc, inc) x9 (63)
R8: (6 sc, inc) x9 (72)
R9: (7 sc, inc) x9 (81)
R10: (8 sc, inc) x9 (90)
R11: (9 sc, inc) x9 (99)
R12: (10 sc, inc) x9 (108)`,
};

const patternEl = document.getElementById('pattern') as HTMLTextAreaElement;
const runBtn = document.getElementById('run') as HTMLButtonElement;
const toggleBtn = document.getElementById('toggle') as HTMLButtonElement;
const presetsEl = document.getElementById('presets') as HTMLSelectElement;
const messagesEl = document.getElementById('messages') as HTMLDivElement;
const roundsEl = document.getElementById('rounds') as HTMLTableElement;
const viewEl = document.getElementById('view') as HTMLElement;
const stuffingEl = document.getElementById('stuffing') as HTMLInputElement;
const stuffingValueEl = document.getElementById('stuffingValue') as HTMLSpanElement;
const stuffingNoteEl = document.getElementById('stuffingNote') as HTMLDivElement;

/** Base pressure applied when the slider reads 1. */
const PRESSURE_UNIT = 0.6;
let stuffingTouched = false;

function applyStuffing() {
  if (!sim) return;
  const v = parseFloat(stuffingEl.value);
  sim.params.pressure = v * PRESSURE_UNIT;
  showStuffing();
}

/** Stuffing pushes on the air a shape holds, so a piece with no inside — a
 *  flat circle, a ruffle — takes none however far the slider goes. Say so
 *  rather than leaving the slider looking broken. */
function showStuffing() {
  if (!sim) return;
  const v = parseFloat(stuffingEl.value);
  stuffingValueEl.textContent = v.toFixed(1);
  const note = v > 0 && sim.stuffable < 0.05 ? 'This shape has no inside to fill.' : '';
  if (stuffingNoteEl.textContent !== note) stuffingNoteEl.textContent = note;
}
stuffingEl.addEventListener('input', () => { stuffingTouched = true; applyStuffing(); });

for (const name of Object.keys(PRESETS)) {
  const opt = document.createElement('option');
  opt.value = name; opt.textContent = name;
  presetsEl.appendChild(opt);
}
presetsEl.addEventListener('change', () => { patternEl.value = PRESETS[presetsEl.value]; run(); });
patternEl.value = PRESETS[presetsEl.value];

const renderer = new Renderer(viewEl);
let sim: Simulation | undefined;
let running = true;

function showMessages(msgs: Message[]) {
  messagesEl.innerHTML = '';
  for (const m of msgs) {
    const d = document.createElement('div');
    d.className = m.level;
    d.textContent = (m.line ? `line ${m.line}: ` : '') + m.text;
    messagesEl.appendChild(d);
  }
}

function run() {
  const parsed = parsePattern(patternEl.value);
  const graph = buildGraph(parsed.rounds);
  showMessages([...parsed.messages, ...graph.messages]);

  roundsEl.innerHTML = '<tr><th>Round</th><th>Sts</th><th>Pattern</th></tr>';
  let prev = 0;
  for (const r of graph.rounds) {
    const tr = document.createElement('tr');
    const expected = roundStitchCount(parsed.rounds[r.index - 1], prev);
    const mismatch = r.expectedCount !== undefined && r.expectedCount !== r.count;
    tr.innerHTML = `<td>${r.label}</td><td${mismatch ? ' style="color:#ffd43b"' : ''}>${r.count}${expected !== r.count ? '*' : ''}</td><td>${r.source}</td>`;
    roundsEl.appendChild(tr);
    prev = r.count;
  }
  const total = document.createElement('tr');
  total.innerHTML = `<td><b>Total</b></td><td><b>${graph.nodes.filter((n) => n.kind !== 'center').length}</b></td><td></td>`;
  roundsEl.appendChild(total);

  if (graph.nodes.length === 0) { sim = undefined; return; }
  sim = new Simulation(graph);
  // Closed shapes get stuffed by default; open ones (tubes, bowls, flat pieces) do not.
  if (!stuffingTouched) stuffingEl.value = endsClosed(graph.rounds) ? '1' : '0';
  applyStuffing();
  renderer.setSimulation(sim);
  running = true;
  toggleBtn.textContent = 'Pause';
}

runBtn.addEventListener('click', run);
toggleBtn.addEventListener('click', () => { running = !running; toggleBtn.textContent = running ? 'Pause' : 'Resume'; });
patternEl.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });

function loop() {
  requestAnimationFrame(loop);
  if (sim && running) {
    for (let i = 0; i < sim.params.stepsPerFrame; i++) sim.step();
    renderer.update();
    showStuffing();
  }
  renderer.render();
}

run();
loop();
