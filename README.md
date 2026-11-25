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

## Controls

| Key | Action |
|---|---|
| Enter | Start (main menu) / activate focused button |
| Up | Accelerate |
| Down | Brake, then reverse |
| Left / Right | Steer |
| Esc | Pause menu (Resume, Main Menu, Quit) |

## Layout

- `index.html` — page shell, HUD, main/pause/quit overlays
- `src/main.js` — menu state machine (menu → playing ⇄ paused → quit)
- `src/game.js` — renderer, bloom post-processing, fixed-step loop (120 Hz), chase camera
- `src/world.js` — endless highway: road, barriers, streetlights, skyline; recycled around the player
- `src/player.js` — arcade car physics, barrier and traffic collisions
- `src/traffic.js` — AI traffic: car-following, lane changes, recycling ahead/behind the player
- `src/car.js` — procedural low-poly vehicles (player coupe, sedan, SUV, box truck)
- `src/input.js` — arrow-key state
- `src/style.css` — menu/HUD styling and palette tokens
- `scripts/dev-sync.mjs` — dev server + auto-pull loop

In dev builds the `Game` instance is exposed as `window.game` for console debugging.
