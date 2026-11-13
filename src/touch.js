// Dual virtual joysticks and tactical touch controls for mobile play.

import { clamp, TAU } from './util.js';
import { fontSpec, tr } from './i18n.js';

const FONT = '"Russo One", "Arial Black", Impact, sans-serif';
const MONO = '"Share Tech Mono", ui-monospace, Menlo, monospace';
const DEG = Math.PI / 180;

export function getTouchLayout(w, h, insets = null) {
  const top = insets ? insets.top : 0;
  const right = insets ? insets.right : 0;
  const bottom = insets ? insets.bottom : 0;
  const left = insets ? insets.left : 0;

  const padL = Math.max(12, left + 8);
  const padR = Math.max(12, right + 8);
  const padB = Math.max(14, bottom + 8);
  const padT = Math.max(12, top + 6);
  const narrow = w < 580;

  const jr = clamp(Math.min(w, h) * 0.145, 44, 72);
  const knobR = Math.round(jr * 0.42);
  const br = clamp(jr * 0.43, 20, 30);

  const leftHome = { x: padL + jr + 10, y: h - padB - jr - 12 };
  const rightHome = { x: w - padR - jr - 10, y: h - padB - jr - 12 };

  const btnDist = jr + br + clamp(jr * 0.28, 12, 20);
  const btnAt = (deg, label) => ({
    x: rightHome.x + Math.cos(deg * DEG) * btnDist,
    y: rightHome.y + Math.sin(deg * DEG) * btnDist,
    r: br,
    label,
  });

  const s = clamp(Math.min(w / 1100, h / 720), 0.72, 1.15);
  const statusW = narrow ? clamp(Math.floor(w * 0.4), 138, 184) : Math.round(212 * s);
  const statusH = Math.round((narrow ? 86 : 94) * clamp(s, 0.76, 1.05));
  const status = { x: padL, y: padT, w: statusW, h: statusH };

  const mapSize = narrow
    ? clamp(Math.round(w * 0.21), 74, 108)
    : clamp(Math.round(Math.min(w, h) * 0.22), 82, 132);
  const minimap = { x: w - padR - mapSize, y: padT, size: mapSize };

  const pause = narrow
    ? { x: status.x + status.w + 8, y: padT, w: 36, h: 34 }
    : { x: status.x + status.w + 10, y: padT, w: 38, h: 38 };

  const handW = narrow ? 54 : (w < 960 ? 74 : 88);
  const handBtn = narrow
    ? { x: pause.x, y: padT + 40, w: handW, h: 28 }
    : { x: pause.x + pause.w + 8, y: padT, w: handW, h: 38 };

  const twoHandW = narrow ? 42 : (w < 960 ? 52 : 60);
  const twoHandBtn = {
    x: handBtn.x + handBtn.w + (narrow ? 4 : 6),
    y: handBtn.y,
    w: twoHandW,
    h: handBtn.h,
  };

  return {
    w,
    h,
    narrow,
    s,
    padL,
    padR,
    padB,
    padT,
    jr,
    knobR,
    br,
    leftHome,
    rightHome,
    buttons: {
      msl: btnAt(-86, 'MSL'),
      mg: btnAt(-130, 'MG'),
      bst: btnAt(-174, 'BST'),
    },
    status,
    minimap,
    pause,
    handBtn,
    twoHandBtn,
  };
}

function makeStickState() {
  return {
    id: null,
    active: false,
    originX: 0,
    originY: 0,
    curX: 0,
    curY: 0,
    x: 0,
    y: 0,
    mag: 0,
    angle: 0,
    firing: false,
  };
}

export class TouchControls {
  constructor() {
    this.left = makeStickState();
    this.right = makeStickState();
    this.mg = { id: null, active: false, startX: 0, startY: 0, curX: 0, curY: 0, aiming: false, aimAngle: 0 };
    this.bst = { id: null, active: false };
    this.msl = { id: null, active: false };
    this.pauseId = null;
    this.handId = null;
    this.twoHandId = null;
    this.mslPressed = false;
    this.pausePressed = false;
    this.handPressed = false;
    this.twoHandPressed = false;
    this.taps = [];
    this.deadzone = 0.14;
    this.fireThreshold = 0.30;
  }

  resetPlaying() {
    this.left = makeStickState();
    this.right = makeStickState();
    this.mg = { id: null, active: false, startX: 0, startY: 0, curX: 0, curY: 0, aiming: false, aimAngle: 0 };
    this.bst = { id: null, active: false };
    this.msl = { id: null, active: false };
    this.pauseId = null;
    this.handId = null;
    this.twoHandId = null;
    this.mslPressed = false;
    this.pausePressed = false;
    this.handPressed = false;
    this.twoHandPressed = false;
  }

  resetAll() {
    this.resetPlaying();
    this.taps.length = 0;
  }

  endFrame() {
    this.mslPressed = false;
    this.pausePressed = false;
    this.handPressed = false;
    this.twoHandPressed = false;
    this.taps.length = 0;
  }

  _inPause(x, y, layout) {
    const p = layout.pause;
    return x >= p.x - 8 && x <= p.x + p.w + 8 && y >= p.y - 8 && y <= p.y + p.h + 8;
  }

  _inHandBtn(x, y, layout) {
    const b = layout.handBtn;
    return !!b && x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6;
  }

  _inTwoHandBtn(x, y, layout) {
    const b = layout.twoHandBtn;
    return !!b && x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 6 && y <= b.y + b.h + 6;
  }

  _inHudBox(x, y, layout) {
    const st = layout.status;
    if (x >= st.x - 4 && x <= st.x + st.w + 4 && y >= st.y - 4 && y <= st.y + st.h + 4) return true;
    const mm = layout.minimap;
    if (x >= mm.x - 6 && x <= mm.x + mm.size + 6 && y >= mm.y - 6 && y <= mm.y + mm.size + 6) return true;
    return false;
  }

  _hitButton(x, y, layout) {
    const hitR = layout.br * 1.42;
    let bestName = null;
    let bestD = hitR;
    for (const [name, b] of Object.entries(layout.buttons)) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d <= bestD) {
        bestD = d;
        bestName = name;
      }
    }
    return bestName;
  }

  // Returns true if a control captured this touch/pointer.
  onStart(id, x, y, state, layout) {
    if (state !== 'playing') {
      this.taps.push({ x, y });
      return true;
    }

    if (this._inPause(x, y, layout)) {
      this.pauseId = id;
      this.pausePressed = true;
      return true;
    }

    if (this._inHandBtn(x, y, layout)) {
      this.handId = id;
      this.handPressed = true;
      return true;
    }

    if (this._inTwoHandBtn(x, y, layout)) {
      this.twoHandId = id;
      this.twoHandPressed = true;
      return true;
    }

    const btn = this._hitButton(x, y, layout);
    if (btn === 'msl' && this.msl.id === null) {
      this.msl.id = id;
      this.msl.active = true;
      this.mslPressed = true;
      return true;
    }
    if (btn === 'bst' && this.bst.id === null) {
      this.bst.id = id;
      this.bst.active = true;
      return true;
    }
    if (btn === 'mg' && this.mg.id === null) {
      this.mg.id = id;
      this.mg.active = true;
      this.mg.startX = x;
      this.mg.startY = y;
      this.mg.curX = x;
      this.mg.curY = y;
      this.mg.aiming = false;
      return true;
    }

    if (this._inHudBox(x, y, layout)) return false;

    const { w, h, jr, padL, padR, padB, padT, leftHome, rightHome } = layout;
    const nearLeft = Math.hypot(x - leftHome.x, y - leftHome.y) <= jr * 1.8;
    const nearRight = Math.hypot(x - rightHome.x, y - rightHome.y) <= jr * 1.8;

    if (this.left.id === null && (nearLeft || (x < w * 0.5 && !nearRight))) {
      const ox = clamp(x, padL + jr * 0.45, w * 0.46);
      const oy = clamp(y, Math.max(padT + 44, layout.status.y + jr * 0.35), h - padB - jr * 0.45);
      this.left = {
        id,
        active: true,
        originX: ox,
        originY: oy,
        curX: x,
        curY: y,
        x: 0,
        y: 0,
        mag: 0,
        angle: 0,
        firing: false,
      };
      this._updateStick(this.left, x, y, layout, false);
      return true;
    }

    if (this.right.id === null && (nearRight || x >= w * 0.5)) {
      const ox = clamp(x, w * 0.54, w - padR - jr * 0.45);
      const oy = clamp(y, Math.max(padT + 44, layout.minimap.y + jr * 0.35), h - padB - jr * 0.45);
      this.right = {
        id,
        active: true,
        originX: ox,
        originY: oy,
        curX: x,
        curY: y,
        x: 0,
        y: 0,
        mag: 0,
        angle: 0,
        firing: false,
      };
      this._updateStick(this.right, x, y, layout, true);
      return true;
    }

    return false;
  }

  onMove(id, x, y, layout) {
    if (id === this.left.id) {
      this._updateStick(this.left, x, y, layout, false);
      return true;
    }
    if (id === this.right.id) {
      this._updateStick(this.right, x, y, layout, true);
      return true;
    }
    if (id === this.mg.id) {
      this.mg.curX = x;
      this.mg.curY = y;
      const dx = x - this.mg.startX;
      const dy = y - this.mg.startY;
      if (Math.hypot(dx, dy) > 8) {
        this.mg.aiming = true;
        this.mg.aimAngle = Math.atan2(dy, dx);
      }
      return true;
    }
    return id === this.bst.id || id === this.msl.id || id === this.pauseId || id === this.handId || id === this.twoHandId;
  }

  onEnd(id) {
    if (id === this.left.id) {
      this.left = makeStickState();
      return true;
    }
    if (id === this.right.id) {
      this.right = makeStickState();
      return true;
    }
    if (id === this.mg.id) {
      this.mg = { id: null, active: false, startX: 0, startY: 0, curX: 0, curY: 0, aiming: false, aimAngle: 0 };
      return true;
    }
    if (id === this.bst.id) {
      this.bst = { id: null, active: false };
      return true;
    }
    if (id === this.msl.id) {
      this.msl = { id: null, active: false };
      return true;
    }
    if (id === this.pauseId) {
      this.pauseId = null;
      return true;
    }
    if (id === this.handId) {
      this.handId = null;
      return true;
    }
    if (id === this.twoHandId) {
      this.twoHandId = null;
      return true;
    }
    return false;
  }

  _updateStick(st, x, y, layout, isRight) {
    const { w, h, jr, padL, padR, padB, padT } = layout;
    st.curX = x;
    st.curY = y;

    let dx = x - st.originX;
    let dy = y - st.originY;
    let d = Math.hypot(dx, dy);

    // Gentle leash keeps rapid 180-degree reversals snappy.
    const leash = jr * (isRight ? 1.15 : 1.0);
    if (d > leash) {
      const targetOx = x - (dx / d) * leash;
      const targetOy = y - (dy / d) * leash;
      if (isRight) st.originX = clamp(targetOx, w * 0.52, w - padR - jr * 0.35);
      else st.originX = clamp(targetOx, padL + jr * 0.35, w * 0.48);
      st.originY = clamp(targetOy, padT + 44, h - padB - jr * 0.35);
      dx = x - st.originX;
      dy = y - st.originY;
      d = Math.hypot(dx, dy);
    }

    const raw = clamp(d / jr, 0, 1);
    if (raw <= this.deadzone || d < 1e-4) {
      st.mag = 0;
      st.x = 0;
      st.y = 0;
      st.firing = false;
      return;
    }

    const mag = clamp((raw - this.deadzone) / (1 - this.deadzone), 0, 1);
    const nx = dx / d;
    const ny = dy / d;
    st.mag = mag;
    st.angle = Math.atan2(ny, nx);
    st.x = nx * mag;
    st.y = ny * mag;
    st.firing = isRight && raw >= this.fireThreshold;
  }
}

// --- Rendering --------------------------------------------------------------------------

function drawJoystick(ctx, st, home, jr, knobR, isRight, time, lang = 'en') {
  const cx = st.active ? st.originX : home.x;
  const cy = st.active ? st.originY : home.y;
  const firing = isRight && st.firing;

  let kx = cx;
  let ky = cy;
  if (st.active) {
    const dx = st.curX - cx;
    const dy = st.curY - cy;
    const d = Math.hypot(dx, dy);
    const maxOffset = jr - knobR * 0.25;
    if (d > maxOffset && d > 0) {
      kx = cx + (dx / d) * maxOffset;
      ky = cy + (dy / d) * maxOffset;
    } else {
      kx = st.curX;
      ky = st.curY;
    }
  }

  ctx.save();

  // Outer tactical base
  const grad = ctx.createRadialGradient(cx, cy, jr * 0.1, cx, cy, jr);
  grad.addColorStop(0, st.active ? 'rgba(18,24,18,0.52)' : 'rgba(10,14,12,0.34)');
  grad.addColorStop(1, firing ? 'rgba(65,24,14,0.62)' : st.active ? 'rgba(14,20,16,0.62)' : 'rgba(10,14,12,0.44)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, jr, 0, TAU);
  ctx.fill();

  // Outer rim
  ctx.strokeStyle = firing
    ? 'rgba(255,122,58,0.9)'
    : st.active
      ? 'rgba(232,211,106,0.75)'
      : 'rgba(232,211,106,0.28)';
  ctx.lineWidth = st.active ? 2.5 : 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, jr, 0, TAU);
  ctx.stroke();

  // Cardinal tick marks
  ctx.strokeStyle = firing ? 'rgba(255,140,80,0.5)' : 'rgba(232,211,106,0.25)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (jr - 7), cy + Math.sin(a) * (jr - 7));
    ctx.lineTo(cx + Math.cos(a) * (jr - 1), cy + Math.sin(a) * (jr - 1));
    ctx.stroke();
  }

  // Right stick inner firing-threshold ring
  if (isRight) {
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = firing ? 'rgba(255,122,58,0.55)' : 'rgba(232,211,106,0.22)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, jr * 0.34, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Active directional sector glow & tether
  if (st.active && st.mag > 0.05) {
    ctx.strokeStyle = firing ? 'rgba(255,106,58,0.9)' : 'rgba(232,211,106,0.75)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, jr - 3, st.angle - 0.45, st.angle + 0.45);
    ctx.stroke();

    ctx.strokeStyle = firing ? 'rgba(255,138,58,0.35)' : 'rgba(232,211,106,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(kx, ky);
    ctx.stroke();
  }

  // Idle label inside base
  if (!st.active) {
    const t = tr(lang);
    ctx.font = fontSpec(lang, Math.round(clamp(jr * 0.18, 9, 12)), 'mono');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(232,211,106,0.5)';
    ctx.fillText(isRight ? t.stickRight : t.stickLeft, cx, cy + jr * 0.68);
  }

  // Thumb knob
  if (st.active) {
    ctx.shadowColor = firing ? 'rgba(255,106,58,0.65)' : 'rgba(232,211,106,0.45)';
    ctx.shadowBlur = 14;
  }
  const kGrad = ctx.createRadialGradient(kx - knobR * 0.25, ky - knobR * 0.25, 2, kx, ky, knobR);
  if (firing) {
    kGrad.addColorStop(0, '#ffd3a0');
    kGrad.addColorStop(0.5, '#d86528');
    kGrad.addColorStop(1, '#582010');
  } else if (st.active) {
    kGrad.addColorStop(0, '#4c5840');
    kGrad.addColorStop(1, '#1a2018');
  } else {
    kGrad.addColorStop(0, '#2e3729');
    kGrad.addColorStop(1, '#141913');
  }
  ctx.fillStyle = kGrad;
  ctx.beginPath();
  ctx.arc(kx, ky, knobR, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = firing ? '#ffaa6a' : st.active ? '#e8d36a' : 'rgba(232,211,106,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner knob detail: tracks for left stick, crosshair pip for right stick
  ctx.strokeStyle = firing ? 'rgba(255,245,230,0.9)' : 'rgba(232,211,106,0.65)';
  ctx.lineWidth = 1.5;
  if (isRight) {
    const r0 = knobR * 0.22;
    const r1 = knobR * 0.52;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.moveTo(kx + Math.cos(a) * r0, ky + Math.sin(a) * r0);
      ctx.lineTo(kx + Math.cos(a) * r1, ky + Math.sin(a) * r1);
    }
    ctx.stroke();
    ctx.fillStyle = firing ? '#fff' : '#e8d36a';
    ctx.beginPath();
    ctx.arc(kx, ky, firing ? 2.5 + Math.sin(time * 30) * 0.5 : 2, 0, TAU);
    ctx.fill();
  } else {
    const w0 = knobR * 0.36;
    ctx.beginPath();
    for (const dy of [-4, 0, 4]) {
      ctx.moveTo(kx - w0, ky + dy);
      ctx.lineTo(kx + w0, ky + dy);
    }
    ctx.stroke();
  }

  ctx.restore();
}

function drawActionButton(ctx, b, opts) {
  const { active, disabled, accent, progress, progressColor, label, badge, icon } = opts;
  ctx.save();
  if (disabled) ctx.globalAlpha = 0.42;

  // Background
  ctx.fillStyle = active ? 'rgba(42,48,34,0.82)' : 'rgba(10,14,12,0.56)';
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, TAU);
  ctx.fill();

  // Rim
  ctx.strokeStyle = active ? accent : 'rgba(232,211,106,0.34)';
  ctx.lineWidth = active ? 2.4 : 1.4;
  ctx.stroke();

  // Progress / energy / heat arc
  if (progress !== undefined && progress > 0.01) {
    ctx.strokeStyle = progressColor || accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r - 2.5, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(progress, 0, 1));
    ctx.stroke();
  }

  // Vector icon
  ctx.strokeStyle = active ? '#ffffff' : accent;
  ctx.fillStyle = active ? '#ffffff' : accent;
  ctx.lineWidth = 2;
  const r = b.r;
  const iy = b.y - r * 0.14;
  if (icon === 'bst') {
    // Double boost chevron
    ctx.beginPath();
    for (const off of [-r * 0.16, r * 0.1]) {
      ctx.moveTo(b.x - r * 0.28, iy + off + r * 0.14);
      ctx.lineTo(b.x, iy + off - r * 0.12);
      ctx.lineTo(b.x + r * 0.28, iy + off + r * 0.14);
    }
    ctx.stroke();
  } else if (icon === 'mg') {
    // Three rapid-fire rounds
    for (const ox of [-r * 0.22, 0, r * 0.22]) {
      ctx.fillRect(b.x + ox - 1.5, iy - r * 0.22, 3, r * 0.38);
    }
  } else if (icon === 'msl') {
    // Missile silhouette
    ctx.beginPath();
    ctx.moveTo(b.x, iy - r * 0.34);
    ctx.lineTo(b.x + r * 0.15, iy - r * 0.08);
    ctx.lineTo(b.x + r * 0.15, iy + r * 0.22);
    ctx.lineTo(b.x + r * 0.26, iy + r * 0.3);
    ctx.lineTo(b.x - r * 0.26, iy + r * 0.3);
    ctx.lineTo(b.x - r * 0.15, iy + r * 0.22);
    ctx.lineTo(b.x - r * 0.15, iy - r * 0.08);
    ctx.closePath();
    ctx.fill();
  }

  // Label
  ctx.font = `700 ${Math.round(clamp(r * 0.38, 8, 11))}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.86)';
  ctx.fillText(label, b.x, b.y + r * 0.44);

  // Count badge (missiles)
  if (badge !== undefined) {
    const bx = b.x + r * 0.68;
    const by = b.y - r * 0.68;
    const br = Math.max(8, r * 0.34);
    ctx.globalAlpha = 1;
    ctx.fillStyle = badge > 0 ? '#e67e22' : '#444';
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#0b0f0c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.font = `700 ${Math.round(br * 1.15)}px ${MONO}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(String(badge), bx, by + 0.5);
  }

  ctx.restore();
}

export function drawPauseButton(ctx, rect) {
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.fillStyle = 'rgba(10,14,12,0.58)';
  ctx.beginPath();
  ctx.moveTo(x + 6, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - 6);
  ctx.lineTo(x + w - 6, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(232,211,106,0.38)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.fillStyle = '#e8d36a';
  const bw = Math.max(3, Math.round(w * 0.11));
  const bh = Math.round(h * 0.42);
  const gap = Math.max(3, Math.round(w * 0.11));
  ctx.fillRect(x + w / 2 - gap / 2 - bw, y + (h - bh) / 2, bw, bh);
  ctx.fillRect(x + w / 2 + gap / 2, y + (h - bh) / 2, bw, bh);
  ctx.restore();
}

export function drawHandButton(ctx, rect, active, lang = 'en') {
  const { x, y, w, h } = rect;
  const t = tr(lang);
  ctx.save();
  ctx.fillStyle = active ? 'rgba(26,54,32,0.85)' : 'rgba(10,14,12,0.58)';
  ctx.beginPath();
  ctx.moveTo(x + 6, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - 6);
  ctx.lineTo(x + w - 6, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = active ? '#7dff8a' : 'rgba(232,211,106,0.38)';
  ctx.lineWidth = active ? 1.8 : 1.2;
  ctx.stroke();

  // Small stylized palm icon on left side of button
  const ix = x + Math.round(h * 0.42);
  const iy = y + h * 0.54;
  ctx.strokeStyle = active ? '#7dff8a' : '#e8d36a';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(ix, iy + 2, h * 0.16, 0, Math.PI);
  for (let f = -1.5; f <= 1.5; f += 1) {
    const fx = ix + f * (h * 0.085);
    ctx.moveTo(fx, iy + 1);
    ctx.lineTo(fx, iy - h * (Math.abs(f) < 1 ? 0.22 : 0.16));
  }
  ctx.stroke();

  ctx.font = fontSpec(lang, Math.round(clamp(h * 0.34, 9.5, 12)), 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = active ? '#7dff8a' : '#e8d36a';
  ctx.fillText(t.freeHandBtn, x + h * 0.62 + (w - h * 0.62) / 2, y + h / 2 + 0.5);
  ctx.restore();
}

export function drawTwoHandButton(ctx, rect, twoHand, handEnabled, lang = 'en') {
  const { x, y, w, h } = rect;
  const t = tr(lang);
  const active = twoHand && handEnabled;
  const armed = twoHand && !handEnabled;
  ctx.save();
  ctx.fillStyle = active ? 'rgba(18,48,60,0.88)' : armed ? 'rgba(24,38,44,0.78)' : 'rgba(10,14,12,0.58)';
  ctx.beginPath();
  ctx.moveTo(x + 6, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - 6);
  ctx.lineTo(x + w - 6, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = active ? '#64e8ff' : armed ? 'rgba(100,232,255,0.65)' : 'rgba(232,211,106,0.38)';
  ctx.lineWidth = active ? 1.8 : 1.2;
  ctx.stroke();

  ctx.font = fontSpec(lang, Math.round(clamp(h * 0.33, 9, 12)), 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = active || armed ? '#64e8ff' : '#e8d36a';
  ctx.fillText(t.twoHandBtn, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

export function drawTouchControls(game, ctx) {
  const p = game.player;
  if (!p || !p.alive || game.state !== 'playing') return;

  const layout = getTouchLayout(game.w, game.h, game.insets);
  const tc = game.input.touch;
  const fh = game.freeHand;

  // Mirror active Free Hand left gesture onto Left Joystick when user isn't directly dragging it
  let leftStick = tc.left;
  if (!tc.left.active && fh && fh.enabled && fh.twoHand && fh.left.detected) {
    const lg = fh.left.gesture;
    const dist = (lg.dx || lg.dy) ? layout.jr * 0.85 : 0;
    const ang = lg.angle ?? 0;
    leftStick = {
      active: lg.action !== 'idle' && lg.action !== 'none',
      originX: layout.leftHome.x,
      originY: layout.leftHome.y,
      curX: layout.leftHome.x + lg.dx * dist,
      curY: layout.leftHome.y + lg.dy * dist,
      x: lg.dx,
      y: lg.dy,
      mag: (lg.dx || lg.dy) ? 1 : 0,
      angle: ang,
      firing: false,
    };
  }

  // Mirror active Free Hand right gesture onto Right Joystick when user isn't directly dragging it
  let rightStick = tc.right;
  if (!tc.right.active && fh && fh.enabled && fh.right.detected) {
    const rg = fh.right.gesture;
    const dist = (rg.dx || rg.dy) ? layout.jr * 0.85 : 0;
    const ang = rg.angle ?? game.touchAim ?? p.turretAngle;
    rightStick = {
      active: rg.action !== 'idle' && rg.action !== 'none',
      originX: layout.rightHome.x,
      originY: layout.rightHome.y,
      curX: layout.rightHome.x + rg.dx * dist,
      curY: layout.rightHome.y + rg.dy * dist,
      x: rg.dx,
      y: rg.dy,
      mag: (rg.dx || rg.dy) ? 1 : 0,
      angle: ang,
      firing: rg.fire,
    };
  }

  // Dual joysticks
  drawJoystick(ctx, leftStick, layout.leftHome, layout.jr, layout.knobR, false, game.time, game.lang);
  drawJoystick(ctx, rightStick, layout.rightHome, layout.jr, layout.knobR, true, game.time, game.lang);

  const leftOpen = !!(fh && fh.enabled && fh.twoHand && fh.left.detected && fh.left.gesture.fire);
  const mgByHand = leftOpen && (fh.leftWeapon === 'auto' || fh.leftWeapon === 'mg');
  const mslByHand = leftOpen && (fh.leftWeapon === 'auto' || fh.leftWeapon === 'msl');

  // Secondary action buttons
  drawActionButton(ctx, layout.buttons.bst, {
    active: tc.bst.active || p.boosting,
    disabled: p.boostEnergy < 0.06,
    accent: p.boosting ? '#ffffff' : '#4fc3f7',
    progress: p.boostEnergy,
    progressColor: p.boosting ? '#ffffff' : '#4fc3f7',
    label: 'BST',
    icon: 'bst',
  });

  const heatBlink = p.overheated && Math.sin(game.time * 20) > 0;
  drawActionButton(ctx, layout.buttons.mg, {
    active: tc.mg.active || mgByHand,
    disabled: p.overheated,
    accent: p.overheated ? '#ff4a3a' : '#ffb347',
    progress: p.mgHeat,
    progressColor: p.overheated ? (heatBlink ? '#ff4a3a' : '#7a1a10') : '#ff8a3a',
    label: 'MG',
    icon: 'mg',
  });

  // Directional indicator when dragging MG button to aim
  if (tc.mg.active && tc.mg.aiming) {
    const b = layout.buttons.mg;
    ctx.save();
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r + 5, tc.mg.aimAngle - 0.5, tc.mg.aimAngle + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  drawActionButton(ctx, layout.buttons.msl, {
    active: tc.msl.active || mslByHand,
    disabled: game.missiles <= 0,
    accent: '#e67e22',
    label: 'MSL',
    badge: game.missiles,
    icon: 'msl',
  });
}
