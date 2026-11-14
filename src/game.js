// Game orchestration: simulation loop, combat resolution, waves, scoring,
// upgrades, camera and the render pipeline.

import { PhysicsWorld } from './physics.js';
import { World, WORLD_W, WORLD_H, T } from './world.js';
import { Particles } from './particles.js';
import { Projectiles } from './projectiles.js';
import { Tank, LAYER } from './tank.js';
import { makeEnemyTank, Turret, Helicopter, Drone, driveToward } from './enemies.js';
import { Input } from './input.js';
import { audio } from './audio.js';
import { buildSprites, drawSprite, soft } from './sprites.js';
import { clamp, lerp, rand, randInt, pick, chance, TAU, angleDiff, makeCanvas, makeNoise } from './util.js';
import * as HUD from './hud.js';
import { PICKUPS } from './pickups.js';
import { detectLang, tr, fontSpec } from './i18n.js';
import { FreeHandController } from './freehand.js';

const STEP = 1 / 60;

export const UPGRADES = [
  { id: 'autoloader', name: 'Autoloader', desc: 'Cannon reloads 20% faster', icon: '⟳', apply: (p) => (p.mods.reload *= 0.8) },
  { id: 'he', name: 'HE Filler', desc: 'Shell blast radius +35%', icon: '✹', apply: (p) => (p.mods.splash *= 1.35) },
  { id: 'sabot', name: 'Sabot Rounds', desc: 'Cannon damage +25%', icon: '➤', apply: (p) => (p.mods.damage *= 1.25) },
  { id: 'ricochet', name: 'Ricochet', desc: 'Shells bounce off hard cover', icon: '↯', max: 3, apply: (p) => p.mods.ricochet++ },
  { id: 'spread', name: 'Scatter Gun', desc: '+2 extra shells in a spread', icon: '⋔', max: 2, apply: (p) => p.mods.spread++ },
  { id: 'armor', name: 'Composite Armour', desc: '+30 max HP and full repair', icon: '⛨', apply: (p) => { p.maxHp += 30; p.hp = p.maxHp; } },
  { id: 'reactive', name: 'Reactive Armour', desc: 'Take 15% less damage', icon: '◈', max: 3, apply: (p) => (p.mods.armor *= 0.85) },
  { id: 'turbo', name: 'Turbo Diesel', desc: 'Speed +12%, boost recharges 30% faster', icon: '⚡', max: 3, apply: (p) => { p.mods.speed *= 1.12; p.mods.boostRegen *= 1.3; } },
  { id: 'ram', name: 'Dozer Blade', desc: 'Ramming deals triple damage', icon: '▲', max: 2, apply: (p) => (p.mods.ram *= 3) },
  { id: 'coax', name: 'Coax Overclock', desc: 'MG fires 30% faster and runs cooler', icon: '≡', max: 3, apply: (p) => { p.mods.mgRate *= 1.3; p.mods.mgHeat *= 0.7; } },
  { id: 'missiles', name: 'Missile Pod', desc: '+5 homing missiles, +1 per 4 kills', icon: '⇶', apply: (p, g) => { g.missiles += 5; g.missilePerKill = (g.missilePerKill || 0) + 1; } },
  { id: 'nanobots', name: 'Nanobots', desc: 'Regenerate 3 HP/s out of combat', icon: '✚', max: 2, apply: (p) => (p.mods.regen += 3) },
  { id: 'cluster', name: 'Cluster Shells', desc: 'Shells scatter 4 bomblets on impact', icon: '⁂', max: 2, apply: (p) => p.mods.cluster++ },
  { id: 'magnet', name: 'Salvage Magnet', desc: 'Pickups fly to you from further away; drops more common', icon: '∪', max: 2, apply: (p, g) => { g.magnet *= 1.8; g.dropBonus += 0.1; } },
];

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = new Input(canvas);
    this.sprites = buildSprites();
    this.state = 'title';
    this.lang = detectLang();
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = this.lang;
    this.controlMode = 'arcade';
    this.touchUiMode = 'on';
    this.freeHand = new FreeHandController();
    this._prevLeftMslOpen = false;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    try {
      this.best = parseInt(localStorage.getItem('steelstorm.best') || '0', 10) || 0;
      this.controlMode = localStorage.getItem('steelstorm.controls') || 'arcade';
      const savedTouch = localStorage.getItem('steelstorm.touch');
      if (savedTouch === 'on' || savedTouch === 'off') this.touchUiMode = savedTouch;
      const savedHandMode = localStorage.getItem('steelstorm.handMode');
      if (savedHandMode === 'smart' || savedHandMode === 'aim') this.freeHand.mode = savedHandMode;
      const savedTwoHand = localStorage.getItem('steelstorm.twoHand');
      if (savedTwoHand === 'on') this.freeHand.twoHand = true;
      const savedLeftWep = localStorage.getItem('steelstorm.leftWeapon');
      if (savedLeftWep === 'auto' || savedLeftWep === 'msl' || savedLeftWep === 'mg') this.freeHand.leftWeapon = savedLeftWep;
    } catch {
      this.best = 0;
    }
    this.input.getContext = () => ({
      state: this.state,
      w: this.w,
      h: this.h,
      insets: this.insets,
      showTouch: this.showTouchControls,
      allowMouseTouch: this.showTouchControls,
      freeHand: this.freeHand,
      toggleFreeHandMode: () => this.toggleFreeHandMode(),
      toggleTwoHand: () => this.toggleTwoHand(),
      cycleLeftWeapon: () => this.cycleLeftWeapon(),
    });
    this.input.onGesture = () => audio.init();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.camNoise = makeNoise(42);
    this.newWorld(Math.floor(Math.random() * 1e9));
    this.titleT = 0;
    this.acc = 0;
    this.last = performance.now();
  }

  get showTouchControls() {
    if (this.touchUiMode === 'on') return true;
    if (this.touchUiMode === 'off') return false;
    return this.input.usingTouch && !this.input.usingGamepad;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    if (typeof getComputedStyle === 'function' && document.documentElement) {
      const cs = getComputedStyle(document.documentElement);
      this.insets = {
        top: parseFloat(cs.getPropertyValue('--sat')) || 0,
        right: parseFloat(cs.getPropertyValue('--sar')) || 0,
        bottom: parseFloat(cs.getPropertyValue('--sab')) || 0,
        left: parseFloat(cs.getPropertyValue('--sal')) || 0,
      };
    }
    // Base zoom shows a consistent amount of world across screen sizes.
    this.baseZoom = clamp(Math.min(this.w / 1350, this.h / 820), 0.45, 1.4);
    this.vignette = HUD.makeVignette(this.w, this.h);
  }

  // --- World / session setup ------------------------------------------------------

  newWorld(seed) {
    this.seed = seed;
    this.physics = new PhysicsWorld(WORLD_W, WORLD_H);
    this.physics.onContact = (a, b, c) => this.onContact(a, b, c);
    this.physics.onImpact = (a, b, j, c, vn) => this.onImpact(a, b, j, c, vn);
    this.world = new World(seed, this.sprites, this.physics);
    this.world.generate();
    this.fx = new Particles(this.sprites, this.world);
    this.projectiles = new Projectiles(this);
    this.minimap = HUD.makeMinimap(this.world);
    this.player = null;
    this.enemyTanks = [];
    this.turrets = [];
    this.air = [];
    this.wrecks = [];
    this.pickups = [];
    this.flyers = []; // turrets blown off wrecks
    this.texts = [];
    this.announce = [];
    this.delayed = [];
    this.time = 0;
    this.cam = { x: this.world.spawn.x, y: this.world.spawn.y, zoom: this.baseZoom, tx: 0, ty: 0 };
    this.shake = 0;
    this.hitStop = 0;
    this.timeScale = 1;
    this.targetTimeScale = 1;
    // Title camera drifts along a road.
    this.titleRoad = this.world.roads[0];
    this.titleIdx = 0;
    for (const b of this.world.bases) for (const t of b.turrets) this.turrets.push(new Turret(this, t.x, t.y, b));
    this.world.updateFlow(this.world.spawn.x, this.world.spawn.y);
  }

  startGame() {
    audio.init();
    if (this.used) this.newWorld(Math.floor(Math.random() * 1e9));
    this.used = true;
    const s = this.world.spawn;
    this.player = new Tank(this, 'player', s.x, s.y, -Math.PI / 2, 'player');
    this.state = 'playing';
    this.score = 0;
    this.kills = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.streak = 0;
    this.streakTimer = 0;
    this.missiles = 3;
    this.missilePerKill = 0;
    this.killsSinceMissile = 0;
    this.magnet = 150;
    this.dropBonus = 0;
    this.upgradeCounts = {};
    this.wave = 0;
    this.waveState = 'intermission';
    this.waveTimer = 2.5;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.stats = { shots: 0, hits: 0, kills: 0, bases: 0, time: 0, damageTaken: 0, bySource: {} };
    this.hurt = 0;
    this.deathTimer = 0;
    this.overdrive = 0;
    this.difficultyHp = 1;
    this.difficultyRate = 1;
    this.difficultyAim = 1.2;
    this.missileCooldown = 0;
    this.flowTimer = 0;
    this.cam.x = s.x;
    this.cam.y = s.y;
    this.touchAim = this.player.turretAngle;
    this.aimX = s.x + Math.cos(this.touchAim) * 280;
    this.aimY = s.y + Math.sin(this.touchAim) * 280;
    this.input.touch.resetAll();
    const t = tr(this.lang);
    audio.startMusic();
    audio.play('stinger', undefined, undefined, { chord: [45, 52, 57, 60] });
    this.say(t.deployedTitle, t.deployedSub, '#e8d36a');
  }

  // --- Main loop -------------------------------------------------------------------------

  frame(now) {
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;
    this.input.pollGamepad();
    if (this.state === 'playing') this.freeHand.update(now);
    this.handleGlobalInput();

    if (this.state === 'playing' || this.state === 'upgrade' || this.state === 'gameover') {
      this.timeScale = lerp(this.timeScale, this.targetTimeScale, Math.min(1, dt * 4));
      if (this.state === 'upgrade') this.timeScale = lerp(this.timeScale, 0.0, Math.min(1, dt * 6));
      let simDt = dt * this.timeScale;
      if (this.hitStop > 0) {
        this.hitStop -= dt;
        simDt = 0;
      }
      this.acc += simDt;
      let steps = 0;
      while (this.acc >= STEP && steps < 6) {
        this.step(STEP);
        this.acc -= STEP;
        steps++;
      }
      if (steps === 6) this.acc = 0;
      this.updateCamera(dt);
    } else if (this.state === 'title') {
      this.titleT += dt;
      this.updateTitleCamera(dt);
      this.world.update(dt);
      this.fx.update(dt);
    }
    this.render(dt);
    this.input.endFrame();
  }

  handleGlobalInput() {
    const before = this.state;
    this.handleStateInput();
    // The key or click that changed state is used up, so starting a game or picking
    // an upgrade with Space doesn't also fire a missile salvo in the same frame.
    if (this.state !== before) {
      this.input.endFrame();
      this.input.touch.resetAll();
    }
  }

  handleStateInput() {
    const inp = this.input;
    if (inp.hit('KeyM')) audio.toggleMusic();
    if (inp.hit('KeyJ')) this.toggleTouchUi();
    if (inp.hit('KeyL')) this.toggleLang();
    if (inp.hit('KeyH')) this.toggleFreeHand();
    if (inp.hit('KeyT')) this.toggleTwoHand();
    const tap = inp.touchTap || (inp.mouseClicked[0] ? { x: inp.mouseX, y: inp.mouseY } : null);

    if (this.state === 'title') {
      if (inp.hit('KeyC')) this.toggleControls();
      if (tap && HUD.titleLangToggleHit(this, tap.x, tap.y)) {
        this.toggleLang();
        return;
      }
      if (tap && HUD.titleTwoHandToggleHit(this, tap.x, tap.y)) {
        this.toggleTwoHand();
        return;
      }
      if (tap && HUD.titleFreeHandToggleHit(this, tap.x, tap.y)) {
        this.toggleFreeHand();
        return;
      }
      if (tap && HUD.titleTouchToggleHit(this, tap.x, tap.y)) {
        this.toggleTouchUi();
        audio.play('ui', undefined, undefined, { freq: 660 });
        return;
      }
      if (inp.hit('Enter', 'Space') || tap || inp.padHit(0) || inp.padHit(9)) this.startGame();
    } else if (this.state === 'playing') {
      if (inp.touch.handPressed) this.toggleFreeHand();
      if (inp.touch.twoHandPressed) this.toggleTwoHand();
      if (inp.hit('Escape', 'KeyP') || inp.padHit(9) || inp.touch.pausePressed) {
        this.state = 'paused';
        audio.updateEngine(0, 0, false, false);
        audio.updateRotor(0);
        audio.play('ui', undefined, undefined, { freq: 440 });
      }
    } else if (this.state === 'paused') {
      if (inp.hit('KeyC')) this.toggleControls();
      if (inp.hit('KeyQ')) return this.toTitle();
      if (inp.hit('Escape', 'KeyP', 'Enter') || inp.padHit(9)) {
        this.state = 'playing';
        this.last = performance.now();
        return;
      }
      if (tap) {
        const hit = HUD.pauseButtonHit(this, tap.x, tap.y);
        if (hit === 'resume') {
          this.state = 'playing';
          this.last = performance.now();
        } else if (hit === 'music') {
          audio.init();
          audio.toggleMusic();
          audio.play('ui', undefined, undefined, { freq: 520 });
        } else if (hit === 'freehand') {
          this.toggleFreeHand();
        } else if (hit === 'twohand') {
          this.toggleTwoHand();
        } else if (hit === 'handmode') {
          this.toggleFreeHandMode();
        } else if (hit === 'leftweapon') {
          this.cycleLeftWeapon();
        } else if (hit === 'touch') {
          this.toggleTouchUi();
          audio.play('ui', undefined, undefined, { freq: 600 });
        } else if (hit === 'controls') {
          this.toggleControls();
        } else if (hit === 'lang') {
          this.toggleLang();
        } else if (hit === 'quit') {
          this.toTitle();
        } else if (inp.mouseClicked[0]) {
          this.state = 'playing';
          this.last = performance.now();
        }
      }
    } else if (this.state === 'upgrade') {
      this.handleUpgradeInput();
    } else if (this.state === 'gameover') {
      if (this.deathTimer > 2.5) {
        if (tap && HUD.gameOverTitleHit(this, tap.x, tap.y)) return this.toTitle();
        if (inp.hit('Enter', 'KeyR', 'Space') || tap || inp.padHit(0) || inp.padHit(9)) this.startGame();
      }
      if (inp.hit('Escape')) this.toTitle();
    }
  }

  toggleFreeHand() {
    if (this.freeHand.enabled) this.freeHand.disable();
    else this.freeHand.enable();
    audio.play('ui', undefined, undefined, { freq: this.freeHand.enabled ? 760 : 420 });
  }

  toggleTwoHand() {
    this.freeHand.toggleTwoHand();
    if (this.freeHand.twoHand && !this.freeHand.enabled) this.freeHand.enable();
    try {
      localStorage.setItem('steelstorm.twoHand', this.freeHand.twoHand ? 'on' : 'off');
    } catch {}
    audio.play('ui', undefined, undefined, { freq: this.freeHand.twoHand ? 820 : 520 });
  }

  cycleLeftWeapon() {
    this.freeHand.cycleLeftWeapon();
    try {
      localStorage.setItem('steelstorm.leftWeapon', this.freeHand.leftWeapon);
    } catch {}
    audio.play('ui', undefined, undefined, { freq: 700 });
  }

  toggleFreeHandMode() {
    this.freeHand.toggleMode();
    try {
      localStorage.setItem('steelstorm.handMode', this.freeHand.mode);
    } catch {}
    audio.play('ui', undefined, undefined, { freq: 640 });
  }

  toggleLang() {
    this.lang = this.lang === 'vi' ? 'en' : 'vi';
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = this.lang;
    try {
      localStorage.setItem('steelstorm.lang', this.lang);
    } catch {}
    audio.play('ui', undefined, undefined, { freq: 720 });
  }

  toggleTouchUi() {
    const order = ['on', 'auto', 'off'];
    this.touchUiMode = order[(order.indexOf(this.touchUiMode) + 1) % order.length];
    try {
      localStorage.setItem('steelstorm.touch', this.touchUiMode);
    } catch {}
    this.input.touch.resetAll();
  }

  toggleControls() {
    this.controlMode = this.controlMode === 'arcade' ? 'tank' : 'arcade';
    try {
      localStorage.setItem('steelstorm.controls', this.controlMode);
    } catch {}
    audio.play('ui', undefined, undefined, { freq: 660 });
  }

  toTitle() {
    audio.stopMusic();
    audio.updateEngine(0, 0, false, false);
    audio.updateRotor(0);
    this.newWorld(Math.floor(Math.random() * 1e9));
    this.used = false;
    this.state = 'title';
  }

  step(dt) {
    this.time += dt;
    this.stats.time += this.player && this.player.alive ? dt : 0;
    const p = this.player;

    if (p && p.alive) this.controlPlayer(dt);
    for (const ai of this.enemyTanks) ai.update(dt);

    // Physics: forces -> integrate -> collide.
    if (p) p.applyForces(dt);
    for (const ai of this.enemyTanks) ai.tank.applyForces(dt);
    this.physics.step(dt);

    if (p) p.update(dt);
    for (const ai of this.enemyTanks) ai.tank.update(dt);
    for (const w of this.wrecks) this.updateWreck(w, dt);
    for (const t of this.turrets) t.update(dt);
    for (const a of this.air) a.update(dt);
    this.air = this.air.filter((a) => a.alive || a.dying > 0);
    if (this.enemyTanks.some((e) => !e.alive)) this.enemyTanks = this.enemyTanks.filter((e) => e.alive);

    this.projectiles.update(dt);
    this.updatePickups(dt);
    this.updateFlyers(dt);
    this.fx.update(dt);
    this.world.update(dt);
    this.updateTexts(dt);
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      d.t -= dt;
      if (d.t <= 0) {
        this.delayed.splice(i, 1);
        d.fn();
      }
    }

    // Flow field toward the player for enemy navigation.
    this.flowTimer -= dt;
    if (p && this.flowTimer <= 0) {
      this.flowTimer = 0.5;
      this.world.updateFlow(p.x, p.y);
    }

    if (this.state === 'playing' && p) {
      this.updateWaves(dt);
      this.updateCombo(dt);
      if (this.overdrive > 0) {
        this.overdrive -= dt;
        p.overdrive = this.overdrive > 0;
      }
    }
    if (this.state === 'gameover') this.deathTimer += dt;
    this.hurt = Math.max(0, this.hurt - dt * 2);

    // Audio
    if (p) {
      audio.updateEngine(p.throttle, p.body.speed, p.boosting, p.alive);
      let rotor = 0;
      for (const a of this.air) if (a instanceof Helicopter) rotor = Math.max(rotor, 1 - Math.hypot(a.x - p.x, a.y - p.y) / 1300);
      audio.updateRotor(rotor);
      const threat = this.enemyTanks.length + this.air.length * 0.7;
      audio.intensity = lerp(audio.intensity, clamp(0.25 + threat / 10, 0, 1), dt * 0.5);
    }
  }

  // --- Player control ------------------------------------------------------------------------

  controlPlayer(dt) {
    const p = this.player, inp = this.input;
    let mx = 0, my = 0;
    if (inp.down('KeyW', 'ArrowUp')) my -= 1;
    if (inp.down('KeyS', 'ArrowDown')) my += 1;
    if (inp.down('KeyA', 'ArrowLeft')) mx -= 1;
    if (inp.down('KeyD', 'ArrowRight')) mx += 1;
    const [lx, ly] = inp.stick(0, 1);
    const pad = inp.pad && (Math.abs(lx) > 0 || Math.abs(ly) > 0);
    const tLeft = inp.touch.left;
    const touchDrive = this.showTouchControls && tLeft.active && tLeft.mag > 0;
    const keyDrive = mx !== 0 || my !== 0;

    const fh = this.freeHand;
    const rightHandActive = !!(fh && fh.enabled && fh.right.detected);
    const rg = rightHandActive ? fh.right.gesture : null;
    const leftHandActive = !!(fh && fh.enabled && fh.twoHand && fh.left.detected);
    const lg = leftHandActive ? fh.left.gesture : null;

    const leftHandDrive = leftHandActive && lg && !lg.fire && (lg.dx !== 0 || lg.dy !== 0);
    const rightHandSmartDrive = !leftHandActive && rightHandActive && fh.mode === 'smart' && rg && !rg.fire && (rg.dx !== 0 || rg.dy !== 0);

    if (touchDrive) {
      driveToward(p, tLeft.x, tLeft.y, tLeft.mag, true);
    } else if (pad) {
      driveToward(p, lx, ly, Math.min(1, Math.hypot(lx, ly)), true);
    } else if (keyDrive) {
      if (this.controlMode === 'tank') {
        p.throttle = -my;
        p.turn = mx;
      } else {
        const m = Math.hypot(mx, my);
        driveToward(p, mx / m, my / m, 1, true);
      }
    } else if (leftHandDrive) {
      driveToward(p, lg.dx, lg.dy, clamp(0.35 + (lg.mag ?? 1) * 0.65, 0.35, 1), true);
    } else if (leftHandActive) {
      // Left hand is resting at its anchor ("do nothing") or open firing: stay stationary.
      p.throttle = 0;
      p.turn = 0;
    } else if (rightHandSmartDrive) {
      driveToward(p, rg.dx, rg.dy, clamp(0.35 + (rg.mag ?? 1) * 0.65, 0.35, 1), true);
    } else {
      p.throttle = 0;
      p.turn = 0;
    }

    // Aim (Right joystick / Free Hand Right / Gamepad / Mouse)
    const [rx, ry] = inp.stick(2, 3, 0.25);
    const tRight = inp.touch.right;
    const tMg = inp.touch.mg;
    const directTouchAim = this.showTouchControls && (tRight.active || (tMg.active && tMg.aiming));
    const padHolding = !!(fh && fh.enabled && fh.hasAnyPadPointer && fh.hasAnyPadPointer());
    const usingTouchButtonOnly =
      padHolding ||
      (this.showTouchControls && !directTouchAim && (tMg.active || inp.touch.bst.active || inp.touch.msl.active));
    const aimDist = clamp((Math.min(this.w, this.h) / this.cam.zoom) * 0.36, 180, 320);

    if (inp.usingGamepad) {
      if (rx || ry) this.padAim = Math.atan2(ry, rx);
      p.aim = this.padAim ?? p.turretAngle;
      this.aimX = p.x + Math.cos(p.aim) * 320;
      this.aimY = p.y + Math.sin(p.aim) * 320;
    } else if (directTouchAim || inp.usingTouch) {
      if (tRight.active && tRight.mag > 0) this.touchAim = tRight.angle;
      else if (tMg.active && tMg.aiming) this.touchAim = tMg.aimAngle;
      else if (rightHandActive && rg.angle !== null) this.touchAim = rg.angle;
      p.aim = this.touchAim ?? p.turretAngle;
      this.aimX = p.x + Math.cos(p.aim) * aimDist;
      this.aimY = p.y + Math.sin(p.aim) * aimDist;
    } else if (rightHandActive) {
      if (rg.angle !== null) this.touchAim = rg.angle;
      p.aim = this.touchAim ?? p.turretAngle;
      this.aimX = p.x + Math.cos(p.aim) * aimDist;
      this.aimY = p.y + Math.sin(p.aim) * aimDist;
    } else if (usingTouchButtonOnly) {
      p.aim = this.touchAim ?? p.turretAngle;
      this.aimX = p.x + Math.cos(p.aim) * aimDist;
      this.aimY = p.y + Math.sin(p.aim) * aimDist;
    } else {
      const [wx, wy] = this.screenToWorld(inp.mouseX, inp.mouseY);
      this.aimX = wx;
      this.aimY = wy;
      p.aim = Math.atan2(wy - p.y, wx - p.x);
      this.touchAim = p.aim;
    }

    p.wantBoost = inp.down('ShiftLeft', 'ShiftRight') || inp.padButton(0) || inp.padButton(4) || (this.showTouchControls && inp.touch.bst.active);
    const fire = inp.mouseDown[0] || inp.padValue(7) > 0.3 || (this.showTouchControls && tRight.firing) || (rightHandActive && rg.fire);

    // 2-hand Free Hand: Left Open hand fires alternative ammo (missiles / coax MG)
    const leftOpen = !!(leftHandActive && lg && lg.fire);
    const mgByHand = leftOpen && (fh.leftWeapon === 'auto' || fh.leftWeapon === 'mg');
    const mslByHand = leftOpen && (fh.leftWeapon === 'auto' || fh.leftWeapon === 'msl');

    const mg = inp.mouseDown[2] || inp.padValue(6) > 0.3 || inp.padButton(5) || inp.down('KeyF') || (this.showTouchControls && tMg.active) || mgByHand;
    if (fire && p.fireCannon()) this.stats.shots++;
    if (mg) p.fireMg();

    this.missileCooldown -= dt;
    const mslTrigger = inp.hit('Space', 'KeyE') || inp.padHit(1) || inp.padHit(2) || (this.showTouchControls && inp.touch.mslPressed);
    if (this.missileCooldown <= 0) {
      if (mslTrigger || (mslByHand && this.missiles > 0)) this.fireMissiles();
      else if (mslByHand && !this._prevLeftMslOpen && fh.leftWeapon === 'msl') this.fireMissiles();
    }
    this._prevLeftMslOpen = mslByHand;
  }

  fireMissiles() {
    const p = this.player;
    if (this.missiles <= 0) {
      audio.play('ui', undefined, undefined, { freq: 180 });
      return;
    }
    const n = Math.min(4, this.missiles);
    this.missiles -= n;
    this.missileCooldown = 0.6;
    for (let i = 0; i < n; i++) {
      const target = this.findTarget(this.aimX, this.aimY, 'player', 900, null, i);
      const side = i % 2 ? 1 : -1;
      const a = p.turretAngle + side * (0.9 + i * 0.15);
      const [sx, sy] = p.body.toWorld(-10, side * 12);
      this.delayed.push({ t: i * 0.07, fn: () => this.spawnMissile(sx, sy, a, 'player', p, target, { speed: 260, maxSpeed: 900, turnRate: 5.5, damage: 45 }) });
    }
    audio.play('missile', p.x, p.y);
    this.addShake(0.15);
  }

  screenToWorld(sx, sy) {
    const z = this.cam.zoom;
    return [this.cam.x + (sx - this.w / 2) / z, this.cam.y + (sy - this.h / 2) / z];
  }

  worldToScreen(wx, wy) {
    const z = this.cam.zoom;
    return [(wx - this.cam.x) * z + this.w / 2, (wy - this.cam.y) * z + this.h / 2];
  }

  // --- Spawners --------------------------------------------------------------------------------

  spawnShell(o) {
    const life = (o.team === 'player' ? 950 : 900) / o.speed;
    this.projectiles.add({
      type: 'shell',
      x: o.x,
      y: o.y,
      vx: Math.cos(o.angle) * o.speed + (o.vx || 0),
      vy: Math.sin(o.angle) * o.speed + (o.vy || 0),
      damage: o.damage,
      splash: o.splash,
      owner: o.owner,
      team: o.team,
      big: o.big,
      ricochet: o.ricochet || 0,
      cluster: o.cluster || 0,
      life,
    });
  }

  spawnBullet(o) {
    this.projectiles.add({ type: 'bullet', x: o.x, y: o.y, vx: Math.cos(o.angle) * o.speed, vy: Math.sin(o.angle) * o.speed, damage: o.damage, splash: 0, owner: o.owner, team: o.team, life: 0.5 });
  }

  spawnMissile(x, y, angle, team, owner, target, o) {
    this.projectiles.add({
      type: 'missile',
      x,
      y,
      vx: Math.cos(angle) * o.speed,
      vy: Math.sin(angle) * o.speed,
      maxSpeed: o.maxSpeed,
      accel: 1100,
      turnRate: o.turnRate,
      damage: o.damage,
      splash: 55,
      target,
      team,
      owner,
      life: 3.5,
      wobble: rand(0, TAU),
      shootable: team === 'enemy',
      hp: 3,
    });
  }

  spawnRocket(x, y, angle, owner) {
    this.projectiles.add({ type: 'rocket', x, y, vx: Math.cos(angle) * 620, vy: Math.sin(angle) * 620, damage: 7, splash: 36, owner, team: 'enemy', life: 1.4 });
  }

  spawnMortar(sx, sy, tx, ty, flight, damage, splash, owner, marker) {
    this.projectiles.add({ type: 'mortar', x: sx, y: sy, sx, sy, tx, ty, flight, apex: 120 + Math.hypot(tx - sx, ty - sy) * 0.3, damage, splash, owner, team: owner ? owner.team : 'player', marker, vx: 0, vy: 0, z: 0 });
  }

  spawnDrone(x, y) {
    this.air.push(new Drone(this, x, y));
  }

  spawnPickup(x, y, kind) {
    if (!kind) {
      const r = Math.random();
      kind = r < 0.42 ? 'repair' : r < 0.67 ? 'missiles' : r < 0.82 ? 'overdrive' : r < 0.97 ? 'shield' : 'nuke';
    }
    this.pickups.push({ x, y, kind, life: 22, t: rand(0, TAU), vx: rand(-80, 80), vy: rand(-80, 80) });
  }

  // --- Queries ---------------------------------------------------------------------------------

  lineOfSight(x0, y0, x1, y1, ignoreA, ignoreB) {
    const hit = this.physics.raycast(x0, y0, x1, y1, (b) => {
      if (b === ignoreA || b === ignoreB || b.kind === 'water') return false;
      const o = b.owner;
      if (!o) return true;
      if (o.type === 'bush' || o.type === 'crate' || o.type === 'barrel') return false;
      if (b.kind === 'tank' && o.alive) return false;
      return true;
    });
    return !hit;
  }

  // Air units (and shootable missiles) intersecting a projectile's segment.
  hitAir(p, x0, y0, x1, y1) {
    const pts = (ax, ay, r) => {
      const dx = x1 - x0, dy = y1 - y0;
      const l2 = dx * dx + dy * dy || 1;
      const t = clamp(((ax - x0) * dx + (ay - y0) * dy) / l2, 0, 1);
      const cx = x0 + dx * t, cy = y0 + dy * t;
      return (cx - ax) ** 2 + (cy - ay) ** 2 < r * r;
    };
    if (p.team === 'player') {
      for (const a of this.air) if (a.alive && !(a.dying > 0) && pts(a.x, a.y, a.radius)) return a;
      if (p.type === 'bullet' || p.type === 'shell') {
        for (const m of this.projectiles.list) {
          if (!m.alive || !m.shootable) continue;
          if (pts(m.x, m.y, 14)) {
            m.alive = false;
            this.explode(m.x, m.y, 30, 0, this.player, { size: 0.6, team: 'player', noScorch: true });
            this.floatText(m.x, m.y, tr(this.lang).intercept, '#7ad7ff');
            this.addScore(50, m.x, m.y, true);
            return { damage: () => 0, alive: true };
          }
        }
      }
    }
    return null;
  }

  findTarget(x, y, team, range, dir, skip = 0) {
    const cands = [];
    const consider = (e) => {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < range) cands.push([d, e]);
    };
    if (team === 'player') {
      for (const ai of this.enemyTanks) if (ai.alive) consider(ai.tank);
      for (const a of this.air) if (a.alive && !(a.dying > 0)) consider(a);
      for (const t of this.turrets) if (t.alive) consider(t);
    } else if (this.player && this.player.alive) consider(this.player);
    cands.sort((a, b) => a[0] - b[0]);
    if (!cands.length) return null;
    return cands[skip % cands.length][1];
  }

  // --- Combat resolution --------------------------------------------------------------------

  explode(x, y, radius, damage, owner, opts = {}) {
    const size = opts.size ?? radius / 60;
    this.fx.explosion(x, y, size, { debris: opts.debris, dirt: opts.dirt, noScorch: opts.noScorch });
    audio.play('explosion', x, y, { size });
    if (this.player) {
      const d = Math.hypot(x - this.player.x, y - this.player.y);
      this.addShake(clamp(size * 0.45 * (1 - d / 900), 0, 0.8));
    }
    const team = opts.team ?? (owner && owner.team) ?? 'neutral';
    const bodies = this.physics.query(x, y, radius * 1.3, []);
    for (const b of bodies) {
      const dx = b.x - x, dy = b.y - y;
      const d = Math.max(0, Math.hypot(dx, dy) - b.r * 0.5);
      const f = clamp(1 - d / (radius * 1.3), 0, 1);
      if (f <= 0) continue;
      // Blast impulse pushes everything outward (and adds spin).
      if (!b.isStatic) {
        const l = Math.hypot(dx, dy) || 1;
        const imp = f * (damage * 55 + 1500) * Math.min(2.5, size);
        b.applyImpulseAt((dx / l) * imp, (dy / l) * imp, b.x - (dy / l) * rand(-4, 4), b.y + (dx / l) * rand(-4, 4));
      }
      const o = b.owner;
      if (!o || o === opts.exclude || damage <= 0) continue;
      if (o.damage && o.team) {
        if (o.team === team) continue;
        o.damage(damage * f, owner, b.x, b.y);
      } else if (o.hp !== undefined) {
        this.damageProp(o, damage * f * 1.5, owner);
      }
    }
    // Trees/bushes are static and caught by the query too; air units:
    for (const a of this.air) {
      if (!a.alive || a.team === team) continue;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < radius) a.damage(damage * (1 - d / radius), owner);
    }
    if (opts.cluster > 0) {
      for (let i = 0; i < 4 * opts.cluster; i++) {
        const a = rand(0, TAU), r = rand(40, 90);
        this.spawnMortar(x, y, x + Math.cos(a) * r, y + Math.sin(a) * r, rand(0.35, 0.6), damage * 0.35, 32, owner, false);
      }
    }
  }

  damageProp(p, amount, source) {
    if (!p.alive || p.hp === Infinity) return;
    p.hp -= amount;
    p.flash = 1;
    if (p.hp <= 0) this.destroyProp(p, source);
  }

  destroyProp(p, source) {
    if (!p.alive) return;
    p.alive = false;
    const w = this.world;
    const x = p.body ? p.body.x : p.x, y = p.body ? p.body.y : p.y;
    if (p.body) this.physics.remove(p.body);
    switch (p.type) {
      case 'tree':
      case 'pine':
        this.fx.leaves(x, y, 22);
        this.fx.debris(x, y, 'wood', 5, 120, 200);
        w.stamp(p.spr, x + rand(-6, 6), y + rand(-6, 6), rand(0, TAU), 0.32, 0.85);
        w.stamp(this.sprites.debris.wood[0], x, y, 0, 1, 1.8);
        audio.play('crunch', x, y);
        break;
      case 'bush':
        this.fx.leaves(x, y, 10);
        w.stamp(p.spr, x, y, p.angle, 0.3, 0.75);
        audio.play('crunch', x, y, { volume: 0.6 });
        break;
      case 'crate':
        this.fx.debris(x, y, 'wood', 9, 220, 260);
        this.fx.dust(x, y, '#a08060', 1.2);
        audio.play('crunch', x, y);
        if (chance(0.35 + this.dropBonus)) this.spawnPickup(x, y);
        break;
      case 'barrel':
        // Short fuse so chain reactions ripple outward.
        this.delayed.push({ t: rand(0.05, 0.14), fn: () => this.explode(x, y, 100, 48, source, { size: 1.6, team: 'neutral', debris: 'metal' }) });
        break;
      case 'sandbag':
        this.fx.debris(x, y, 'stone', 6, 160, 200);
        for (let i = 0; i < 4; i++) this.fx.dust(x + rand(-20, 20), y + rand(-6, 6), '#b8a070', 1.5);
        audio.play('crunch', x, y);
        break;
      case 'building':
        w.rubble(p);
        w._markBlocked(p, 0);
        for (let i = 0; i < 18; i++) this.fx.smoke(x + rand(-p.w / 2, p.w / 2), y + rand(-p.h / 2, p.h / 2), 2, false);
        for (let i = 0; i < 3; i++) this.delayed.push({ t: i * 0.15, fn: () => this.fx.explosion(x + rand(-p.w / 3, p.w / 3), y + rand(-p.h / 3, p.h / 3), 1.3, { debris: 'stone', noScorch: true }) });
        this.fx.debris(x, y, 'stone', 20, 300, 380);
        audio.play('explosion', x, y, { size: 2.5 });
        this.addShake(0.5);
        if (source === this.player) this.addScore(200, x, y);
        if (chance(0.5 + this.dropBonus)) this.spawnPickup(x, y);
        break;
    }
  }

  onContact(a, b, c) {
    // Tanks crush bushes outright and flatten trees at speed.
    const tank = a.kind === 'tank' ? a : b.kind === 'tank' ? b : null;
    if (!tank) return true;
    const other = tank === a ? b : a;
    const o = other.owner;
    if (!o || !o.type) return true;
    const t = tank.owner;
    if (o.crushable) {
      this.destroyProp(o, t);
      return false;
    }
    if ((o.type === 'tree' || o.type === 'pine') && t.alive) {
      const n = tank === a ? 1 : -1;
      const vn = (tank.vx * c.nx + tank.vy * c.ny) * n;
      const heavy = t.kind === 'heavy' || t.kind === 'boss';
      if (vn > (t.boosting ? 60 : heavy ? 90 : 170)) {
        this.destroyProp(o, t);
        tank.vx *= 0.85;
        tank.vy *= 0.85;
        if (t === this.player) this.addShake(0.12);
        return false;
      }
      // Sustained shoving topples a tree even at low speed.
      if (Math.abs(t.throttle) > 0.5) {
        o.push = (o.push || 0) + STEP;
        o.flash = Math.max(o.flash || 0, 0.3);
        if (o.push > (heavy ? 0.15 : t.kind === 'scout' ? 0.6 : 0.35)) {
          this.destroyProp(o, t);
          return false;
        }
      }
    }
    return true;
  }

  onImpact(a, b, j, c, vn) {
    if (vn < 60) return;
    const ta = a.kind === 'tank' ? a.owner : null;
    const tb = b.kind === 'tank' ? b.owner : null;
    if (!ta && !tb) {
      // Props knocking into each other: barrels may go off.
      if (vn > 260) for (const body of [a, b]) if (body.owner && body.owner.explosive) this.damageProp(body.owner, 20, null);
      if (vn > 120) audio.play('thud', c.cx, c.cy, { strength: vn / 500, volume: 0.5 });
      return;
    }
    audio.play('thud', c.cx, c.cy, { strength: vn / 400 });
    if (vn > 150) this.fx.smallHit(c.cx, c.cy, Math.atan2(c.ny, c.nx), '#ffcc88');
    const p = this.player;
    // Ramming damage scales with closing speed and the rammer's mass.
    const ram = (attacker, victim, body) => {
      if (!attacker || !attacker.alive) return;
      const vo = victim && victim.body ? victim : null;
      let dmg = Math.max(0, vn - 110) * 0.12 * (attacker.body.mass / 50);
      if (attacker === p) {
        dmg *= p.mods.ram * (p.boosting ? 2 : 1);
      }
      if (vo && vo.damage && vo.team !== attacker.team) {
        if (attacker !== p && vo === p) dmg *= 0.5 / Math.sqrt(p.mods.ram);
        if (dmg > 1) {
          vo.damage(dmg, attacker, c.cx, c.cy);
          if (attacker === p && dmg > 8) this.floatText(c.cx, c.cy, tr(this.lang).ram, '#ffb347');
        }
      } else if (body && body.owner && body.owner.hp !== undefined && body.owner.type) {
        if (dmg > 2 || body.owner.explosive) this.damageProp(body.owner, dmg * 1.5 + (vn > 220 ? 10 : 0), attacker);
      }
    };
    ram(ta, tb || (b.owner && b.owner.damage ? b.owner : null), b);
    ram(tb, ta || (a.owner && a.owner.damage ? a.owner : null), a);
    if ((ta === p || tb === p) && vn > 120) this.addShake(clamp(vn / 900, 0, 0.4));
  }

  onTankDestroyed(tank, source) {
    tank.alive = false;
    const b = tank.body;
    const size = tank.L / 64;
    this.fx.tankDeath(b.x, b.y, size);
    audio.play('explosion', b.x, b.y, { size: 2.2 * size });
    // Blast damages the dying tank's own side (so wrecks can chain-kill).
    this.delayed.push({ t: 0.02, fn: () => this.explode(b.x, b.y, 80 * size, 22, source, { size: 0.01, team: tank.team, noScorch: true }) });
    this.fx.light(b.x, b.y, 220 * size, '#ff8a3a', 0.7, 0.6);
    this.world.stamp(pick(this.sprites.scorch), b.x, b.y, rand(0, TAU), 0.9, 2 * size);
    // Wreck becomes heavy pushable debris.
    b.setMass(tank.spec.mass * 1.6);
    b.linearDrag = 2.2;
    b.angularDrag = 3;
    b.groundFriction = 250;
    b.applyImpulseAt(rand(-1, 1) * b.mass * 60, rand(-1, 1) * b.mass * 60, b.x + rand(-10, 10), b.y + rand(-10, 10));
    tank.burn = 7 + rand(0, 4);
    tank.smokeTime = 25;
    tank.throttle = tank.turn = 0;
    if (tank.kind !== 'truck' && (tank === this.player || chance(0.6))) {
      // Turret cooks off and flies.
      tank.turretLost = true;
      const [px, py] = tank.pivot();
      this.flyers.push({ x: px, y: py, z: 0, vz: rand(380, 520) * Math.sqrt(size), vx: rand(-90, 90), vy: rand(-90, 90), rot: tank.turretAngle, vrot: rand(-9, 9), set: tank.set, barrel: true });
    }
    this.wrecks.push(tank);
    if (this.wrecks.length > 28) {
      const old = this.wrecks.shift();
      this.physics.remove(old.body);
      this.world.stamp(old.set.wreckHull, old.body.x, old.body.y, old.body.angle, 0.6);
    }
    if (tank === this.player) return this.onPlayerDeath();
    this.registerKill(tank.spec.score, b.x, b.y, source, tank.kind === 'boss' ? 1 : 0.22, tank.kind);
    if (tank.kind === 'boss') {
      this.targetTimeScale = 0.25;
      this.delayed.push({ t: 0.6, fn: () => (this.targetTimeScale = 1) });
      this.say(tr(this.lang).bossDestroyed, `+${tank.spec.score * this.mult()}`, '#ffd34d');
      for (let i = 0; i < 6; i++) this.delayed.push({ t: 0.2 + i * 0.18, fn: () => this.fx.explosion(b.x + rand(-60, 60), b.y + rand(-50, 50), rand(1.2, 2), { debris: 'metal' }) });
      for (let i = 0; i < 3; i++) this.spawnPickup(b.x, b.y, i === 0 ? 'repair' : null);
    } else this.hitStop = 0.035;
  }

  onTurretDestroyed(t, source) {
    this.fx.tankDeath(t.x, t.y, 0.9);
    audio.play('explosion', t.x, t.y, { size: 2 });
    this.world.stamp(pick(this.sprites.scorch), t.x, t.y, rand(0, TAU), 0.9, 2);
    this.flyers.push({ x: t.x, y: t.y, z: 0, vz: 480, vx: rand(-80, 80), vy: rand(-80, 80), rot: t.turretAngle, vrot: rand(-8, 8), set: t.set, barrel: true });
    t.turretLost = true;
    this.registerKill(t.scoreValue, t.x, t.y, source, 0.4, 'turret');
    const base = t.base;
    if (base && !base.destroyed && base.turrets.every((s) => !this.turretAt(s) || !this.turretAt(s).alive)) {
      base.destroyed = true;
      this.stats.bases++;
      const bonus = 2000 * this.mult();
      this.score += bonus;
      this.say(tr(this.lang).baseDestroyed, `+${bonus}`, '#ffd34d');
      audio.play('stinger', undefined, undefined, { chord: [48, 55, 60, 64] });
      this.spawnPickup(base.x, base.y, 'repair');
      this.spawnPickup(base.x, base.y);
      this.spawnPickup(base.x, base.y);
      for (const bd of base.buildings) if (bd.alive) this.delayed.push({ t: rand(0.2, 1.2), fn: () => this.destroyProp(bd, this.player) });
    }
    this.hitStop = 0.04;
  }

  turretAt(spot) {
    return this.turrets.find((t) => t.x === spot.x && t.y === spot.y);
  }

  onAirKill(a, source) {
    this.registerKill(a.scoreValue, a.x, a.y, source, a instanceof Helicopter ? 0.6 : 0.08, a instanceof Helicopter ? 'heli' : 'drone');
    if (a instanceof Helicopter) audio.play('explosion', a.x, a.y, { size: 1.2 });
  }

  registerKill(points, x, y, source, dropChance, kind) {
    if (this.state !== 'playing') return;
    const byPlayer = source === this.player || (source && source.team === 'player') || source === null || source === undefined;
    if (!byPlayer && source && source.team === 'enemy') {
      // Friendly fire among enemies still counts toward the chaos.
    }
    this.kills++;
    this.stats.kills++;
    this.combo++;
    this.comboTimer = 3;
    this.streak++;
    this.streakTimer = 1.6;
    this.addScore(points, x, y);
    if (chance(dropChance + this.dropBonus)) this.spawnPickup(x, y);
    if (this.missilePerKill) {
      this.killsSinceMissile++;
      if (this.killsSinceMissile >= 4) {
        this.killsSinceMissile = 0;
        this.missiles += this.missilePerKill;
      }
    }
    const names = tr(this.lang).streaks;
    if (names[this.streak]) {
      this.say(names[this.streak], null, '#ff7a3a', 1.2, true);
      audio.play('powerup', undefined, undefined, { volume: 0.6 });
    }
  }

  mult() {
    return clamp(1 + Math.floor(this.combo / 3), 1, 8);
  }

  addScore(points, x, y, small = false) {
    const v = points * this.mult();
    this.score += v;
    this.floatText(x, y, `+${v}`, small ? '#9fe8ff' : '#ffe07a', small ? 0.8 : 1);
  }

  updateCombo(dt) {
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) this.combo = 0;
    this.streakTimer -= dt;
    if (this.streakTimer <= 0) this.streak = 0;
  }

  onPlayerDeath() {
    this.state = 'gameover';
    this.deathTimer = 0;
    this.input.touch.resetAll();
    this.targetTimeScale = 0.3;
    this.delayed.push({ t: 0.5, fn: () => (this.targetTimeScale = 1) });
    this.addShake(1);
    audio.play('explosion', this.player.x, this.player.y, { size: 3 });
    audio.updateEngine(0, 0, false, false);
    this.newBest = this.score > this.best;
    if (this.newBest) {
      this.best = this.score;
      try {
        localStorage.setItem('steelstorm.best', String(this.best));
      } catch {}
    }
    audio.play('stinger', undefined, undefined, { chord: [45, 48, 52, 57] });
  }

  // Called by Tank.damage via game hooks for the player only.
  playerHit(amount, source) {
    this.hurt = Math.min(1, this.hurt + amount / 25);
    this.stats.damageTaken += amount;
    const k = source ? source.kind || source.constructor.name : 'unknown';
    this.stats.bySource[k] = (this.stats.bySource[k] || 0) + amount;
    this.addShake(clamp(amount / 40, 0.1, 0.5));
  }

  // --- Wrecks, flyers, pickups --------------------------------------------------------------

  updateWreck(w, dt) {
    if (w.burn > 0) {
      w.burn -= dt;
      if (chance(0.6)) w.game.fx.flame(w.x + rand(-8, 8), w.y + rand(-8, 8), w.L / 64);
      if (chance(0.06)) this.fx.light(w.x, w.y, 90, '#ff7a2a', 0.2, 0.7);
    }
    if (w.smokeTime > 0) {
      w.smokeTime -= dt;
      if (chance(0.22)) this.fx.smoke(w.x, w.y, 1.1 * (w.L / 64), true);
    }
  }

  updateFlyers(dt) {
    for (const f of this.flyers) {
      f.vz -= 900 * dt;
      f.z += f.vz * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.vrot * dt;
      if (chance(0.5)) this.fx.smoke(f.x, f.y - f.z * 0.5, 0.5, true);
      if (f.z <= 0) {
        f.dead = true;
        this.fx.dirtHit(f.x, f.y, '#5a4a3a');
        this.fx.debris(f.x, f.y, 'metal', 4, 120, 160);
        audio.play('thud', f.x, f.y, { strength: 1 });
        this.world.stamp(f.set.wreckTurret, f.x, f.y, f.rot, 1);
        if (f.barrel) {
          const c = Math.cos(f.rot), s = Math.sin(f.rot);
          const bl = f.set.barrelLen;
          this.world.stamp(f.set.wreckBarrel, f.x + c * (bl / 2 + 8), f.y + s * (bl / 2 + 8), f.rot, 1);
        }
      }
    }
    if (this.flyers.some((f) => f.dead)) this.flyers = this.flyers.filter((f) => !f.dead);
  }

  updatePickups(dt) {
    const p = this.player;
    for (const k of this.pickups) {
      k.life -= dt;
      k.t += dt;
      k.x += k.vx * dt;
      k.y += k.vy * dt;
      k.vx *= 1 - dt * 3;
      k.vy *= 1 - dt * 3;
      if (!p || !p.alive) continue;
      const dx = p.x - k.x, dy = p.y - k.y;
      const d = Math.hypot(dx, dy);
      if (d < this.magnet) {
        const pull = (1 - d / this.magnet) * 1600 + 200;
        k.vx += (dx / d) * pull * dt;
        k.vy += (dy / d) * pull * dt;
      }
      if (d < 40) {
        k.life = 0;
        this.collect(k);
      }
    }
    this.pickups = this.pickups.filter((k) => k.life > 0);
  }

  collect(k) {
    const p = this.player;
    const info = PICKUPS[k.kind];
    this.fx.pickupBurst(k.x, k.y, info.color);
    audio.play(k.kind === 'nuke' ? 'powerup' : 'pickup');
    this.floatText(p.x, p.y - 40, tr(this.lang).pickups[k.kind] || info.label, info.color, 1.3);
    switch (k.kind) {
      case 'repair':
        p.hp = Math.min(p.maxHp, p.hp + 40);
        break;
      case 'missiles':
        this.missiles += 3;
        break;
      case 'overdrive':
        this.overdrive = 10;
        audio.play('powerup');
        break;
      case 'shield':
        p.shield = 8;
        break;
      case 'nuke':
        this.nuke(p.x, p.y);
        break;
    }
  }

  nuke(x, y) {
    this.fx.nukeBlast(x, y);
    this.addShake(1);
    this.hitStop = 0.1;
    audio.play('explosion', x, y, { size: 4 });
    this.say(tr(this.lang).nukeBanner, null, '#fff1a0', 1.5);
    const R = 1100;
    for (const ai of [...this.enemyTanks]) if (Math.hypot(ai.tank.x - x, ai.tank.y - y) < R) ai.tank.damage(9999, this.player, ai.tank.x, ai.tank.y);
    for (const a of [...this.air]) if (a.alive && Math.hypot(a.x - x, a.y - y) < R) a.damage(9999, this.player);
    for (const t of this.turrets) if (t.alive && Math.hypot(t.x - x, t.y - y) < R * 0.6) t.damage(9999, this.player);
    for (const pr of this.world.props) {
      if (pr.alive && pr.type !== 'rock' && pr.type !== 'building' && Math.hypot(pr.x - x, pr.y - y) < 450) this.destroyProp(pr, this.player);
    }
  }

  // --- Waves ------------------------------------------------------------------------------------

  updateWaves(dt) {
    if (this.waveState === 'intermission') {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) this.startWave(this.wave + 1);
      return;
    }
    if (this.waveState === 'active') {
      this.spawnTimer -= dt;
      const alive = this.enemyTanks.length + this.air.filter((a) => a.alive).length;
      if (this.spawnQueue.length && (this.spawnTimer <= 0 || alive < 2)) {
        const next = this.spawnQueue.shift();
        this.spawnEnemy(next);
        this.spawnTimer = next === 'drone' ? 0.25 : rand(1.0, 2.0) * Math.max(0.5, 1 - this.wave * 0.04);
      }
      if (!this.spawnQueue.length && alive === 0) {
        this.waveState = 'cleared';
        this.waveTimer = 1.8;
        const bonus = 500 * this.wave;
        this.score += bonus;
        const t = tr(this.lang);
        this.say(t.waveCleared(this.wave), t.waveBonus(bonus), '#7dff8a');
        audio.play('stinger', undefined, undefined, { chord: [48, 52, 55, 60] });
      }
      return;
    }
    if (this.waveState === 'cleared') {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) this.openUpgrade();
    }
  }

  startWave(n) {
    this.wave = n;
    this.waveState = 'active';
    this.difficultyHp = 1 + (n - 1) * 0.08;
    this.difficultyRate = 1 + (n - 1) * 0.05;
    this.difficultyAim = Math.max(0.35, 1.2 - n * 0.07);
    const q = [];
    const boss = n % 5 === 0;
    if (n === 1) q.push('scout', 'scout', 'scout', 'battle');
    else if (n === 2) q.push('scout', 'scout', 'battle', 'battle', 'drone', 'drone', 'drone');
    else if (n === 3) q.push('battle', 'battle', 'scout', 'scout', 'truck', 'heli', 'drone', 'drone', 'drone', 'drone');
    else {
      let budget = 6 + n * 2.6;
      const menu = [
        ['scout', 1, 1],
        ['battle', 2, 1],
        ['drone', 0.5, n >= 2 ? 1 : 0],
        ['heavy', 4, n >= 4 ? 1 : 0],
        ['truck', 3, n >= 3 ? 0.7 : 0],
        ['heli', 4, n >= 3 ? 0.6 : 0],
      ];
      if (boss) budget *= 0.45;
      while (budget > 0.4) {
        const opts = menu.filter((m) => m[2] > 0 && m[1] <= budget + 0.5);
        if (!opts.length) break;
        const tot = opts.reduce((s, m) => s + m[2], 0);
        let r = Math.random() * tot, pickd = opts[0];
        for (const m of opts) {
          r -= m[2];
          if (r <= 0) { pickd = m; break; }
        }
        if (pickd[0] === 'drone') for (let i = 0; i < randInt(3, 5); i++) q.push('drone');
        else q.push(pickd[0]);
        budget -= pickd[0] === 'drone' ? 2 : pickd[1];
      }
    }
    const t = tr(this.lang);
    if (boss) {
      q.unshift('boss');
      audio.play('alarm');
      this.say(t.wave(n), t.bossWarn, '#ff4a3a', 2.4);
    } else this.say(t.wave(n), n === 1 ? t.scoutsInbound : t.hostilesInbound(q.length), '#ffd34d', 2);
    this.spawnQueue = q;
    this.spawnTimer = 0.5;
    audio.play('stinger', undefined, undefined, { chord: boss ? [45, 48, 51, 54] : [45, 52, 57, 64] });
  }

  spawnEnemy(kind) {
    const p = this.player;
    const far = kind === 'boss' ? [900, 1100] : kind === 'heli' ? [1000, 1300] : kind === 'drone' ? [800, 1000] : [900, 1300];
    let spot = this.world.findOpenSpot(p.x, p.y, far[0], far[1]);
    if (!spot) spot = this.world.findOpenSpot(p.x, p.y, 500, 1600);
    if (!spot) return;
    const [x, y] = spot;
    if (kind === 'heli') this.air.push(new Helicopter(this, x, y));
    else if (kind === 'drone') {
      for (let i = 0; i < 1; i++) this.air.push(new Drone(this, x + rand(-30, 30), y + rand(-30, 30)));
    } else {
      const ai = makeEnemyTank(this, kind, x, y);
      ai.tank.body.angle = Math.atan2(p.y - y, p.x - x);
      ai.tank.turretAngle = ai.tank.aim = ai.tank.body.angle;
      this.enemyTanks.push(ai);
      if (kind === 'boss') this.boss = ai.tank;
    }
  }

  // --- Upgrades ------------------------------------------------------------------------------------

  openUpgrade() {
    const avail = UPGRADES.filter((u) => !u.max || (this.upgradeCounts[u.id] || 0) < u.max);
    const choices = [];
    while (choices.length < 3 && avail.length) choices.push(avail.splice(randInt(0, avail.length - 1), 1)[0]);
    this.upgradeChoices = choices;
    this.upgradeSel = 0;
    this.upgradeT = 0;
    this.state = 'upgrade';
    this.input.touch.resetAll();
    audio.play('powerup');
  }

  handleUpgradeInput() {
    const inp = this.input;
    this.upgradeT += 1 / 60;
    if (this.upgradeT < 0.4) return;
    const n = this.upgradeChoices.length;
    for (let i = 0; i < n; i++) if (inp.hit('Digit' + (i + 1))) return this.chooseUpgrade(i);
    if (inp.hit('ArrowLeft', 'KeyA') || inp.padHit(14)) this.upgradeSel = (this.upgradeSel + n - 1) % n;
    if (inp.hit('ArrowRight', 'KeyD') || inp.padHit(15)) this.upgradeSel = (this.upgradeSel + 1) % n;
    if (inp.touchTap) {
      const tapHit = HUD.upgradeHover(this, inp.touchTap.x, inp.touchTap.y);
      if (tapHit >= 0) {
        this.upgradeSel = tapHit;
        return this.chooseUpgrade(tapHit);
      }
    }
    const hover = HUD.upgradeHover(this, inp.mouseX, inp.mouseY);
    if (hover >= 0) this.upgradeSel = hover;
    if (inp.hit('Enter', 'Space') || inp.padHit(0) || (inp.mouseClicked[0] && hover >= 0)) this.chooseUpgrade(this.upgradeSel);
  }

  chooseUpgrade(i) {
    const u = this.upgradeChoices[i];
    u.apply(this.player, this);
    this.upgradeCounts[u.id] = (this.upgradeCounts[u.id] || 0) + 1;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 20);
    this.state = 'playing';
    this.input.touch.resetAll();
    this.timeScale = 1;
    this.waveState = 'intermission';
    this.waveTimer = 1.5;
    const [uname] = tr(this.lang).upgrades[u.id] || [u.name];
    this.floatText(this.player.x, this.player.y - 50, uname.toUpperCase(), '#9fe8ff', 1.4);
    audio.play('pickup');
    this.last = performance.now();
  }

  // --- Feedback ------------------------------------------------------------------------------------

  addShake(v) {
    this.shake = Math.min(1, this.shake + v);
  }

  floatText(x, y, text, color, scale = 1) {
    this.texts.push({ x, y, text, color, scale, life: 1.1, max: 1.1 });
  }

  say(text, sub, color, dur = 1.8, small = false) {
    if (small) this.announce = this.announce.filter((a) => !a.small);
    this.announce.push({ text, sub, color, life: dur, max: dur, small });
  }

  updateTexts(dt) {
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= 40 * dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
    for (const a of this.announce) a.life -= dt;
    this.announce = this.announce.filter((a) => a.life > 0);
  }

  // --- Camera ----------------------------------------------------------------------------------------

  updateCamera(dt) {
    const p = this.player;
    if (!p) return;
    const c = this.cam;
    // Lead toward aim and velocity so you see what's coming.
    const ax = (this.aimX ?? p.x) - p.x, ay = (this.aimY ?? p.y) - p.y;
    const al = Math.hypot(ax, ay) || 1;
    const lead = Math.min(al * 0.25, 220);
    const tx = p.x + (ax / al) * lead + p.body.vx * 0.35;
    const ty = p.y + (ay / al) * lead + p.body.vy * 0.35;
    const k = 1 - Math.exp(-dt * 5);
    c.x += (tx - c.x) * k;
    c.y += (ty - c.y) * k;
    // Zoom out with speed (and during boss fights).
    const sp = p.body.speed;
    const tz = this.baseZoom * (1 - clamp(sp / 650, 0, 1) * 0.16) * (this.boss && this.boss.alive ? 0.88 : 1);
    c.zoom += (tz - c.zoom) * (1 - Math.exp(-dt * 1.5));
    this.shake = Math.max(0, this.shake - dt * 1.6);
  }

  updateTitleCamera(dt) {
    const road = this.titleRoad;
    const c = this.cam;
    c.zoom = this.baseZoom * 0.9;
    if (road && road.pts.length > 2) {
      this.titleIdx = (this.titleIdx + dt * 4) % (road.pts.length - 1);
      const i = Math.floor(this.titleIdx);
      const [x, y] = road.pts[i];
      c.x += (x - c.x) * Math.min(1, dt * 0.8);
      c.y += (y - c.y) * Math.min(1, dt * 0.8);
    } else {
      c.x += dt * 30;
    }
  }

  view() {
    const z = this.cam.zoom;
    const hw = this.w / 2 / z, hh = this.h / 2 / z;
    return { x0: this.cam.x - hw, y0: this.cam.y - hh, x1: this.cam.x + hw, y1: this.cam.y + hh };
  }

  // --- Render ---------------------------------------------------------------------------------------

  render(dt) {
    this.canvas.style.cursor = this.showTouchControls && !this.input.usingTouch ? 'default' : 'none';
    const ctx = this.ctx;
    const dpr = this.dpr;
    const c = this.cam;
    const z = c.zoom * dpr;
    // Trauma-based shake (squared for punch).
    const tr = this.shake * this.shake;
    const t = performance.now() / 1000;
    const sx = (this.camNoise(t * 25, 0) - 0.5) * 2 * 26 * tr;
    const sy = (this.camNoise(0, t * 25) - 0.5) * 2 * 26 * tr;
    const tx = (this.w / 2 + sx) * dpr - c.x * z;
    const ty = (this.h / 2 + sy) * dpr - c.y * z;
    const view = this.view();
    view.x0 -= 30; view.y0 -= 30; view.x1 += 30; view.y1 += 30;

    this.world.ensureChunks(view, this.state === 'title' ? 12 : 5);
    audio.setListener(c.x, c.y, Math.max(this.w, this.h) / c.zoom * 0.6);

    ctx.setTransform(z, 0, 0, z, tx, ty);
    ctx.imageSmoothingEnabled = true;
    this.fx.setCamera(z, tx, ty);

    this.world.renderGround(ctx, view);
    this.fx.render(ctx, 0, view);
    this.world.renderLow(ctx, view);
    for (const w of this.wrecks) if (this._vis(w.x, w.y, view, 100)) w.render(ctx);
    for (const tu of this.turrets) if (this._vis(tu.x, tu.y, view, 80)) tu.render(ctx);
    this.renderPickups(ctx, view);
    for (const ai of this.enemyTanks) if (this._vis(ai.tank.x, ai.tank.y, view, 120)) ai.tank.render(ctx);
    if (this.player && this.player.alive) this.player.render(ctx);
    this.projectiles.render(ctx, view);
    const px = this.player ? this.player.x : c.x, py = this.player ? this.player.y : c.y;
    this.world.renderHigh(ctx, view, c.x, c.y, px, py);
    for (const f of this.flyers) this.renderFlyer(ctx, f);
    for (const a of this.air) if (this._vis(a.x, a.y, view, 150)) a.render(ctx);
    this.fx.render(ctx, 1, view);
    this.fx.renderLights(ctx, view);
    this.renderFloatTexts(ctx);

    // Screen-space overlays.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    HUD.drawOverlays(this, ctx);
    if (this.state === 'title') HUD.drawTitle(this, ctx);
    else {
      HUD.drawHUD(this, ctx);
      if (this.state === 'paused') HUD.drawPause(this, ctx);
      if (this.state === 'upgrade') HUD.drawUpgrade(this, ctx);
      if (this.state === 'gameover') HUD.drawGameOver(this, ctx);
    }
  }

  _vis(x, y, view, pad) {
    return x > view.x0 - pad && x < view.x1 + pad && y > view.y0 - pad && y < view.y1 + pad;
  }

  renderFlyer(ctx, f) {
    const s = 1 + f.z / 300;
    ctx.globalAlpha = 0.35;
    drawSprite(ctx, f.set.wreckTurret, f.x + f.z * 0.3, f.y + f.z * 0.45, f.rot, 1);
    ctx.globalAlpha = 1;
    const x = f.x - f.z * 0.15, y = f.y - f.z * 0.5;
    if (f.barrel) {
      const c = Math.cos(f.rot), s2 = Math.sin(f.rot);
      const bl = f.set.barrelLen;
      drawSprite(ctx, f.set.wreckBarrel, x + c * (bl / 2 + 8) * s, y + s2 * (bl / 2 + 8) * s, f.rot, s);
    }
    drawSprite(ctx, f.set.wreckTurret, x, y, f.rot, s);
  }

  renderPickups(ctx, view) {
    const sp = this.sprites;
    for (const k of this.pickups) {
      if (!this._vis(k.x, k.y, view, 40)) continue;
      if (k.life < 4 && Math.sin(k.life * 20) < 0) continue;
      const bob = Math.sin(k.t * 4) * 3;
      const col = PICKUPS[k.kind].color;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 + Math.sin(k.t * 6) * 0.2;
      drawSprite(ctx, soft(col, 64), k.x, k.y, 0, 1.1);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(k.x + 3, k.y + 8, 11, 5, 0, 0, TAU);
      ctx.fill();
      drawSprite(ctx, sp.pickups[k.kind], k.x, k.y - 4 + bob, Math.sin(k.t * 2) * 0.15);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(k.x, k.y, 22, k.t * 3, k.t * 3 + Math.PI * 1.2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  renderFloatTexts(ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of this.texts) {
      const a = Math.min(1, t.life / 0.3);
      const pop = 1 + Math.max(0, (t.life - t.max + 0.15) / 0.15) * 0.6;
      ctx.globalAlpha = a;
      ctx.font = fontSpec(this.lang, Math.round((18 * t.scale * pop) / this.cam.zoom), 'title');
      ctx.lineWidth = 4 / this.cam.zoom;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }
}
