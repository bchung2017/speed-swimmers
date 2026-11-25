import { Game } from './game.js';
import { Input } from './input.js';
import { PRESETS, PRESET_ORDER } from './lighting.js';

const screens = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  quit: document.getElementById('quit'),
};
const hudEl = document.getElementById('hud');
const speedEl = document.getElementById('speed');

const input = new Input();
let shownSpeed = -1;
const hud = {
  speed(kmh) {
    const v = Math.round(Math.abs(kmh));
    if (v !== shownSpeed) speedEl.textContent = shownSpeed = v;
  },
};
const game = new Game(document.getElementById('app'), input, hud);
if (import.meta.env.DEV) {
  window.game = game;
  import('./world.js').then((w) => (window.__world = w));
}

let state = 'menu';

// Time of day: remembered per browser (storage can be unavailable, e.g. private mode).
const timeButton = document.getElementById('time');
function loadTime() {
  try {
    const t = localStorage.getItem('timeOfDay');
    return PRESETS[t] ? t : 'day';
  } catch {
    return 'day';
  }
}
function setTime(name) {
  game.setTimeOfDay(name);
  timeButton.textContent = `Time: ${PRESETS[name].label}`;
  try {
    localStorage.setItem('timeOfDay', name);
  } catch {
    // not persisted; fine
  }
}
setTime(loadTime());

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
  hudEl.classList.toggle('hidden', name !== null);
  if (name) screens[name].querySelector('button')?.focus();
}

function setState(next) {
  state = next;
  input.setEnabled(next === 'playing');
  game.setRunning(next === 'playing');
  show(next === 'playing' ? null : next);
}

const actions = {
  start() {
    game.reset();
    setState('playing');
  },
  time() {
    const i = PRESET_ORDER.indexOf(game.timeOfDay);
    setTime(PRESET_ORDER[(i + 1) % PRESET_ORDER.length]);
  },
  resume() {
    setState('playing');
  },
  main() {
    setState('menu');
  },
  quit() {
    setState('quit');
    // Only succeeds if the page was opened by script; otherwise the quit screen remains.
    window.close();
  },
};

document.addEventListener('click', (e) => {
  const action = e.target.closest('button[data-action]')?.dataset.action;
  if (action) actions[action]();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state === 'playing') setState('pause');
    else if (state === 'pause') setState('playing');
    return;
  }
  if (state !== 'menu' && state !== 'pause') return;

  const buttons = [...screens[state].querySelectorAll('button')];
  const i = buttons.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(i + step + buttons.length) % buttons.length].focus();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (buttons[i] ?? buttons[0]).click();
  }
});

setState('menu');
