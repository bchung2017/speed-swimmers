# speed-swimmers

Night street racing game built with [three.js](https://threejs.org/).

Visual references and art direction: [`docs/context/`](docs/context/).

## Run

```bash
npm install
npm run dev
```

`npm run dev:sync` does the same, and also runs `git pull --ff-only` every 15 s (override with `SYNC_INTERVAL_MS`). Pulled source changes hot-reload in the browser; if `package.json` or `package-lock.json` changed, it reruns `npm install` and restarts the server. A pull that can't fast-forward (local commits or conflicting edits) is logged and skipped.

`npm run build` outputs a static bundle to `dist/`.

## Layout

- `index.html` — page shell and start menu overlay
- `src/main.js` — menu wiring; starts the scene on Start
- `src/scene.js` — renderer, scene, camera, resize, render loop
- `src/style.css` — menu styling and palette tokens
- `scripts/dev-sync.mjs` — dev server + auto-pull loop
