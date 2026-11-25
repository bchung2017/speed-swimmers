const DRIVE_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

export class Input {
  constructor() {
    this.keys = new Set();
    this.enabled = false;

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || !DRIVE_KEYS.has(e.key)) return;
      e.preventDefault();
      this.keys.add(e.key);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setEnabled(on) {
    this.enabled = on;
    this.keys.clear();
  }

  // Throttle is always on; holding Left and Right together brakes instead.
  get brake() {
    return this.keys.has('ArrowLeft') && this.keys.has('ArrowRight') ? 1 : 0;
  }

  get throttle() {
    return 1 - this.brake;
  }

  get steer() {
    return (this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0);
  }
}
