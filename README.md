# speed-swimmers

Night street racing game built with [three.js](https://threejs.org/).

Visual references and art direction: [`docs/context/`](docs/context/).

## Run

```bash
npm install
npm run dev
```

`npm run build` outputs a static bundle to `dist/`.

## Layout

- `index.html` — page shell and start menu overlay
- `src/main.js` — menu wiring; starts the scene on Start
- `src/scene.js` — renderer, scene, camera, resize, render loop
- `src/style.css` — menu styling and palette tokens
