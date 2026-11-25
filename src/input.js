const DRIVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

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

  get throttle() {
    return this.keys.has('ArrowUp') ? 1 : 0;
  }

  get brake() {
    return this.keys.has('ArrowDown') ? 1 : 0;
  }

  get steer() {
    return (this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0);
  }
}
