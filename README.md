# speed-swimmers

Highway racing game through a procedural city, built with [three.js](https://threejs.org/). Day, golden hour or night (main menu: Time).

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
| (none) | Accelerates automatically |
| Left / Right | Steer |
| Left + Right | Brake, then reverse |
| Touch / mouse: hold or tap left half | Steer left (a tap counts for 0.16 s) |
| Touch / mouse: hold or tap right half | Steer right |
| Touch / mouse: both halves at once | Brake, then reverse |
| Pause button (top left) | Pause menu |
| Esc | Pause menu (Resume, Main Menu, Quit) |

## Layout

- `index.html` — page shell, HUD, main/pause/quit overlays
- `src/main.js` — menu state machine (menu → playing ⇄ paused → quit)
- `src/game.js` — renderer, bloom post-processing, fixed-step loop (120 Hz), chase camera, dynamic resolution
- `src/world.js` — endless highway: road, barriers, streetlights; recycled around the player
- `src/city.js` — procedural districts streamed in 300 m blocks: buildings, trees, water, bridges, overpasses
- `src/facades.js` — procedural facade textures and the building material that tiles them by building size
- `src/lighting.js` — time-of-day presets, sky dome, sun shadows, clouds, sky reflections
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
| How far traffic leans in its lane, neighbour budget, lean speed | `LEAN_*` constants in `src/traffic.js` |
| Turn-signal share, timing, blink rate; cruise speed ranges and drift | `SIGNAL_*`, `BLINK_HZ`, `*_SPEED`, `LANE_SPEED_BIAS`, `SPEED_DRIFT` in `src/traffic.js` |
| Time-of-day colours, sun, fog, exposure | `PRESETS` in `src/lighting.js` |
| District mix, block size, view distance, densities | `district()`, `SEG`, `ACTIVE`, `CAP` in `src/city.js` |

## Performance notes

- Traffic is drawn with one `InstancedMesh` per vehicle type and material layer; the city with one per object kind. ~45 draw calls plus the shadow pass in daylight.
- City blocks are packed nearest-first into each mesh, and only used instances are drawn.
- Vehicle parts are merged into a few geometries with vertex colours; lights are unlit `MeshBasicMaterial` with HDR colours for bloom.
- One sun with a 140 m shadow box following the player (day/golden only). At night: 4 real point lights on the nearest lamps plus the headlight; streetlight pools are additive decals.
- Pixel ratio is capped at 1.5; render resolution drops (down to 60%) when frames run under ~50 fps and recovers when there is headroom.
- Bloom runs at quarter resolution; MSAA is 2x on high-DPI screens, 4x otherwise.
- No per-step allocations in the physics/traffic loop.

In dev builds the `Game` instance is exposed as `window.game` for console debugging.
