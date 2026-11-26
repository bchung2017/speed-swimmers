const DRIVE_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

// A released press keeps counting for this much *game* time (not wall time, so a slow frame can't
// swallow a tap): a quick tap steers visibly, and taps on both sides this close together brake.
const TAP_HOLD = 0.16; // s

// Keyboard: Left / Right arrows. Touch, mouse or pen: press anywhere on the left or right half of
// the play area. Either side steers that way; both sides at once brake.
export class Input {
  constructor(surface) {
    this.keys = new Set();
    this.enabled = false;
    // pointerId -> side (-1 left, 1 right); the side is fixed where the press started.
    this.pointers = new Map();
    this.latch = { [-1]: 0, [1]: 0 }; // remaining game seconds per side
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
      this.pointers.set(e.pointerId, side);
      this.#notify();
      surface.setPointerCapture?.(e.pointerId);
    });
    const release = (e) => {
      const side = this.pointers.get(e.pointerId);
      if (side === undefined) return;
      this.pointers.delete(e.pointerId);
      this.latch[side] = TAP_HOLD;
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
    for (const side of [-1, 1]) {
      if (this.latch[side] <= 0) continue;
      this.latch[side] -= dt;
      if (this.latch[side] <= 0) this.#notify();
    }
  }

  // Called with (left, right) booleans whenever touch/mouse state changes (for on-screen feedback).
  onChange(fn) {
    this.listeners.push(fn);
  }

  #clear() {
    this.keys.clear();
    this.pointers.clear();
    this.latch[-1] = this.latch[1] = 0;
    this.#notify();
  }

  #notify() {
    const l = this.#pointerSide(-1);
    const r = this.#pointerSide(1);
    for (const fn of this.listeners) fn(l, r);
  }

  #pointerSide(side) {
    for (const s of this.pointers.values()) if (s === side) return true;
    return this.latch[side] > 0;
  }

  get left() {
    return this.keys.has('ArrowLeft') || this.#pointerSide(-1);
  }

  get right() {
    return this.keys.has('ArrowRight') || this.#pointerSide(1);
  }

  // Throttle is always on; input on both sides together brakes instead.
  get brake() {
    return this.left && this.right ? 1 : 0;
  }

  get throttle() {
    return 1 - this.brake;
  }

  get steer() {
    return (this.left ? 1 : 0) - (this.right ? 1 : 0);
  }
}
