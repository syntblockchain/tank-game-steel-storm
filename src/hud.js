// HUD, minimap, menus and screen-space overlays.

import { makeCanvas, clamp, TAU, lerp } from './util.js';
import { WORLD_W, TILE, T } from './world.js';
import { Helicopter } from './enemies.js';
import { PICKUPS } from './pickups.js';
import { getTouchLayout, drawTouchControls, drawPauseButton } from './touch.js';
import { audio } from './audio.js';
import { FONT_EN, MONO_EN, fontSpec, tr } from './i18n.js';

const FONT = FONT_EN;
const MONO = MONO_EN;
let _lang = 'en';

export function makeVignette(w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  return c;
}

const TILE_COLORS = {
  [T.DEEP]: '#1d4f6e',
  [T.SHALLOW]: '#3a7f8f',
  [T.SAND]: '#cdb27c',
  [T.GRASS]: '#5f8a3a',
  [T.FOREST]: '#3a6a2a',
  [T.DIRT]: '#8a6e4a',
  [T.ROAD]: '#4a4844',
  [T.ROCKY]: '#8a8578',
  [T.CONCRETE]: '#9a988f',
  [T.BRIDGE]: '#8a7356',
  [T.DRY]: '#a89e5a',
};

export function makeMinimap(world) {
  const c = makeCanvas(world.cols, world.rows);
  const g = c.getContext('2d');
  const img = g.createImageData(world.cols, world.rows);
  const hex = {};
  for (const [k, v] of Object.entries(TILE_COLORS)) {
    const n = parseInt(v.slice(1), 16);
    hex[k] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  for (let i = 0; i < world.tiles.length; i++) {
    const col = hex[world.tiles[i]] || [0, 0, 0];
    img.data[i * 4] = col[0];
    img.data[i * 4 + 1] = col[1];
    img.data[i * 4 + 2] = col[2];
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // Darken forests where trees are dense.
  g.fillStyle = 'rgba(20,50,20,0.5)';
  for (const p of world.props) if (p.type === 'tree' || p.type === 'pine') g.fillRect(p.x / TILE - 0.5, p.y / TILE - 0.5, 1, 1);
  g.fillStyle = '#c9c2b0';
  for (const p of world.props) if (p.type === 'building') g.fillRect((p.x - p.w / 2) / TILE, (p.y - p.h / 2) / TILE, p.w / TILE, p.h / TILE);
  return c;
}

// --- Overlays ---------------------------------------------------------------------------

export function drawOverlays(game, ctx) {
  const { w, h } = game;
  ctx.drawImage(game.vignette, 0, 0, w, h);
  const p = game.player;
  if (!p || game.state === 'title') return;
  // Speed lines while boosting.
  if (p.boosting && p.alive) {
    const t = game.time;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU + Math.sin(i * 91.7) * 0.2;
      const r0 = Math.max(w, h) * (0.42 + ((t * 2.5 + i * 0.37) % 1) * 0.3);
      const r1 = r0 + 60 + (i % 3) * 30;
      ctx.moveTo(w / 2 + Math.cos(a) * r0, h / 2 + Math.sin(a) * r0);
      ctx.lineTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1);
    }
    ctx.stroke();
  }
  // Damage flash and low-health pulse.
  const low = p.alive ? clamp(1 - p.hp / p.maxHp / 0.3, 0, 1) : 0;
  const pulse = low * (0.35 + 0.25 * Math.sin(game.time * 7));
  const a = Math.max(game.hurt * 0.6, pulse);
  if (a > 0.01) {
    const grd = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
    grd.addColorStop(0, 'rgba(200,0,0,0)');
    grd.addColorStop(1, `rgba(200,0,0,${a})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
  }
  if (game.overdrive > 0) {
    ctx.strokeStyle = `rgba(190,110,255,${0.25 + Math.sin(game.time * 10) * 0.1})`;
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, w - 8, h - 8);
  }
}

// --- HUD ----------------------------------------------------------------------------------

function panel(ctx, x, y, w, h, alpha = 0.55) {
  ctx.fillStyle = `rgba(10,14,12,${alpha})`;
  ctx.beginPath();
  ctx.moveTo(x + 8, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - 8);
  ctx.lineTo(x + w - 8, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(232,211,106,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function bar(ctx, x, y, w, h, frac, color, back = 'rgba(255,255,255,0.08)', segments = 0) {
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y, w * clamp(frac, 0, 1), h * 0.35);
  if (segments) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let i = 1; i < segments; i++) ctx.fillRect(x + (w * i) / segments - 1, y, 2, h);
  }
}

function text(ctx, s, x, y, size, color, align = 'left', font = FONT, stroke = true) {
  if (_lang === 'vi' && (font === FONT || font === MONO)) {
    ctx.font = fontSpec('vi', size, font === MONO ? 'mono' : 'ui');
  } else {
    ctx.font = `${size}px ${font}`;
  }
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (stroke) {
    ctx.lineWidth = Math.max(2, size / 7);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function drawStatusPanel(game, ctx, p, px, py, pw, ph, s) {
  const t = tr(game.lang);
  panel(ctx, px, py, pw, ph);
  const hpf = p.hp / p.maxHp;
  const hpCol = hpf > 0.5 ? '#7dd35a' : hpf > 0.25 ? '#f1c40f' : '#ff4a3a';
  const pad = Math.round(10 * s);
  const labelW = Math.round(48 * s);
  text(ctx, t.armour, px + pad, py + 14 * s, 11 * s, '#e8d36a');
  text(ctx, `${Math.ceil(p.hp)}/${p.maxHp}`, px + pw - pad, py + 14 * s, 11 * s, '#fff', 'right', MONO);
  bar(ctx, px + pad, py + 23 * s, pw - pad * 2, 12 * s, hpf, hpCol, 'rgba(255,255,255,0.08)', Math.min(30, Math.round(p.maxHp / 25)));
  text(ctx, t.boost, px + pad, py + 45 * s, 10 * s, '#9fe8ff');
  bar(ctx, px + pad + labelW, py + 41 * s, pw - pad * 2 - labelW, 8 * s, p.boostEnergy, p.boosting ? '#ffffff' : '#4fc3f7');
  text(ctx, t.coax, px + pad, py + 59 * s, 10 * s, p.overheated ? '#ff4a3a' : '#ffb347');
  bar(ctx, px + pad + labelW, py + 55 * s, pw - pad * 2 - labelW, 8 * s, p.mgHeat, p.overheated ? (Math.sin(game.time * 20) > 0 ? '#ff4a3a' : '#7a1a10') : '#ff8a3a');
  text(ctx, t.msl, px + pad, py + 77 * s, 10 * s, '#e67e22');
  const maxFit = Math.max(4, Math.floor((pw - pad * 2 - labelW - 20 * s) / (9.5 * s)));
  const mcount = Math.min(game.missiles, maxFit);
  for (let i = 0; i < mcount; i++) {
    const mx = px + pad + labelW + i * 9.5 * s;
    ctx.fillStyle = '#e67e22';
    ctx.fillRect(mx, py + 71 * s, 5.5 * s, 11 * s);
    ctx.fillStyle = '#fff';
    ctx.fillRect(mx, py + 71 * s, 5.5 * s, 3 * s);
  }
  if (game.missiles > maxFit) text(ctx, `+${game.missiles - maxFit}`, px + pad + labelW + maxFit * 9.5 * s, py + 77 * s, 10 * s, '#e67e22');
  if (game.missiles === 0) text(ctx, t.empty, px + pad + labelW, py + 77 * s, 10 * s, 'rgba(255,255,255,0.35)');

  let ey = py + ph + 8 * s;
  const effect = (label, timeLeft, max, col) => {
    const ew = pw * 0.85;
    panel(ctx, px, ey, ew, 20 * s, 0.45);
    text(ctx, label, px + 8 * s, ey + 10 * s, 10 * s, col);
    bar(ctx, px + 84 * s, ey + 6 * s, ew - 92 * s, 7 * s, timeLeft / max, col);
    ey += 25 * s;
  };
  if (game.overdrive > 0) effect(t.overdrive, game.overdrive, 10, '#c77dff');
  if (p.shield > 0) effect(t.shield, p.shield, 8, '#7ad7ff');
}

export function drawHUD(game, ctx) {
  _lang = game.lang || 'en';
  const t = tr(_lang);
  const p = game.player;
  if (!p) return;
  const { w, h } = game;

  if (game.showTouchControls) {
    drawTouchHUD(game, ctx, p);
    return;
  }

  const s = clamp(Math.min(w / 1400, h / 850), 0.7, 1.25);

  // --- Status panel (top-left) ---
  const px = 16, py = 16, pw = 270 * s, ph = 112 * s;
  panel(ctx, px, py, pw, ph);
  const hpf = p.hp / p.maxHp;
  const hpCol = hpf > 0.5 ? '#7dd35a' : hpf > 0.25 ? '#f1c40f' : '#ff4a3a';
  text(ctx, t.armour, px + 12 * s, py + 16 * s, 12 * s, '#e8d36a');
  text(ctx, `${Math.ceil(p.hp)}/${p.maxHp}`, px + pw - 12 * s, py + 16 * s, 12 * s, '#fff', 'right', MONO);
  bar(ctx, px + 12 * s, py + 26 * s, pw - 24 * s, 14 * s, hpf, hpCol, 'rgba(255,255,255,0.08)', Math.min(30, Math.round(p.maxHp / 25)));
  text(ctx, t.boost, px + 12 * s, py + 52 * s, 11 * s, '#9fe8ff');
  bar(ctx, px + 60 * s, py + 47 * s, pw - 72 * s, 9 * s, p.boostEnergy, p.boosting ? '#ffffff' : '#4fc3f7');
  text(ctx, t.coax, px + 12 * s, py + 68 * s, 11 * s, p.overheated ? '#ff4a3a' : '#ffb347');
  bar(ctx, px + 60 * s, py + 63 * s, pw - 72 * s, 9 * s, p.mgHeat, p.overheated ? (Math.sin(game.time * 20) > 0 ? '#ff4a3a' : '#7a1a10') : '#ff8a3a');
  // Missiles
  text(ctx, t.msl, px + 12 * s, py + 88 * s, 11 * s, '#e67e22');
  const mcount = Math.min(game.missiles, 16);
  for (let i = 0; i < mcount; i++) {
    const mx = px + 60 * s + i * 11 * s;
    ctx.fillStyle = '#e67e22';
    ctx.fillRect(mx, py + 82 * s, 6 * s, 12 * s);
    ctx.fillStyle = '#fff';
    ctx.fillRect(mx, py + 82 * s, 6 * s, 3 * s);
  }
  if (game.missiles > 16) text(ctx, `+${game.missiles - 16}`, px + 60 * s + 16 * 11 * s, py + 88 * s, 11 * s, '#e67e22');
  if (game.missiles === 0) text(ctx, t.empty, px + 60 * s, py + 88 * s, 11 * s, 'rgba(255,255,255,0.35)');
  // Timed effects
  let ey = py + ph + 10 * s;
  const effect = (label, timeLeft, max, col) => {
    panel(ctx, px, ey, pw * 0.75, 22 * s, 0.45);
    text(ctx, label, px + 10 * s, ey + 11 * s, 11 * s, col);
    bar(ctx, px + 100 * s, ey + 7 * s, pw * 0.75 - 110 * s, 8 * s, timeLeft / max, col);
    ey += 28 * s;
  };
  if (game.overdrive > 0) effect(t.overdrive, game.overdrive, 10, '#c77dff');
  if (p.shield > 0) effect(t.shield, p.shield, 8, '#7ad7ff');

  // --- Score (top-right) ---
  const sx = w - 16;
  text(ctx, game.score.toLocaleString(), sx, 34 * s, 34 * s, '#ffffff', 'right');
  text(ctx, t.bestHud(Math.max(game.best, game.score).toLocaleString()), sx, 62 * s, 12 * s, 'rgba(255,255,255,0.6)', 'right', MONO);
  const mult = game.mult();
  if (game.combo > 0) {
    const pop = 1 + Math.max(0, game.comboTimer - 2.7) * 1.5;
    text(ctx, `x${mult}`, sx, 92 * s, 28 * s * pop, mult >= 4 ? '#ff7a3a' : '#ffd34d', 'right');
    text(ctx, t.combo(game.combo), sx - 60 * s, 92 * s, 12 * s, 'rgba(255,255,255,0.75)', 'right');
    bar(ctx, sx - 140 * s, 108 * s, 140 * s, 4 * s, game.comboTimer / 3, '#ffd34d');
  }

  // --- Wave (top-centre) ---
  if (game.wave > 0) {
    const remaining = game.enemyTanks.length + game.air.filter((a) => a.alive).length + game.spawnQueue.length;
    text(ctx, t.wave(game.wave), w / 2, 24 * s, 20 * s, '#e8d36a', 'center');
    if (game.waveState === 'active') text(ctx, t.hostiles(remaining), w / 2, 46 * s, 11 * s, 'rgba(255,255,255,0.7)', 'center', MONO);
  }
  // Boss bar
  if (game.boss && game.boss.alive) {
    const bw = Math.min(600, w * 0.5), bx = w / 2 - bw / 2, by = 64 * s;
    panel(ctx, bx - 10, by - 6, bw + 20, 34 * s, 0.6);
    text(ctx, t.behemoth, w / 2, by + 6 * s, 12 * s, '#ff4a3a', 'center');
    bar(ctx, bx, by + 14 * s, bw, 10 * s, game.boss.hp / game.boss.maxHp, '#ff3b30', 'rgba(255,255,255,0.08)', 10);
  }

  drawOffscreenArrows(game, ctx);
  const size = Math.round(170 * s);
  drawMinimapAt(game, ctx, w - size - 16, h - size - 16, size);
  drawAnnouncements(game, ctx, s);
  if (game.state === 'playing') drawCrosshair(game, ctx);

  // Control hints for the first seconds.
  if (game.time < 12 && game.state === 'playing') {
    const a = clamp((12 - game.time) / 2, 0, 1);
    ctx.globalAlpha = a;
    const lines = game.input.usingGamepad ? t.hintsGamepad : t.hintsDesktop(game.controlMode === 'arcade');
    lines.forEach((l, i) => text(ctx, l, 20, h - 70 + i * 20, 13, 'rgba(255,255,255,0.85)', 'left', MONO));
    ctx.globalAlpha = 1;
  }
}

function drawTouchHUD(game, ctx, p) {
  const t = tr(game.lang);
  const { w } = game;
  const layout = getTouchLayout(w, game.h, game.insets);
  const s = layout.s;

  // Status panel (top-left) + Pause button
  const st = layout.status;
  drawStatusPanel(game, ctx, p, st.x, st.y, st.w, st.h, clamp(st.w / 212, 0.72, 1.05));
  drawPauseButton(ctx, layout.pause);

  // Minimap (top-right, clear of bottom joysticks)
  const mm = layout.minimap;
  drawMinimapAt(game, ctx, mm.x, mm.y, mm.size);

  // Score (next to minimap in landscape, or under minimap in narrow portrait)
  const sx = layout.narrow ? mm.x + mm.size : mm.x - 14;
  let sy = layout.narrow ? mm.y + mm.size + 18 : layout.padT + 14;
  const scoreSize = layout.narrow ? 22 : Math.round(26 * s);
  text(ctx, game.score.toLocaleString(), sx, sy, scoreSize, '#ffffff', 'right');
  text(ctx, t.bestHud(Math.max(game.best, game.score).toLocaleString()), sx, sy + scoreSize * 0.85, Math.round(scoreSize * 0.44), 'rgba(255,255,255,0.6)', 'right', MONO);
  const mult = game.mult();
  if (game.combo > 0) {
    const cy = sy + scoreSize * 1.7;
    const pop = 1 + Math.max(0, game.comboTimer - 2.7) * 1.5;
    text(ctx, `x${mult}`, sx, cy, Math.round(22 * s * pop), mult >= 4 ? '#ff7a3a' : '#ffd34d', 'right');
    text(ctx, t.combo(game.combo), sx - 44 * s, cy, Math.round(10 * s), 'rgba(255,255,255,0.75)', 'right');
    bar(ctx, sx - 105 * s, cy + 12 * s, 105 * s, 3.5, game.comboTimer / 3, '#ffd34d');
  }

  // Wave + Boss bar (top-center)
  let wy = layout.narrow ? layout.pause.y + layout.pause.h + 14 : layout.padT + 12;
  if (game.wave > 0) {
    const remaining = game.enemyTanks.length + game.air.filter((a) => a.alive).length + game.spawnQueue.length;
    text(ctx, t.wave(game.wave), w / 2, wy, Math.round(17 * s), '#e8d36a', 'center');
    if (game.waveState === 'active') text(ctx, t.hostiles(remaining), w / 2, wy + 17 * s, Math.round(10 * s), 'rgba(255,255,255,0.7)', 'center', MONO);
    wy += 32 * s;
  }
  if (game.boss && game.boss.alive) {
    const bw = layout.narrow ? Math.min(220, w * 0.42) : Math.min(400, w * 0.34);
    const bx = w / 2 - bw / 2;
    const by = wy;
    panel(ctx, bx - 8, by - 4, bw + 16, 28 * s, 0.6);
    text(ctx, t.behemoth, w / 2, by + 5 * s, Math.round(10 * s), '#ff4a3a', 'center');
    bar(ctx, bx, by + 13 * s, bw, 8 * s, game.boss.hp / game.boss.maxHp, '#ff3b30', 'rgba(255,255,255,0.08)', 10);
  }

  drawOffscreenArrows(game, ctx);
  drawAnnouncements(game, ctx, clamp(s, 0.65, 1.05));
  if (game.state === 'playing') drawCrosshair(game, ctx);
  drawTouchControls(game, ctx);
}

function drawCrosshair(game, ctx) {
  const p = game.player;
  if (!p || !p.alive) return;
  const worldAim =
    game.input.usingGamepad ||
    game.input.usingTouch ||
    game.input.touch.right.active ||
    game.input.touch.mg.active;
  const [x, y] = worldAim ? game.worldToScreen(game.aimX, game.aimY) : [game.input.mouseX, game.input.mouseY];
  const reload = clamp(1 - p.cooldown / (p.spec.reload * p.mods.reload * (p.overdrive ? 0.45 : 1)), 0, 1);
  const ready = reload >= 1;
  ctx.lineWidth = 2;
  ctx.strokeStyle = ready ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)';
  const r = 14;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    ctx.moveTo(x + Math.cos(a) * (r - 6), y + Math.sin(a) * (r - 6));
    ctx.lineTo(x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4));
  }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 1, y - 1, 2, 2);
  // Reload arc
  ctx.strokeStyle = ready ? '#e8d36a' : '#ff8a3a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * reload);
  ctx.stroke();
  // Line from turret direction: where the gun actually points.
  const [mx, my] = game.worldToScreen(...p.muzzle());
  const ta = p.turretAngle;
  const dist = Math.hypot(x - mx, y - my);
  ctx.strokeStyle = 'rgba(255,230,150,0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(mx + Math.cos(ta) * dist, my + Math.sin(ta) * dist);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOffscreenArrows(game, ctx) {
  const { w, h } = game;
  const margin = 28;
  const targets = [];
  for (const ai of game.enemyTanks) targets.push([ai.tank.x, ai.tank.y, ai.tank.kind === 'boss' ? '#ff2a1a' : '#ff5a3a', ai.tank.kind === 'boss' ? 1.6 : 1]);
  for (const a of game.air) if (a.alive && a instanceof Helicopter) targets.push([a.x, a.y, '#ff9a3a', 1.1]);
  for (const t of targets) {
    const [sx, sy] = game.worldToScreen(t[0], t[1]);
    if (sx > 0 && sx < w && sy > 0 && sy < h) continue;
    const dx = sx - w / 2, dy = sy - h / 2;
    const k = Math.min((w / 2 - margin) / Math.abs(dx || 1e-6), (h / 2 - margin) / Math.abs(dy || 1e-6));
    const ax = w / 2 + dx * k, ay = h / 2 + dy * k;
    const ang = Math.atan2(dy, dx);
    const d = Math.hypot(t[0] - game.player.x, t[1] - game.player.y);
    const sc = clamp(1.4 - d / 2000, 0.6, 1.3) * t[3];
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = t[2];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(12 * sc, 0);
    ctx.lineTo(-8 * sc, -8 * sc);
    ctx.lineTo(-4 * sc, 0);
    ctx.lineTo(-8 * sc, 8 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

function drawMinimapAt(game, ctx, x, y, size) {
  ctx.save();
  panel(ctx, x - 6, y - 6, size + 12, size + 12, 0.6);
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.globalAlpha = 0.9;
  ctx.drawImage(game.minimap, x, y, size, size);
  ctx.globalAlpha = 1;
  const k = size / WORLD_W;
  // Bases
  for (const b of game.world.bases) {
    ctx.strokeStyle = b.destroyed ? 'rgba(120,120,120,0.8)' : '#ff4a3a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + (b.x - b.w / 2) * k, y + (b.y - b.h / 2) * k, b.w * k, b.h * k);
  }
  ctx.fillStyle = '#ff6a5a';
  for (const t of game.turrets) if (t.alive) ctx.fillRect(x + t.x * k - 1.5, y + t.y * k - 1.5, 3, 3);
  // Enemies
  const blink = Math.sin(game.time * 8) > 0;
  for (const ai of game.enemyTanks) {
    ctx.fillStyle = ai.tank.kind === 'boss' ? (blink ? '#fff' : '#ff2a1a') : '#ff3b30';
    const r = ai.tank.kind === 'boss' ? 4 : 2.2;
    ctx.beginPath();
    ctx.arc(x + ai.tank.x * k, y + ai.tank.y * k, r, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = '#ffb347';
  for (const a of game.air) if (a.alive) ctx.fillRect(x + a.x * k - 1.5, y + a.y * k - 1.5, 3, 3);
  for (const pk of game.pickups) {
    ctx.fillStyle = PICKUPS[pk.kind].color;
    ctx.fillRect(x + pk.x * k - 1.5, y + pk.y * k - 1.5, 3, 3);
  }
  // View rectangle
  const v = game.view();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + v.x0 * k, y + v.y0 * k, (v.x1 - v.x0) * k, (v.y1 - v.y0) * k);
  // Player
  const p = game.player;
  if (p) {
    ctx.save();
    ctx.translate(x + p.x * k, y + p.y * k);
    ctx.rotate(p.angle);
    ctx.fillStyle = '#e8d36a';
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawAnnouncements(game, ctx, s) {
  const { w, h } = game;
  let y = h * 0.28;
  for (const a of game.announce) {
    const t = 1 - a.life / a.max;
    const inT = clamp(t / 0.12, 0, 1);
    const outA = clamp(a.life / 0.4, 0, 1);
    const scale = a.small ? 1 : lerp(1.8, 1, 1 - (1 - inT) ** 3);
    ctx.globalAlpha = outA * inT;
    let size = (a.small ? 30 : 54) * s * scale;
    ctx.font = fontSpec(_lang, size, 'ui');
    const aw = ctx.measureText(a.text).width;
    if (aw > w * 0.88) size *= (w * 0.88) / aw;
    // Slanted backing strip
    if (!a.small) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      const bw = w * 0.6 * inT;
      ctx.moveTo(w / 2 - bw / 2 - 20, y - size * 0.7);
      ctx.lineTo(w / 2 + bw / 2 + 20, y - size * 0.7);
      ctx.lineTo(w / 2 + bw / 2, y + size * (a.sub ? 1.2 : 0.7));
      ctx.lineTo(w / 2 - bw / 2 - 40, y + size * (a.sub ? 1.2 : 0.7));
      ctx.closePath();
      ctx.fill();
    }
    text(ctx, a.text, w / 2, y, size, a.color, 'center');
    if (a.sub) {
      let subSz = 16 * s;
      ctx.font = fontSpec(_lang, subSz, 'mono');
      const sw = ctx.measureText(a.sub).width;
      if (sw > w * 0.88) subSz *= (w * 0.88) / sw;
      text(ctx, a.sub, w / 2, y + size * 0.75, subSz, 'rgba(255,255,255,0.9)', 'center', MONO);
    }
    y += size * (a.sub ? 1.9 : 1.3);
  }
  ctx.globalAlpha = 1;
}

// --- Screens --------------------------------------------------------------------------------

function titleText(ctx, s, x, y, size, forceEn = false) {
  ctx.font = forceEn ? `${size}px ${FONT_EN}` : fontSpec(_lang, size, 'title');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size / 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(s, x, y + size * 0.06);
  const grd = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
  grd.addColorStop(0, '#fff6d0');
  grd.addColorStop(0.45, '#e8d36a');
  grd.addColorStop(0.55, '#b8862a');
  grd.addColorStop(1, '#ffdd88');
  ctx.fillStyle = grd;
  ctx.fillText(s, x, y);
}

function fitTitleSize(ctx, str, size, maxW) {
  ctx.font = fontSpec(_lang, size, 'title');
  const tw = ctx.measureText(str).width;
  return tw > maxW ? size * (maxW / tw) : size;
}

function wrapText(ctx, str, maxW) {
  const words = str.split(' ');
  const lines = [];
  let line = '';
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = wd;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function titleLangToggleRect(game) {
  const ins = game.insets || { top: 0, left: 0 };
  const bw = game.w < 500 ? 104 : 124;
  return {
    x: Math.max(14, ins.left + 8),
    y: Math.max(14, ins.top + 8),
    w: bw,
    h: 30,
  };
}

export function titleLangToggleHit(game, mx, my) {
  const r = titleLangToggleRect(game);
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

export function titleTouchToggleRect(game) {
  const ins = game.insets || { top: 0, right: 0 };
  const bw = game.w < 500 ? 156 : 194;
  const bh = 30;
  return {
    x: game.w - bw - Math.max(14, ins.right + 8),
    y: Math.max(14, ins.top + 8),
    w: bw,
    h: bh,
  };
}

export function titleTouchToggleHit(game, mx, my) {
  const r = titleTouchToggleRect(game);
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

export function drawTitle(game, ctx) {
  _lang = game.lang || 'en';
  const trn = tr(_lang);
  const { w, h } = game;
  const s = clamp(Math.min(w / 1300, h / 800), 0.52, 1.4);
  ctx.fillStyle = 'rgba(5,8,6,0.35)';
  ctx.fillRect(0, 0, w, h);

  // Language toggle pill (top-left)
  const lr = titleLangToggleRect(game);
  panel(ctx, lr.x, lr.y, lr.w, lr.h, 0.58);
  const halfW = lr.w / 2;
  const activeX = _lang === 'en' ? lr.x + 2 : lr.x + halfW + 1;
  ctx.fillStyle = 'rgba(232,211,106,0.22)';
  ctx.fillRect(activeX, lr.y + 2, halfW - 3, lr.h - 4);
  ctx.strokeStyle = 'rgba(232,211,106,0.65)';
  ctx.lineWidth = 1;
  ctx.strokeRect(activeX, lr.y + 2, halfW - 3, lr.h - 4);
  const pillFontSz = w < 500 ? 10 : 11;
  ctx.font = `${pillFontSz}px ${MONO_EN}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = _lang === 'en' ? '#e8d36a' : 'rgba(255,255,255,0.55)';
  ctx.fillText('EN', lr.x + halfW * 0.5, lr.y + lr.h / 2);
  ctx.font = fontSpec('vi', pillFontSz, 'ui');
  ctx.fillStyle = _lang === 'vi' ? '#e8d36a' : 'rgba(255,255,255,0.55)';
  ctx.fillText('VIỆT', lr.x + halfW * 1.5, lr.y + lr.h / 2);

  // Small touch-UI mode pill in top-right corner
  const trRect = titleTouchToggleRect(game);
  panel(ctx, trRect.x, trRect.y, trRect.w, trRect.h, 0.55);
  text(ctx, trn.joyPill(trn.touchModes[game.touchUiMode]), trRect.x + trRect.w / 2, trRect.y + trRect.h / 2, w < 500 ? 10 : 11, '#e8d36a', 'center', MONO, false);

  const t = game.titleT;
  const bob = Math.sin(t * 1.5) * 4;

  // Scale main title to always fit screen width
  let titleSize = 110 * s;
  ctx.font = `${titleSize}px ${FONT_EN}`;
  const titleW = ctx.measureText('STEEL STORM').width;
  if (titleW > w * 0.88) titleSize *= (w * 0.88) / titleW;

  const titleY = h * (h < 500 ? 0.25 : 0.28) + bob;
  titleText(ctx, 'STEEL STORM', w / 2, titleY, titleSize, true);

  const sub = w < 480 ? trn.titleSubCompact : trn.titleSubWide;
  let subSize = 15 * s;
  ctx.font = fontSpec(_lang, subSize, 'mono');
  const subW = ctx.measureText(sub).width;
  if (subW > w * 0.9) subSize *= (w * 0.9) / subW;
  text(ctx, sub, w / 2, titleY + titleSize * 0.7, subSize, 'rgba(255,255,255,0.8)', 'center', MONO);

  const blink = Math.sin(t * 4) > -0.3;
  const promptY = h * (h < 500 ? 0.45 : 0.49);
  if (blink) {
    const prompt = game.showTouchControls ? trn.deployTouch : trn.deployDesktop;
    let promptSize = clamp(24 * s, 17, 28);
    ctx.font = fontSpec(_lang, promptSize, 'ui');
    const pw0 = ctx.measureText(prompt).width;
    if (pw0 > w * 0.9) promptSize *= (w * 0.9) / pw0;
    text(ctx, prompt, w / 2, promptY, promptSize, '#ffffff', 'center');
  }

  const rows = game.showTouchControls
    ? trn.touchRows
    : trn.desktopRows(trn.controlModes[game.controlMode], game.controlMode === 'arcade');

  const compact = w < 640;
  const fontSize = compact ? clamp(w * 0.03, 10.5, 12.5) : clamp(13 * s, 10.5, 14);
  const labelSize = compact ? clamp(w * 0.031, 10.5, 13) : clamp(13 * s, 10.5, 14);
  const keyColW = compact ? 108 : Math.max(124, 145 * s);
  ctx.font = fontSpec(_lang, fontSize, 'mono');
  const maxTextW = Math.max(...rows.map(([, v]) => ctx.measureText(v).width));
  const cw = compact ? Math.min(w - 24, 460) : clamp(Math.max(560 * s, keyColW + maxTextW + 32 * s), 340, w - 32);
  const descMaxW = cw - keyColW - 26;

  const wrappedRows = rows.map(([k, v]) => [k, wrapText(ctx, v, descMaxW)]);
  const lineH = fontSize * 1.38;
  const rowHeights = wrappedRows.map(([, lines]) => Math.max(lineH * 1.45, lines.length * lineH + 10));
  const totalRowH = rowHeights.reduce((a, b) => a + b, 0);
  const ch = totalRowH + 22;
  const cx = w / 2 - cw / 2;
  const cy = clamp(promptY + 26, h * 0.53, h - ch - (game.best > 0 ? 44 : 18));

  panel(ctx, cx, cy, cw, ch, 0.6);
  let ry = cy + 16;
  wrappedRows.forEach(([k, lines], i) => {
    const padX = compact ? 14 : 20 * s;
    text(ctx, k, cx + padX, ry + lineH * 0.45, labelSize, '#e8d36a', 'left', FONT);
    lines.forEach((ln, li) => {
      text(ctx, ln, cx + keyColW, ry + (0.45 + li) * lineH, fontSize, 'rgba(255,255,255,0.88)', 'left', MONO, false);
    });
    ry += rowHeights[i];
  });

  if (game.best > 0) text(ctx, trn.bestScore(game.best.toLocaleString()), w / 2, cy + ch + 22, clamp(15 * s, 12, 16), '#ffd34d', 'center', MONO);
}

export function pauseButtons(game) {
  const { w, h } = game;
  const t = tr(game.lang);
  const bw = clamp(w * 0.68, 224, 300);
  const bh = clamp(h * 0.068, 32, 44);
  const gap = 8;
  const items = [
    { id: 'resume', label: t.resume },
    { id: 'music', label: audio.musicOn ? t.musicOn : t.musicOff },
    { id: 'touch', label: t.joysticksBtn(t.touchModes[game.touchUiMode]) },
  ];
  if (!game.showTouchControls) items.push({ id: 'controls', label: t.controlsBtn(t.controlModes[game.controlMode]) });
  items.push({ id: 'lang', label: t.langBtn });
  items.push({ id: 'quit', label: t.quitTitle });

  const totalH = items.length * bh + (items.length - 1) * gap;
  const x = w / 2 - bw / 2;
  const y0 = clamp(h / 2 - totalH / 2 + 28, Math.max(88, h * 0.24), h - totalH - 14);
  return items.map((it, i) => ({
    ...it,
    x,
    y: y0 + i * (bh + gap),
    w: bw,
    h: bh,
  }));
}

export function pauseButtonHit(game, mx, my) {
  const btns = pauseButtons(game);
  const hit = btns.find((b) => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
  return hit ? hit.id : null;
}

export function drawPause(game, ctx) {
  _lang = game.lang || 'en';
  const t = tr(_lang);
  const { w, h } = game;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, w, h);
  const btns = pauseButtons(game);
  const titleY = Math.max(42, btns[0].y - 44);
  const titleSize = fitTitleSize(ctx, t.paused, clamp(Math.min(w / 8, h / 8), 38, 76), w * 0.88);
  titleText(ctx, t.paused, w / 2, titleY, titleSize);

  for (const b of btns) {
    const hover = !game.input.usingTouch && game.input.mouseX >= b.x && game.input.mouseX <= b.x + b.w && game.input.mouseY >= b.y && game.input.mouseY <= b.y + b.h;
    panel(ctx, b.x, b.y, b.w, b.h, hover ? 0.85 : 0.65);
    if (hover) {
      ctx.strokeStyle = '#e8d36a';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const color = b.id === 'quit' ? '#ffb347' : b.id === 'resume' ? '#e8d36a' : '#ffffff';
    text(ctx, b.label, b.x + b.w / 2, b.y + b.h / 2, clamp(b.h * 0.36, 12, 16), color, 'center', FONT, false);
  }
}

const CARD_W = 250, CARD_H = 300, CARD_GAP = 30;

function cardRects(game) {
  const n = game.upgradeChoices.length;
  if (game.w < 600) {
    const cw = Math.min(game.w - 28, 390);
    const gap = 12;
    const availH = game.h - 138;
    const ch = clamp(Math.floor((availH - (n - 1) * gap) / n), 86, 128);
    const total = n * ch + (n - 1) * gap;
    const x0 = game.w / 2 - cw / 2;
    const y0 = Math.max(96, game.h / 2 - total / 2 + 28);
    return { stacked: true, s: clamp(ch / 110, 0.78, 1.15), rects: game.upgradeChoices.map((_, i) => [x0, y0 + i * (ch + gap), cw, ch]) };
  }
  const s = clamp(Math.min(game.w / 1100, game.h / 660), 0.48, 1.3);
  const cw = CARD_W * s, ch = CARD_H * s, gap = CARD_GAP * s;
  const total = n * cw + (n - 1) * gap;
  const x0 = game.w / 2 - total / 2, y0 = game.h / 2 - ch / 2 + 30 * s;
  return { stacked: false, s, rects: game.upgradeChoices.map((_, i) => [x0 + i * (cw + gap), y0, cw, ch]) };
}

export function upgradeHover(game, mx, my) {
  if (!game.upgradeChoices) return -1;
  const { rects } = cardRects(game);
  return rects.findIndex(([x, y, w, h]) => mx >= x && mx <= x + w && my >= y && my <= y + h);
}

export function drawUpgrade(game, ctx) {
  _lang = game.lang || 'en';
  const trn = tr(_lang);
  const { w, h } = game;
  const t = game.upgradeT;
  const fade = clamp(t / 0.3, 0, 1);
  ctx.fillStyle = `rgba(4,8,6,${0.65 * fade})`;
  ctx.fillRect(0, 0, w, h);
  const { stacked, s, rects } = cardRects(game);
  ctx.globalAlpha = fade;
  const rawHeadSize = stacked ? clamp(w * 0.085, 24, 38) : 52 * s;
  const headSize = fitTitleSize(ctx, trn.fieldUpgrade, rawHeadSize, w * 0.9);
  const topY = rects[0][1];
  titleText(ctx, trn.fieldUpgrade, w / 2, Math.max(36, topY - (stacked ? 54 : 70 * s)), headSize);
  const subLabel = game.showTouchControls ? trn.upgradeSubTouch : trn.upgradeSubDesktop;
  text(ctx, subLabel, w / 2, Math.max(66, topY - (stacked ? 22 : 28 * s)), stacked ? 12 : 14 * s, 'rgba(255,255,255,0.75)', 'center', MONO);

  game.upgradeChoices.forEach((u, i) => {
    const [x, y0, cw, ch] = rects[i];
    const appear = clamp((t - i * 0.08) / 0.25, 0, 1);
    const y = y0 + (1 - appear) * 50;
    const sel = !game.input.usingTouch && i === game.upgradeSel;
    ctx.globalAlpha = fade * appear;
    ctx.save();
    if (sel) {
      ctx.shadowColor = 'rgba(232,211,106,0.7)';
      ctx.shadowBlur = 24;
    }
    const grd = ctx.createLinearGradient(0, y, 0, y + ch);
    grd.addColorStop(0, sel ? '#3a3a24' : '#22261f');
    grd.addColorStop(1, '#121510');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(x + 14, y);
    ctx.lineTo(x + cw, y);
    ctx.lineTo(x + cw, y + ch - 14);
    ctx.lineTo(x + cw - 14, y + ch);
    ctx.lineTo(x, y + ch);
    ctx.lineTo(x, y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = sel ? '#e8d36a' : 'rgba(232,211,106,0.38)';
    ctx.lineWidth = sel ? 3 : 1.5;
    ctx.stroke();

    const count = game.upgradeCounts[u.id] || 0;
    const [uName, uDesc] = trn.upgrades[u.id] || [u.name, u.desc];

    if (stacked) {
      const r = clamp(ch * 0.32, 24, 38);
      const icx = x + 16 + r;
      const icy = y + ch / 2;
      ctx.fillStyle = sel ? 'rgba(232,211,106,0.18)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.arc(icx, icy, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(232,211,106,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      text(ctx, u.icon, icx, icy + 1, r * 0.95, '#e8d36a', 'center', 'system-ui, sans-serif', false);

      const tx = icx + r + 14;
      const tw = x + cw - tx - 14;
      const nameSz = clamp(15 * s, 13, 18);
      text(ctx, uName.toUpperCase(), tx, y + ch * 0.28, nameSz, '#ffffff', 'left');
      const descSz = clamp(12 * s, 11, 13);
      ctx.font = fontSpec(_lang, descSz, 'mono');
      const lines = wrapText(ctx, uDesc, tw);
      lines.forEach((ln, li) => text(ctx, ln, tx, y + ch * 0.54 + li * 15, descSz, 'rgba(255,255,255,0.82)', 'left', MONO, false));
      if (count) text(ctx, trn.owned(count), x + cw - 14, y + ch * 0.26, 10, '#9fe8ff', 'right', MONO, false);
    } else {
      const cx = x + cw / 2, cy = y + 90 * s;
      ctx.fillStyle = sel ? 'rgba(232,211,106,0.18)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.arc(cx, cy, 50 * s, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(232,211,106,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      text(ctx, u.icon, cx, cy + 2 * s, 50 * s, '#e8d36a', 'center', 'system-ui, sans-serif', false);
      let nameSz = 18 * s;
      ctx.font = fontSpec(_lang, nameSz, 'ui');
      const nw = ctx.measureText(uName.toUpperCase()).width;
      if (nw > cw - 20 * s) nameSz *= (cw - 20 * s) / nw;
      text(ctx, uName.toUpperCase(), cx, y + 172 * s, nameSz, '#ffffff', 'center');
      const descSz = 13 * s;
      ctx.font = fontSpec(_lang, descSz, 'mono');
      const lines = wrapText(ctx, uDesc, cw - 36 * s);
      lines.forEach((l, li) => text(ctx, l, cx, y + 205 * s + li * 18 * s, descSz, 'rgba(255,255,255,0.8)', 'center', MONO, false));
      if (count) text(ctx, trn.owned(count), cx, y + ch - 42 * s, 11 * s, '#9fe8ff', 'center', MONO, false);
      if (!game.showTouchControls) text(ctx, `[${i + 1}]`, cx, y + ch - 20 * s, 14 * s, sel ? '#e8d36a' : 'rgba(255,255,255,0.4)', 'center', MONO, false);
    }
  });
  ctx.globalAlpha = 1;
}

export function gameOverTitleRect(game) {
  const s = clamp(Math.min(game.w / 1200, game.h / 800), 0.56, 1.3);
  const bw = 172;
  const bh = 36;
  const rowsH = 5 * 36 * s + 30 * s;
  const py = game.h * 0.36;
  const by = Math.min(game.h - bh - 16, py + rowsH + 102 * s);
  return { x: game.w / 2 - bw / 2, y: by, w: bw, h: bh };
}

export function gameOverTitleHit(game, mx, my) {
  const r = gameOverTitleRect(game);
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

export function drawGameOver(game, ctx) {
  _lang = game.lang || 'en';
  const trn = tr(_lang);
  const { w, h } = game;
  const t = game.deathTimer;
  const fade = clamp((t - 0.8) / 1.0, 0, 1);
  if (fade <= 0) return;
  ctx.fillStyle = `rgba(20,0,0,${0.6 * fade})`;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = fade;
  const s = clamp(Math.min(w / 1200, h / 800), 0.56, 1.3);

  const titleSize = fitTitleSize(ctx, trn.tankDestroyed, 76 * s, w * 0.88);
  titleText(ctx, trn.tankDestroyed, w / 2, h * 0.24, titleSize);

  const st = game.stats;
  const mins = Math.floor(st.time / 60), secs = Math.floor(st.time % 60).toString().padStart(2, '0');
  const vals = [game.score.toLocaleString(), String(game.wave), String(st.kills), String(st.bases), `${mins}:${secs}`];
  const rows = trn.statsLabels.map((k, i) => [k, vals[i]]);
  const pw = Math.min(w - 28, 440 * s), ph = rows.length * 36 * s + 30 * s;
  const px = w / 2 - pw / 2, py = h * 0.36;
  panel(ctx, px, py, pw, ph, 0.7);
  rows.forEach(([k, v], i) => {
    const y = py + 30 * s + i * 36 * s;
    text(ctx, k, px + 22 * s, y, clamp(15 * s, 12, 18), '#e8d36a');
    text(ctx, v, px + pw - 22 * s, y, clamp(18 * s, 13, 22), '#fff', 'right', MONO);
  });
  if (game.newBest) text(ctx, trn.newBest, w / 2, py + ph + 32 * s, clamp(24 * s, 16, 26), '#ffd34d', 'center');
  if (t > 2.5) {
    if (Math.sin(t * 4) > -0.3) {
      const msg = game.showTouchControls ? trn.redeployTouch : trn.redeployDesktop;
      const msgSz = fitTitleSize(ctx, msg, clamp(18 * s, 13, 20), w * 0.9);
      text(ctx, msg, w / 2, py + ph + 70 * s, msgSz, '#fff', 'center');
    }
    const trRect = gameOverTitleRect(game);
    panel(ctx, trRect.x, trRect.y, trRect.w, trRect.h, 0.65);
    text(ctx, trn.titleMenu, trRect.x + trRect.w / 2, trRect.y + trRect.h / 2, 13, '#e8d36a', 'center', FONT, false);
  }
  ctx.globalAlpha = 1;
}
