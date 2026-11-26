const DRIVE_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

// A released press keeps counting for this much *game* time (not wall time, so a slow frame can't
// swallow a tap), and taps on both sides this close together brake.
const TAP_HOLD = 0.08; // s
// Touch steering is proportional to how long a side has been held: it starts at TOUCH_MIN of full
// lock and ramps to full over TOUCH_RAMP seconds. A tap is a small nudge; holding turns hard.
const TOUCH_MIN = 0.2;
const TOUCH_RAMP = 0.4; // s
// Braking by touch needs intent: presses on both sides that start within BRAKE_TOGETHER of each
// other, or both sides held for longer than BRAKE_OVERLAP. Moving a thumb from one side to the other
// (brief overlap, or the old side's tap latch) is a side switch, not a brake.
const BRAKE_TOGETHER = 0.12; // s
const BRAKE_OVERLAP = 0.07; // s

// Keyboard: Left / Right arrows. Touch, mouse or pen: press anywhere on the left or right half of
// the play area. Either side steers that way; both sides at once brake.
export class Input {
  constructor(surface) {
    this.keys = new Set();
    this.enabled = false;
    // pointerId -> side (-1 left, 1 right); the side is fixed where the press started.
    this.pointers = new Map();
    this.latch = { [-1]: 0, [1]: 0 }; // remaining game seconds per side
    this.held = { [-1]: 0, [1]: 0 }; // game seconds each side has been active (drives the ramp)
    this.downAt = { [-1]: -1, [1]: -1 }; // game time of each side's latest press
    this.clock = 0; // game seconds
    this.overlap = 0; // game seconds both sides have been active
    this.together = false; // current two-sided press started together (a deliberate brake)
    this.listeners = [];

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || !DRIVE_KEYS.has(e.key)) return;
      e.preventDefault();
      this.keys.add(e.key);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.#clear());

    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const rect = surface.getBoundingClientRect();
      const side = e.clientX - rect.left < rect.width / 2 ? -1 : 1;
      const other = -side;
      const otherActive = this.#pointerSide(other);
      if (otherActive && this.clock - this.downAt[other] <= BRAKE_TOGETHER) this.together = true;
      else if (!this.#held(other)) this.latch[other] = 0; // switching sides: drop the old tap latch
      this.downAt[side] = this.clock;
      this.pointers.set(e.pointerId, side);
      this.#notify();
      surface.setPointerCapture?.(e.pointerId);
    });
    const release = (e) => {
      const side = this.pointers.get(e.pointerId);
      if (side === undefined) return;
      this.pointers.delete(e.pointerId);
      // No tap latch when lifting off one side while the other is held (a thumb moving across),
      // unless the two presses were a deliberate both-sides brake.
      this.latch[side] = this.#held(-side) && !this.together ? 0 : TAP_HOLD;
      this.#notify();
    };
    surface.addEventListener('pointerup', release);
    surface.addEventListener('pointercancel', release);
    surface.addEventListener('lostpointercapture', release);
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setEnabled(on) {
    this.enabled = on;
    this.#clear();
  }

  // Advance tap latches by one simulation step (called by the game loop).
  tick(dt) {
    this.clock += dt;
    if (this.#pointerSide(-1) && this.#pointerSide(1)) this.overlap += dt;
    else {
      this.overlap = 0;
      this.together = false;
    }
    if (this.#touchBrake() !== this.shownBrake) this.#notify();
    for (const side of [-1, 1]) {
      if (this.#pointerSide(side)) this.held[side] += dt;
      else this.held[side] = 0;
      if (this.latch[side] <= 0) continue;
      this.latch[side] -= dt;
      if (this.latch[side] <= 0) this.#notify();
    }
  }

  // Called with (left, right, braking) whenever touch/mouse state changes (for on-screen feedback).
  onChange(fn) {
    this.listeners.push(fn);
  }

  #clear() {
    this.keys.clear();
    this.pointers.clear();
    this.latch[-1] = this.latch[1] = 0;
    this.held[-1] = this.held[1] = 0;
    this.overlap = 0;
    this.together = false;
    this.#notify();
  }

  #notify() {
    const b = this.#touchBrake();
    this.shownBrake = b;
    const newer = this.downAt[-1] > this.downAt[1] ? -1 : 1;
    const both = this.#pointerSide(-1) && this.#pointerSide(1);
    const l = this.#pointerSide(-1) && (b || !both || newer === -1);
    const r = this.#pointerSide(1) && (b || !both || newer === 1);
    for (const fn of this.listeners) fn(l, r, b);
  }

  #held(side) {
    for (const s of this.pointers.values()) if (s === side) return true;
    return false;
  }

  #pointerSide(side) {
    return this.#held(side) || this.latch[side] > 0;
  }

  #touchBrake() {
    return this.#pointerSide(-1) && this.#pointerSide(1) && (this.together || this.overlap >= BRAKE_OVERLAP);
  }

  get left() {
    return this.keys.has('ArrowLeft') || this.#pointerSide(-1);
  }

  get right() {
    return this.keys.has('ArrowRight') || this.#pointerSide(1);
  }

  // Throttle is always on; input on both sides together brakes instead.
  get brake() {
    const kl = this.keys.has('ArrowLeft');
    const kr = this.keys.has('ArrowRight');
    const b = (kl && kr) || (kl && this.#pointerSide(1)) || (kr && this.#pointerSide(-1)) || this.#touchBrake();
    return b ? 1 : 0;
  }

  get throttle() {
    return 1 - this.brake;
  }

  // 0..1 for one side. Keys give full lock; touch ramps with hold time.
  #amount(side, key) {
    if (this.keys.has(key)) return 1;
    if (!this.#pointerSide(side)) return 0;
    return Math.min(1, TOUCH_MIN + (1 - TOUCH_MIN) * (this.held[side] / TOUCH_RAMP));
  }

  // -1..1 (+ = left). During a side switch (both active, not a brake) the newer press wins.
  get steer() {
    if (this.brake) return 0;
    let l = this.#amount(-1, 'ArrowLeft');
    let r = this.#amount(1, 'ArrowRight');
    if (l > 0 && r > 0 && !this.keys.size) {
      if (this.downAt[-1] > this.downAt[1]) r = 0;
      else l = 0;
    }
    return l - r;
  }
}
