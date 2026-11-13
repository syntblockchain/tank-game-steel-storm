// AirGesture-style 1-hand (right) and 2-hand (left move+alt-fire / right aim+cannon)
// webcam control (4 triangles + center circle per hand zone) on both laptop and mobile.
// Uses MediaPipe Hands when reachable, with an offline pure-JS CV tracker fallback
// and an interactive multi-touch / mouse pad fallback when no camera is available.

import { clamp, TAU } from './util.js';
import { fontSpec, tr } from './i18n.js';

const MP_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';
const MP_HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Barycentric AirGesture 5-zone classification:
// center circle (radius = min(w, h) * 0.20) + 4 triangles (up, down, left, right).
export function classifyAirGesture(x, y, w, h, handState, circleRatio = 0.20) {
  if (!handState || handState === 'none') {
    return { action: 'none', zone: 'none', dx: 0, dy: 0, angle: null, fire: false };
  }
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * circleRatio;
  const d = Math.hypot(x - cx, y - cy);
  const nx = (x - cx) / Math.max(1e-4, w / 2);
  const ny = (y - cy) / Math.max(1e-4, h / 2);

  let zone = 'circle';
  if (d > r) {
    if (Math.abs(ny) >= Math.abs(nx)) zone = ny < 0 ? 'up' : 'down';
    else zone = nx < 0 ? 'left' : 'right';
  }

  const dirs = {
    up: { dx: 0, dy: -1, angle: -Math.PI / 2 },
    down: { dx: 0, dy: 1, angle: Math.PI / 2 },
    left: { dx: -1, dy: 0, angle: Math.PI },
    right: { dx: 1, dy: 0, angle: 0 },
    circle: { dx: 0, dy: 0, angle: null },
  };
  const dir = dirs[zone];

  if (handState === 'open') {
    return { action: 'fire', zone, dx: dir.dx, dy: dir.dy, angle: dir.angle, fire: true };
  }
  if (zone === 'circle') {
    return { action: 'idle', zone: 'circle', dx: 0, dy: 0, angle: null, fire: false };
  }
  return { action: zone, zone, dx: dir.dx, dy: dir.dy, angle: dir.angle, fire: false };
}

export function classifyLandmarksOpenClosed(lm, prevOpen = false) {
  if (!lm || lm.length < 21) return 'none';
  const palm = Math.max(1e-4, dist2(lm[0], lm[9]), dist2(lm[0], lm[5]));
  const fingers = [
    [5, 6, 8],
    [9, 10, 12],
    [13, 14, 16],
    [17, 18, 20],
  ];
  let ext = 0;
  let spreadSum = 0;
  for (const [mcp, pip, tip] of fingers) {
    const dTipWrist = dist2(lm[tip], lm[0]);
    const dPipWrist = dist2(lm[pip], lm[0]);
    const dTipMcp = dist2(lm[tip], lm[mcp]);
    spreadSum += dTipWrist / palm;
    if (dTipWrist > dPipWrist * 1.10 && dTipMcp > palm * 0.55) ext++;
  }
  // Thumb extension relative to pinky MCP (17) and index MCP (5)
  if (dist2(lm[4], lm[17]) > dist2(lm[2], lm[17]) * 1.15 && dist2(lm[4], lm[5]) > palm * 0.42) ext++;
  const avgSpread = spreadSum / 4;

  if (prevOpen) {
    return (ext <= 1 && avgSpread < 1.25) ? 'closed' : 'open';
  }
  return (ext >= 3 || (ext >= 2 && avgSpread >= 1.55)) ? 'open' : 'closed';
}

export function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  let sx = 0, sy = 0;
  for (const i of ids) {
    sx += lm[i].x;
    sy += lm[i].y;
  }
  return { x: clamp(sx / ids.length, 0, 1), y: clamp(sy / ids.length, 0, 1) };
}

// Assigns detected hands into { left, right }.
// Rule: when only 1 hand is visible (even in 2-hand mode), it is ALWAYS assigned as the right hand.
export function pickHands(results, twoHand = false) {
  const lms = results && results.multiHandLandmarks;
  if (!lms || !lms.length) return { left: null, right: null };
  if (lms.length === 1) return { left: null, right: lms[0] };

  const handed = results.multiHandedness || [];
  const rightScore = (i) => {
    const h = handed[i];
    const lbl = h && (h.label || h.displayName);
    const bias = lbl === 'Right' ? 0.30 : lbl === 'Left' ? -0.30 : 0;
    return palmCenter(lms[i]).x + bias;
  };

  let rightIdx = 0;
  let bestR = -1e9;
  for (let i = 0; i < lms.length; i++) {
    const sc = rightScore(i);
    if (sc > bestR) {
      bestR = sc;
      rightIdx = i;
    }
  }
  if (!twoHand) return { left: null, right: lms[rightIdx] };

  let leftIdx = -1;
  let bestL = 1e9;
  for (let i = 0; i < lms.length; i++) {
    if (i === rightIdx) continue;
    const sc = rightScore(i);
    if (sc < bestL) {
      bestL = sc;
      leftIdx = i;
    }
  }
  return { left: leftIdx >= 0 ? lms[leftIdx] : null, right: lms[rightIdx] };
}

export function pickRightHand(results) {
  return pickHands(results, false).right;
}

function makeCvTrack(initX = 0.5) {
  return {
    prevOpen: false,
    smoothX: initX,
    smoothY: 0.5,
    hasLock: false,
    missCount: 0,
  };
}

// Offline pure-JS skin + motion blob tracker fallback when MediaPipe is unavailable.
export class FallbackCvTracker {
  constructor() {
    this.w = 72;
    this.h = 54;
    this.canvas = null;
    this.ctx = null;
    this.prevGray = null;
    this._right = makeCvTrack(0.65);
    this._left = makeCvTrack(0.25);
  }

  _ensureCanvas() {
    if (this.canvas || typeof document === 'undefined') return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prevGray = new Uint8Array(this.w * this.h);
  }

  _buildRes(blob, track, mask) {
    const { w, h } = this;
    const alpha = track.hasLock ? 0.45 : 1;
    track.smoothX += (blob.cxN - track.smoothX) * alpha;
    track.smoothY += (blob.cyN - track.smoothY) * alpha;
    track.hasLock = true;
    track.missCount = 0;

    const bw = Math.max(1, blob.maxX - blob.minX + 1);
    const bh = Math.max(1, blob.maxY - blob.minY + 1);
    const solidity = blob.area / (bw * bh);

    const probeY = clamp(Math.round(blob.minY + bh * 0.28), 0, h - 1);
    let runs = 0, inRun = false;
    for (let x = blob.minX; x <= blob.maxX; x++) {
      const on = mask[probeY * w + x] === 1;
      if (on && !inRun) runs++;
      inRun = on;
    }

    const state = track.prevOpen
      ? (solidity > 0.62 && runs <= 2 ? 'closed' : 'open')
      : (solidity < 0.49 || runs >= 3 ? 'open' : 'closed');
    track.prevOpen = state === 'open';

    return {
      x: track.smoothX,
      y: track.smoothY,
      state,
      bbox: {
        x0: blob.minX / w,
        y0: blob.minY / h,
        x1: (blob.maxX + 1) / w,
        y1: (blob.maxY + 1) / h,
      },
    };
  }

  _miss(track) {
    track.missCount++;
    if (track.missCount > 8) track.hasLock = false;
  }

  process(video, twoHand = false) {
    this._ensureCanvas();
    if (!this.ctx) return twoHand ? { left: null, right: null } : null;
    const { w, h, ctx } = this;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const motion = Math.abs(lum - this.prevGray[idx]);
        this.prevGray[idx] = lum;

        const isSkin = lum > 42 && cb >= 76 && cb <= 129 && cr >= 133 && cr <= 176 && r > g * 1.03 && r > b;
        const nearR = this._right.hasLock && Math.hypot(x / w - this._right.smoothX, y / h - this._right.smoothY) < 0.28;
        const nearL = twoHand && this._left.hasLock && Math.hypot(x / w - this._left.smoothX, y / h - this._left.smoothY) < 0.28;
        if (isSkin && (motion > 7 || nearR || nearL)) mask[idx] = 1;
      }
    }

    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    const blobs = [];

    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || seen[i]) continue;
      let head = 0, tail = 0;
      queue[tail++] = i;
      seen[i] = 1;
      let area = 0, sx = 0, sy = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;
      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur / w) | 0;
        area++;
        sx += cx;
        sy += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const nbs = [cur - 1, cur + 1, cur - w, cur + w];
        for (const nb of nbs) {
          if (nb < 0 || nb >= w * h || seen[nb] || !mask[nb]) continue;
          const nx = nb % w;
          if (Math.abs(nx - cx) > 1) continue;
          seen[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (area < 24) continue;
      blobs.push({ area, cxN: sx / area / w, cyN: sy / area / h, minX, maxX, minY, maxY });
    }

    if (!twoHand) {
      let bestBlob = null;
      let bestScore = 0;
      for (const b of blobs) {
        const rightBias = 0.7 + b.cxN * 0.5;
        const lockBonus = this._right.hasLock && Math.hypot(b.cxN - this._right.smoothX, b.cyN - this._right.smoothY) < 0.22 ? 1.5 : 1.0;
        const sc = b.area * rightBias * lockBonus;
        if (sc > bestScore) {
          bestScore = sc;
          bestBlob = b;
        }
      }
      if (!bestBlob) {
        this._miss(this._right);
        return null;
      }
      return this._buildRes(bestBlob, this._right, mask);
    }

    if (!blobs.length) {
      this._miss(this._right);
      this._miss(this._left);
      return { left: null, right: null };
    }

    blobs.sort((a, b) => b.area - a.area);
    const primary = blobs[0];
    // Find a clearly separated second hand blob (area >= 35% of primary and X gap >= 0.16)
    const secondary = blobs.slice(1).find((b) => b.area >= primary.area * 0.35 && Math.hypot(b.cxN - primary.cxN, b.cyN - primary.cyN) >= 0.16);
    if (!secondary) {
      // Only 1 hand visible -> treat as right hand
      this._miss(this._left);
      return { left: null, right: this._buildRes(primary, this._right, mask) };
    }
    const rightBlob = primary.cxN >= secondary.cxN ? primary : secondary;
    const leftBlob = primary.cxN >= secondary.cxN ? secondary : primary;
    return {
      left: this._buildRes(leftBlob, this._left, mask),
      right: this._buildRes(rightBlob, this._right, mask),
    };
  }
}

function makeHandSlot() {
  return {
    detected: false,
    handX: 0.5,
    handY: 0.5,
    localX: 0.5,
    localY: 0.5,
    handState: 'none',
    landmarks: null,
    bbox: null,
    gesture: classifyAirGesture(0.5, 0.5, 1, 1, 'none'),
    lastDetectAt: 0,
    padPointerId: null,
    padOpen: false,
    _mpState: 'none',
  };
}

function resetHandSlot(slot) {
  slot.detected = false;
  slot.handState = 'none';
  slot.landmarks = null;
  slot.bbox = null;
  slot.padPointerId = null;
  slot.padOpen = false;
  slot._mpState = 'none';
  slot.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
}

export class FreeHandController {
  constructor() {
    this.enabled = false;
    this.twoHand = false;
    this.mode = 'smart'; // 'smart' | 'aim' (for 1-hand, or single-hand fallback in 2-hand)
    this.leftWeapon = 'auto'; // 'auto' (MSL+MG) | 'msl' | 'mg'
    this.status = 'off'; // 'off' | 'loading' | 'ready' | 'fallback' | 'nocam'
    this.backend = 'none'; // 'none' | 'mediapipe' | 'cv' | 'pad'
    this.video = null;
    this.stream = null;
    this.hands = null;
    this._busy = false;
    this._lastSend = 0;
    this._cv = new FallbackCvTracker();

    this.left = makeHandSlot();
    this.right = makeHandSlot();
    this._syncLegacy();
  }

  _boxAspect() {
    return this.twoHand ? 1.12 : 1.33;
  }

  _recomputeGesture(slot) {
    if (!slot.detected || slot.handState === 'none') {
      slot.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
      return;
    }
    const asp = this._boxAspect();
    slot.gesture = classifyAirGesture(slot.localX * asp, slot.localY, asp, 1, slot.handState);
  }

  _syncLegacy() {
    const r = this.right;
    this.detected = r.detected;
    this.handX = r.handX;
    this.handY = r.handY;
    this.handState = r.handState;
    this.landmarks = r.landmarks;
    this.bbox = r.bbox;
    this.gesture = r.gesture;
    this.lastDetectAt = r.lastDetectAt;
    this.padPointerId = r.padPointerId;
    this.padOpen = r.padOpen;
  }

  toggleMode() {
    this.mode = this.mode === 'smart' ? 'aim' : 'smart';
  }

  toggleTwoHand() {
    this.twoHand = !this.twoHand;
    if (!this.twoHand) {
      resetHandSlot(this.left);
      if (this.right.detected) {
        this.right.localX = this.right.handX;
        this.right.localY = this.right.handY;
        this._recomputeGesture(this.right);
      }
    } else if (this.right.detected) {
      this.right.localX = clamp((this.right.handX - 0.5) * 2, 0, 1);
      this.right.localY = this.right.handY;
      this._recomputeGesture(this.right);
    }
    this._syncLegacy();
  }

  cycleLeftWeapon() {
    const order = ['auto', 'msl', 'mg'];
    this.leftWeapon = order[(order.indexOf(this.leftWeapon) + 1) % order.length];
  }

  hasAnyPadPointer() {
    return this.left.padPointerId !== null || this.right.padPointerId !== null;
  }

  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    resetHandSlot(this.left);
    resetHandSlot(this.right);
    this._syncLegacy();

    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.status = 'nocam';
      this.backend = 'pad';
      return;
    }

    this.status = 'loading';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      if (!this.enabled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;
      await video.play().catch(() => {});
      this.video = video;

      this.backend = 'cv';
      this.status = 'fallback';
      this._initMediaPipe();
    } catch {
      if (!this.enabled) return;
      this.status = 'nocam';
      this.backend = 'pad';
    }
  }

  disable() {
    this.enabled = false;
    this.status = 'off';
    this.backend = 'none';
    resetHandSlot(this.left);
    resetHandSlot(this.right);
    this._syncLegacy();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video = null;
  }

  async _initMediaPipe() {
    try {
      const base = await this._loadHandsScript();
      if (!this.enabled || !window.Hands) return;
      const hands = new window.Hands({
        locateFile: (file) => `${base}${file}`,
      });
      hands.setOptions({
        selfieMode: true,
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
      hands.onResults((res) => this._onMpResults(res));
      await hands.initialize();
      if (!this.enabled) {
        hands.close().catch(() => {});
        return;
      }
      this.hands = hands;
      this.backend = 'mediapipe';
      this.status = 'ready';
    } catch {
      if (this.enabled && this.video) {
        this.backend = 'cv';
        this.status = 'fallback';
      }
    }
  }

  _loadHandsScript() {
    if (typeof window !== 'undefined' && window.Hands) {
      return Promise.resolve(this._mpBase || MP_CDN);
    }
    const tryLoad = (base) =>
      new Promise((resolve, reject) => {
        if (typeof document === 'undefined') return reject(new Error('no dom'));
        const s = document.createElement('script');
        s.src = `${base}hands.js`;
        s.crossOrigin = 'anonymous';
        const timer = setTimeout(() => {
          s.remove();
          reject(new Error('timeout'));
        }, 7000);
        s.onload = () => {
          clearTimeout(timer);
          this._mpBase = base;
          resolve(base);
        };
        s.onerror = () => {
          clearTimeout(timer);
          s.remove();
          reject(new Error('load error'));
        };
        document.head.appendChild(s);
      });

    return tryLoad('./assets/mediapipe/hands/').catch(() => tryLoad(MP_CDN));
  }

  _applyLmToSlot(slot, lm, isLeft, now) {
    if (!lm) {
      if (now - slot.lastDetectAt > 180) {
        slot.detected = false;
        slot.handState = 'none';
        slot.landmarks = null;
        slot.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
      }
      return;
    }
    const c = palmCenter(lm);
    const prevOpen = slot._mpState === 'open';
    const state = classifyLandmarksOpenClosed(lm, prevOpen);
    slot._mpState = state;
    slot.landmarks = lm;
    slot.bbox = null;
    slot.detected = true;
    slot.handX = c.x;
    slot.handY = c.y;
    slot.localX = this.twoHand
      ? (isLeft ? clamp(c.x * 2, 0, 1) : clamp((c.x - 0.5) * 2, 0, 1))
      : c.x;
    slot.localY = c.y;
    slot.handState = state;
    slot.lastDetectAt = now;
    this._recomputeGesture(slot);
  }

  _onMpResults(results) {
    if (!this.enabled || this.backend !== 'mediapipe') return;
    const now = performance.now();
    const { left, right } = pickHands(results, this.twoHand);
    this._applyLmToSlot(this.right, right, false, now);
    if (this.twoHand) this._applyLmToSlot(this.left, left, true, now);
    else resetHandSlot(this.left);
    this._syncLegacy();
  }

  setPadInput(nx, ny, open, side = 'auto') {
    const cx = clamp(nx, 0, 1);
    const cy = clamp(ny, 0, 1);
    let targetSide = side;
    if (!this.twoHand) targetSide = 'right';
    else if (targetSide === 'auto') targetSide = cx < 0.5 ? 'left' : 'right';

    const slot = targetSide === 'left' ? this.left : this.right;
    slot.detected = true;
    slot.handState = open ? 'open' : 'closed';
    slot.landmarks = null;
    slot.bbox = null;
    slot.lastDetectAt = performance.now();

    if (!this.twoHand) {
      slot.handX = cx;
      slot.handY = cy;
      slot.localX = cx;
      slot.localY = cy;
    } else if (targetSide === 'left') {
      slot.handX = clamp(cx, 0, 0.5);
      slot.handY = cy;
      slot.localX = clamp(slot.handX * 2, 0, 1);
      slot.localY = cy;
    } else {
      slot.handX = clamp(cx, 0.5, 1);
      slot.handY = cy;
      slot.localX = clamp((slot.handX - 0.5) * 2, 0, 1);
      slot.localY = cy;
    }
    this._recomputeGesture(slot);
    this._syncLegacy();
  }

  clearPadInput(side = 'all') {
    const clearSlot = (slot) => {
      slot.padPointerId = null;
      if (this.backend === 'pad') {
        slot.detected = false;
        slot.handState = 'none';
        slot.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
      }
    };
    if (side === 'left' || side === 'all') clearSlot(this.left);
    if (side === 'right' || side === 'all') clearSlot(this.right);
    this._syncLegacy();
  }

  _applyCvToSlot(slot, res, isLeft, now) {
    if (res) {
      slot.detected = true;
      slot.handX = res.x;
      slot.handY = res.y;
      slot.localX = this.twoHand
        ? (isLeft ? clamp(res.x * 2, 0, 1) : clamp((res.x - 0.5) * 2, 0, 1))
        : res.x;
      slot.localY = res.y;
      slot.handState = res.state;
      slot.bbox = res.bbox;
      slot.landmarks = null;
      slot.lastDetectAt = now;
      this._recomputeGesture(slot);
    } else if (now - slot.lastDetectAt > 200) {
      slot.detected = false;
      slot.handState = 'none';
      slot.bbox = null;
      slot.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
    }
  }

  update(nowMs) {
    if (!this.enabled) return;
    if (this.backend === 'mediapipe' && this.hands && this.video && this.video.readyState >= 2) {
      if (!this._busy && nowMs - this._lastSend >= 36) {
        this._busy = true;
        this._lastSend = nowMs;
        this.hands.send({ image: this.video }).catch(() => {}).finally(() => {
          this._busy = false;
        });
      }
      return;
    }
    if (this.backend === 'cv' && this.video && this.video.readyState >= 2) {
      if (nowMs - this._lastSend >= 40) {
        this._lastSend = nowMs;
        const res = this._cv.process(this.video, this.twoHand);
        if (!this.twoHand) {
          this._applyCvToSlot(this.right, res, false, nowMs);
          resetHandSlot(this.left);
        } else {
          this._applyCvToSlot(this.right, res ? res.right : null, false, nowMs);
          this._applyCvToSlot(this.left, res ? res.left : null, true, nowMs);
        }
        this._syncLegacy();
      }
    }
  }
}

export function getFreeHandRect(layout, twoHand = false) {
  const { w, h, narrow, padR, padB, minimap, buttons } = layout;
  if (w >= 960) {
    const topY = minimap.y + minimap.size + 14;
    const footerH = 24;
    const maxBottom = Math.min(buttons.msl.y - buttons.msl.r - 10, h - 196);
    if (twoHand) {
      const pw = clamp(Math.round(w * 0.24), 220, 292);
      const ph = clamp(Math.min(Math.round(pw * 0.44), maxBottom - topY - footerH), 86, 132);
      return { x: w - padR - pw, y: topY, w: pw, h: ph, footerH };
    }
    const ph = clamp(maxBottom - topY - footerH, 90, 174);
    const pw = Math.round((ph * 4) / 3);
    return { x: w - padR - pw, y: topY, w: pw, h: ph, footerH };
  }
  if (!narrow || h < 500) {
    const footerH = 22;
    if (twoHand) {
      const pw = clamp(Math.round(w * 0.34), 178, 264);
      const ph = clamp(Math.round(pw * 0.40), 68, 108);
      return {
        x: Math.round(w / 2 - pw / 2),
        y: h - padB - ph - footerH,
        w: pw,
        h: ph,
        footerH,
      };
    }
    const pw = clamp(Math.round(w * 0.2), 112, 176);
    const ph = Math.round(pw * 0.72);
    return {
      x: Math.round(w / 2 - pw / 2),
      y: h - padB - ph - footerH,
      w: pw,
      h: ph,
      footerH,
    };
  }
  // Mobile portrait
  const pw = twoHand ? clamp(w - padR * 2, 200, 236) : 148;
  const ph = twoHand ? 96 : 110;
  return {
    x: w - padR - pw,
    y: minimap.y + minimap.size + 62,
    w: pw,
    h: ph,
    footerH: 22,
  };
}

export function hitFreeHandPanel(x, y, layout, fh = null) {
  const twoHand = !!(fh && fh.twoHand);
  const r = getFreeHandRect(layout, twoHand);
  if (x >= r.x && x <= r.x + r.w && y >= r.y + r.h && y <= r.y + r.h + r.footerH + 4) {
    if (twoHand) {
      if (fh && fh.backend === 'pad') {
        if (x < r.x + r.w * 0.44) return 'leftWeapon';
        if (x < r.x + r.w * 0.72) return 'padOpenL';
        return 'padOpenR';
      }
      return x < r.x + r.w * 0.56 ? 'leftWeapon' : 'twoHand';
    }
    if (fh && fh.backend === 'pad' && x >= r.x + r.w * 0.62) return 'padOpen';
    return 'mode';
  }
  if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
    if (twoHand) return x < r.x + r.w / 2 ? 'padL' : 'padR';
    return 'pad';
  }
  return null;
}

function drawZoneGrid(ctx, bx, by, bw, bh, slot, lang, isLeft) {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const rad = Math.min(bw, bh) * 0.20;
  const g = slot.gesture;

  const tris = [
    ['up', [[bx, by], [bx + bw, by], [cx, cy]], 'rgba(79,195,247,0.16)', 'rgba(79,195,247,0.44)'],
    ['down', [[bx, by + bh], [bx + bw, by + bh], [cx, cy]], 'rgba(79,195,247,0.16)', 'rgba(79,195,247,0.44)'],
    ['left', [[bx, by], [bx, by + bh], [cx, cy]], 'rgba(232,211,106,0.14)', 'rgba(232,211,106,0.42)'],
    ['right', [[bx + bw, by], [bx + bw, by + bh], [cx, cy]], 'rgba(232,211,106,0.14)', 'rgba(232,211,106,0.42)'],
  ];

  const fireFill = isLeft ? 'rgba(190,110,255,0.42)' : 'rgba(255,106,58,0.42)';
  for (const [zone, pts, idleFill, activeFill] of tris) {
    const active = slot.detected && g.zone === zone;
    ctx.fillStyle = active ? (g.fire ? fireFill : activeFill) : idleFill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = isLeft ? 'rgba(130,220,255,0.35)' : 'rgba(232,211,106,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + bw, by + bh);
  ctx.moveTo(bx + bw, by);
  ctx.lineTo(bx, by + bh);
  ctx.stroke();

  const inCircle = slot.detected && g.zone === 'circle';
  ctx.fillStyle = inCircle
    ? (g.fire ? (isLeft ? 'rgba(190,110,255,0.52)' : 'rgba(255,106,58,0.52)') : 'rgba(100,150,255,0.42)')
    : 'rgba(60,100,180,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = inCircle && g.fire ? (isLeft ? '#d49bff' : '#ff8a3a') : 'rgba(140,190,255,0.75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = fontSpec(lang, Math.round(clamp(bh * 0.1, 8.5, 12)), 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('▲', cx, by + bh * 0.18);
  ctx.fillText('▼', cx, by + bh * 0.84);
  ctx.fillText('◀', bx + bw * 0.14, cy);
  ctx.fillText('▶', bx + bw * 0.86, cy);
}

function drawHandGraphic(ctx, x, y, w, h, slot, isLeft) {
  if (!slot.detected) return;
  const g = slot.gesture;
  const activeCol = g.fire
    ? (isLeft ? '#d49bff' : '#ff4a3a')
    : (isLeft ? '#64e8ff' : '#7dff8a');
  if (slot.landmarks) {
    ctx.strokeStyle = activeCol;
    ctx.lineWidth = 1.5;
    for (const [a, b] of MP_HAND_CONNECTIONS) {
      const la = slot.landmarks[a], lb = slot.landmarks[b];
      ctx.beginPath();
      ctx.moveTo(x + la.x * w, y + la.y * h);
      ctx.lineTo(x + lb.x * w, y + lb.y * h);
      ctx.stroke();
    }
  } else if (slot.bbox) {
    ctx.strokeStyle = activeCol;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      x + slot.bbox.x0 * w,
      y + slot.bbox.y0 * h,
      (slot.bbox.x1 - slot.bbox.x0) * w,
      (slot.bbox.y1 - slot.bbox.y0) * h
    );
  }
  const hx = x + slot.handX * w;
  const hy = y + slot.handY * h;
  ctx.fillStyle = activeCol;
  ctx.beginPath();
  ctx.arc(hx, hy, 4.5, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

export function drawFreeHandOverlay(game, ctx, layout) {
  const fh = game.freeHand;
  if (!fh || !fh.enabled || game.state !== 'playing') return;

  const r = getFreeHandRect(layout, fh.twoHand);
  const { x, y, w, h, footerH } = r;
  const t = tr(game.lang);

  ctx.save();
  ctx.fillStyle = 'rgba(10,14,12,0.82)';
  ctx.fillRect(x, y, w, h + footerH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (fh.video && fh.video.readyState >= 2) {
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(fh.video, 0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = 'rgba(8,12,10,0.28)';
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.fillStyle = 'rgba(18,24,20,0.92)';
    ctx.fillRect(x, y, w, h);
  }

  if (!fh.twoHand) {
    drawZoneGrid(ctx, x, y, w, h, fh.right, game.lang, false);
    drawHandGraphic(ctx, x, y, w, h, fh.right, false);

    const g = fh.right.gesture;
    const statusText = !fh.right.detected
      ? (fh.status === 'nocam' ? t.freeHandPadHint : fh.status === 'loading' ? t.freeHandLoading : t.freeHandShow)
      : g.fire
        ? t.freeHandFire
        : t.freeHandZones[g.zone] || t.freeHandIdle;
    ctx.fillStyle = g.fire ? 'rgba(190,45,20,0.86)' : 'rgba(10,14,12,0.72)';
    ctx.fillRect(x, y, w, 18);
    ctx.font = fontSpec(game.lang, 10, 'mono');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = g.fire ? '#fff4d0' : fh.right.detected ? '#7dff8a' : '#e8d36a';
    ctx.fillText(statusText, x + w / 2, y + 9);
  } else {
    const hw = w / 2;
    drawZoneGrid(ctx, x, y, hw, h, fh.left, game.lang, true);
    drawZoneGrid(ctx, x + hw, y, hw, h, fh.right, game.lang, false);

    // Center divider between Left and Right AirGesture boxes
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + hw, y + 18);
    ctx.lineTo(x + hw, y + h);
    ctx.stroke();
    ctx.restore();

    drawHandGraphic(ctx, x, y, w, h, fh.left, true);
    drawHandGraphic(ctx, x, y, w, h, fh.right, false);

    // Status headers for Left and Right halves
    const lg = fh.left.gesture;
    const rg = fh.right.gesture;
    const lStatus = !fh.left.detected
      ? (fh.status === 'nocam'
        ? t.freeHandPadHintL
        : fh.right.detected ? t.freeHandOneToRight : t.freeHandLeftShow)
      : lg.fire
        ? t.freeHandLeftFire
        : t.freeHandLeftZones[lg.zone] || t.freeHandIdle;
    const rStatus = !fh.right.detected
      ? (fh.status === 'nocam' ? t.freeHandPadHintR : t.freeHandRightShow)
      : rg.fire
        ? t.freeHandRightFire
        : t.freeHandRightZones[rg.zone] || t.freeHandIdle;

    ctx.font = fontSpec(game.lang, w < 210 ? 8.5 : 9.5, 'mono');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = lg.fire ? 'rgba(130,45,190,0.88)' : 'rgba(10,14,12,0.74)';
    ctx.fillRect(x, y, hw, 18);
    ctx.fillStyle = lg.fire ? '#f8e6ff' : fh.left.detected ? '#64e8ff' : 'rgba(180,220,240,0.8)';
    ctx.fillText(lStatus, x + hw / 2, y + 9);

    ctx.fillStyle = rg.fire ? 'rgba(190,45,20,0.86)' : 'rgba(10,14,12,0.74)';
    ctx.fillRect(x + hw, y, hw, 18);
    ctx.fillStyle = rg.fire ? '#fff4d0' : fh.right.detected ? '#7dff8a' : '#e8d36a';
    ctx.fillText(rStatus, x + hw + hw / 2, y + 9);

    // Subtle divider between top status halves
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + hw, y);
    ctx.lineTo(x + hw, y + 18);
    ctx.stroke();
  }

  ctx.restore();

  const anyFire = fh.right.gesture.fire || (fh.twoHand && fh.left.gesture.fire);
  ctx.strokeStyle = fh.right.gesture.fire
    ? '#ff7a3a'
    : fh.twoHand && fh.left.gesture.fire
      ? '#c77dff'
      : fh.twoHand ? 'rgba(100,232,255,0.6)' : 'rgba(232,211,106,0.55)';
  ctx.lineWidth = anyFire ? 2 : 1.5;
  ctx.strokeRect(x, y, w, h);

  // Footer controls
  ctx.font = fontSpec(game.lang, w < 200 ? 8.5 : 9.5, 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (!fh.twoHand) {
    const splitPad = fh.backend === 'pad';
    const modeW = splitPad ? w * 0.62 : w;
    ctx.fillStyle = 'rgba(18,24,18,0.94)';
    ctx.fillRect(x, y + h, modeW, footerH);
    ctx.strokeStyle = 'rgba(232,211,106,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y + h, modeW, footerH);
    ctx.fillStyle = '#e8d36a';
    ctx.fillText(fh.mode === 'smart' ? t.freeHandModeSmart : t.freeHandModeAim, x + modeW / 2, y + h + footerH / 2);

    if (splitPad) {
      const ox = x + modeW;
      const ow = w - modeW;
      ctx.fillStyle = fh.right.padOpen ? 'rgba(210,70,28,0.9)' : 'rgba(28,36,28,0.94)';
      ctx.fillRect(ox, y + h, ow, footerH);
      ctx.strokeStyle = fh.right.padOpen ? '#ffaa6a' : 'rgba(232,211,106,0.45)';
      ctx.strokeRect(ox, y + h, ow, footerH);
      ctx.fillStyle = fh.right.padOpen ? '#ffffff' : '#ffb347';
      ctx.fillText(t.freeHandTestOpen, ox + ow / 2, y + h + footerH / 2);
    }
  } else if (fh.backend === 'pad') {
    const w1 = w * 0.44;
    const w2 = w * 0.28;
    const w3 = w - w1 - w2;
    ctx.fillStyle = 'rgba(18,24,22,0.94)';
    ctx.fillRect(x, y + h, w1, footerH);
    ctx.strokeStyle = 'rgba(100,232,255,0.4)';
    ctx.strokeRect(x, y + h, w1, footerH);
    ctx.fillStyle = '#64e8ff';
    ctx.fillText(t.leftWeaponShort[fh.leftWeapon], x + w1 / 2, y + h + footerH / 2);

    ctx.fillStyle = fh.left.padOpen ? 'rgba(130,45,190,0.9)' : 'rgba(24,28,36,0.94)';
    ctx.fillRect(x + w1, y + h, w2, footerH);
    ctx.strokeStyle = fh.left.padOpen ? '#e0b0ff' : 'rgba(130,220,255,0.4)';
    ctx.strokeRect(x + w1, y + h, w2, footerH);
    ctx.fillStyle = fh.left.padOpen ? '#fff' : '#c77dff';
    ctx.fillText(t.freeHandTestOpenL, x + w1 + w2 / 2, y + h + footerH / 2);

    ctx.fillStyle = fh.right.padOpen ? 'rgba(210,70,28,0.9)' : 'rgba(28,36,28,0.94)';
    ctx.fillRect(x + w1 + w2, y + h, w3, footerH);
    ctx.strokeStyle = fh.right.padOpen ? '#ffaa6a' : 'rgba(232,211,106,0.45)';
    ctx.strokeRect(x + w1 + w2, y + h, w3, footerH);
    ctx.fillStyle = fh.right.padOpen ? '#fff' : '#ffb347';
    ctx.fillText(t.freeHandTestOpenR, x + w1 + w2 + w3 / 2, y + h + footerH / 2);
  } else {
    const w1 = w * 0.56;
    const w2 = w - w1;
    ctx.fillStyle = 'rgba(18,24,22,0.94)';
    ctx.fillRect(x, y + h, w1, footerH);
    ctx.strokeStyle = 'rgba(100,232,255,0.4)';
    ctx.strokeRect(x, y + h, w1, footerH);
    ctx.fillStyle = '#64e8ff';
    ctx.fillText(t.leftWeaponShort[fh.leftWeapon], x + w1 / 2, y + h + footerH / 2);

    ctx.fillStyle = 'rgba(22,36,26,0.94)';
    ctx.fillRect(x + w1, y + h, w2, footerH);
    ctx.strokeStyle = 'rgba(125,255,138,0.45)';
    ctx.strokeRect(x + w1, y + h, w2, footerH);
    ctx.fillStyle = '#7dff8a';
    ctx.fillText(t.freeHand2HTagOn, x + w1 + w2 / 2, y + h + footerH / 2);
  }

  ctx.restore();
}
