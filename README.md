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
- `src/game.js` — renderer, bloom post-processing, fixed-step loop (120 Hz), chase camera, dynamic resolution
- `src/world.js` — endless highway: road, barriers, streetlights, skyline; recycled around the player
- `src/player.js` — arcade car physics, crash lockout (loss of control), barrier collisions
- `src/traffic.js` — AI traffic: car-following, lane changes, light-hit nudges, sliding wrecks, player collisions
- `src/physics.js` — oriented-box contact (SAT) and rigid-body impulse with spin and friction
- `src/wreck.js` — deformable vehicle rigs staged near the player, inward dents, debris particles
- `src/car.js` — procedural low-poly vehicles (player coupe, sedan, SUV, box truck), merged per material layer; traffic is instanced
- `src/input.js` — arrow-key state
- `src/style.css` — menu/HUD styling and palette tokens
- `scripts/dev-sync.mjs` — dev server + auto-pull loop

## Tuning

| What | Where |
|---|---|
| Chase camera distance / height / look-ahead | `CAM_*` constants at the top of `src/game.js` |
| Bloom strength, threshold, per-pixel cap | `BLOOM_*` constants at the top of `src/game.js` |
| Steering, grip, engine, brakes | constants at the top of `src/player.js` |
| Crash threshold, reduced-control duration and strength | `LOSS_OF_CONTROL`, `CRASH_*` in `src/player.js` |
| Traffic mass, dent / wreck / airborne thresholds, launch height, rig staging range | constants at the top of `src/traffic.js` |
| Dent depth, debris particle pool | constants at the top of `src/wreck.js` |
| Lane width (derived: widest vehicle + player + `SQUEEZE_MARGIN`) | `src/world.js` |

## Performance notes

- Traffic is drawn with one `InstancedMesh` per vehicle type and material layer: the whole scene is ~30 draw calls.
- Vehicle parts are merged into a few geometries with vertex colours; lights are unlit `MeshBasicMaterial` with HDR colours for bloom.
- Only 4 real point lights (on the lamps nearest the player) plus the headlight spot; streetlight pools are additive decals.
- Pixel ratio is capped at 1.5; render resolution drops (down to 60%) when frames run under ~50 fps and recovers when there is headroom.
- Bloom runs at quarter resolution; MSAA is 2x on high-DPI screens, 4x otherwise.
- No per-step allocations in the physics/traffic loop.

In dev builds the `Game` instance is exposed as `window.game` for console debugging.
