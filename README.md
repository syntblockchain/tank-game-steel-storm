# Steel Storm

A fast, high-energy top-down tank shooter with a real rigid-body physics core.
It has no dependencies and no asset files: every sprite is painted in code at start-up, and every sound effect and the music are synthesised with Web Audio.

**[Play in the browser](https://syntblockchain.github.io/tank-game-steel-storm/)**

![Steel Storm title screen](docs/screenshots/title.jpg)

```bash
npm start          # then open http://localhost:8080
npm run build      # dist/steel-storm.html: one self-contained file, double-click to play offline
```

`npm run build` uses no dependencies. It bundles the modules and inlines the fonts, and also writes `dist/steel-storm.artifact.html`, a page-body variant for publishing on claude.ai.

## Screenshots

| | |
| --- | --- |
| ![Triple kill in a firefight on the desert road](docs/screenshots/combat.jpg) | ![Behemoth boss fight at a road junction](docs/screenshots/boss.jpg) |
| Combat: a triple kill, with a combo multiplier and shield active | Wave 5: the Behemoth boss |
| ![Player tank by a river with a wooden bridge](docs/screenshots/river.jpg) | ![Field upgrade choice screen](docs/screenshots/upgrade.jpg) |
| Procedural terrain: river, forest and a road bridge | Roguelite upgrade, 1 of 3 after each wave |

## Controls

| Action | Keyboard / mouse | Gamepad | Mobile / Touch |
| --- | --- | --- | --- |
| Drive | WASD (arcade: tank turns toward the direction pressed; `C` switches to classic tank steering) | Left stick | Left joystick |
| Aim | Mouse | Right stick | Right joystick (or drag `MG`) |
| Cannon | Left click | RT | Right joystick (outer ring) |
| Coax machine gun | Right click / `F` (overheats) | LT / RB | `MG` button (hold & drag to aim) |
| Boost | Shift | A / LB | `BST` button |
| Homing missiles | Space / `E` | B / X | `MSL` button |
| Pause · music | Esc · `M` (`J` toggles joysticks) | Start | Top HUD pause button |

## What's in it

- **Track physics.** Each track drives along its own line of action, so steering comes from differential thrust. Four contact patches resist rolling and side-slip. Side-slip force is capped by terrain grip, so tanks drift on sand and when boosting, and grip on roads. Cannon recoil is an off-centre impulse, shell hits knock vehicles around, explosions push everything outward, and the treads scroll with each track's actual ground speed.
- **Collisions.** Oriented boxes and circles with SAT, impulse response with angular terms and Coulomb friction. Ramming damage scales with closing speed and mass. Bushes get crushed, and trees fall to fast hits or to sustained shoving. Crates and explosive barrels can be shoved around, and barrels set off chain reactions.
- **Procedural world.** A 6400×6400 map built from domain-warped noise: coastline, rivers, beaches, desert, grassland, forest and rocky highland. Roads are splines with bridges over water. There are seven enemy bases with gun turrets, sandbag walls and buildings. Buildings are drawn in perspective, GTA1-style, and can be destroyed into rubble.
- **Persistent ground.** Track marks, skid marks, scorch marks, rubble, fallen trees and blown-off turrets are painted onto cached terrain chunks and stay there.
- **Enemies.** Scouts, battle tanks, twin-gun heavies, mortar trucks (red target markers), helicopter gunships, kamikaze drone swarms and base turrets. Every 5th wave brings the **Behemoth** boss, with a twin cannon, missile salvos, MG sweeps and drone launches. Tanks navigate with a BFS flow field and use lead aiming.
- **Progression.** Waves, combo multiplier, kill streaks, pickups (repair, missiles, overdrive, shield, nuke) and a choice of 1 of 3 roguelite upgrades after every wave.
- **Game feel.** Trauma-based screen shake, hit-stop, slow motion on big kills, speed-based camera zoom, aim look-ahead, additive lighting, off-screen threat arrows and a minimap.

## Code map

| File | Purpose |
| --- | --- |
| `src/physics.js` | Rigid bodies, SAT narrow phase, impulse solver, spatial grid, raycasts |
| `src/tank.js` | Tracked-vehicle model, weapons, tank rendering |
| `src/world.js` | Terrain generation, chunk cache and decals, props, perspective buildings, flow field |
| `src/enemies.js` | Tank AI, mortar/boss behaviour, turrets, helicopters, drones |
| `src/projectiles.js` | Shells, bullets, missiles, rockets, mortars, ricochets |
| `src/particles.js` | Pooled particles and effects |
| `src/sprites.js` | Procedural sprite painter |
| `src/audio.js` | Synthesised SFX, engine/rotor loops, sequenced music |
| `src/game.js` | Loop, combat, waves, scoring, upgrades, camera, render order |
| `src/hud.js` | HUD, minimap, menus |
| `src/touch.js` | Dual virtual joysticks, mobile action buttons and responsive touch HUD layout |

`tools/` holds headless-Chrome test scripts (`cd tools && npm i && node bot.mjs`) and `sim-tank.mjs`, which checks the vehicle handling numbers in Node.
