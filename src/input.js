// Keyboard, mouse, gamepad and dual-joystick touch input, normalised into a single control state.

import { TouchControls, getTouchLayout } from './touch.js';
import { getFreeHandRect, hitFreeHandPanel } from './freehand.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered this frame
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseDown = [false, false, false];
    this.mouseClicked = [false, false, false];
    this.usingGamepad = false;
    this.pad = null;
    this.padPressed = new Set();
    this._padPrev = [];

    const hasCoarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const hasFine = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    this.isTouchDevice = Boolean(hasCoarse && !hasFine);
    this.usingTouch = this.isTouchDevice;
    this.touch = new TouchControls();
    this.getContext = null;
    this.onGesture = null;
    this._lastTouchTime = -1e9;
    this._mouseTouchActive = false;

    const canvasPoint = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      return [clientX - r.left, clientY - r.top];
    };
    const readCtx = () => (this.getContext ? this.getContext() : { state: 'title', w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight, insets: null, showTouch: this.usingTouch });

    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (this.onGesture) this.onGesture();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.usingGamepad = false;
      this.usingTouch = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    const resetAll = () => {
      this.keys.clear();
      this.mouseDown = [false, false, false];
      this._mouseTouchActive = false;
      this.touch.resetAll();
      const ctx = readCtx();
      if (ctx.freeHand && ctx.freeHand.padPointerId !== null) ctx.freeHand.clearPadInput();
    };
    window.addEventListener('blur', resetAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) resetAll();
    });

    canvas.addEventListener('mousemove', (e) => {
      if (performance.now() - this._lastTouchTime < 400) return;
      const [x, y] = canvasPoint(e.clientX, e.clientY);
      const ctx = readCtx();
      const fh = ctx.freeHand;
      if (fh && fh.enabled && fh.backend === 'pad' && fh.padPointerId === 'mouse') {
        const r = getFreeHandRect(getTouchLayout(ctx.w, ctx.h, ctx.insets));
        fh.setPadInput((x - r.x) / r.w, (y - r.y) / r.h, (e.buttons & 2) !== 0 || e.shiftKey || fh.padOpen);
        return;
      }
      if (this._mouseTouchActive) {
        this.touch.onMove('mouse', x, y, getTouchLayout(ctx.w, ctx.h, ctx.insets));
        return;
      }
      this.mouseX = x;
      this.mouseY = y;
      this.usingGamepad = false;
    });

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (performance.now() - this._lastTouchTime < 400) return;
      if (this.onGesture) this.onGesture();
      const [x, y] = canvasPoint(e.clientX, e.clientY);
      this.mouseX = x;
      this.mouseY = y;
      this.usingGamepad = false;

      const ctx = readCtx();
      const fh = ctx.freeHand;
      if (ctx.state === 'playing' && fh && fh.enabled) {
        const layout = getTouchLayout(ctx.w, ctx.h, ctx.insets);
        const fhHit = hitFreeHandPanel(x, y, layout, fh);
        if (fhHit === 'mode') {
          if (e.button === 0) fh.toggleMode();
          return;
        }
        if (fhHit === 'padOpen') {
          fh.padPointerId = 'mouseOpen';
          fh.padOpen = true;
          fh.setPadInput(fh.handX, fh.handY, true);
          return;
        }
        if (fhHit === 'pad') {
          if (fh.backend === 'pad') {
            const r = getFreeHandRect(layout);
            fh.padPointerId = 'mouse';
            fh.setPadInput((x - r.x) / r.w, (y - r.y) / r.h, e.button === 2 || e.shiftKey || fh.padOpen);
          }
          return;
        }
      }

      if (e.button === 0) {
        if (ctx.allowMouseTouch && ctx.state === 'playing') {
          const layout = getTouchLayout(ctx.w, ctx.h, ctx.insets);
          const nearVirtual =
            this.touch._inPause(x, y, layout) ||
            this.touch._inHandBtn(x, y, layout) ||
            this.touch._hitButton(x, y, layout) !== null ||
            Math.hypot(x - layout.leftHome.x, y - layout.leftHome.y) <= layout.jr * 1.08 ||
            Math.hypot(x - layout.rightHome.x, y - layout.rightHome.y) <= layout.jr * 1.08;
          if (nearVirtual && this.touch.onStart('mouse', x, y, ctx.state, layout)) {
            this._mouseTouchActive = true;
            return;
          }
        }
        this.usingTouch = false;
      }

      this.mouseDown[e.button] = true;
      this.mouseClicked[e.button] = true;
    });

    window.addEventListener('mouseup', (e) => {
      const ctx = readCtx();
      const fh = ctx.freeHand;
      if (fh && fh.padPointerId === 'mouseOpen') {
        fh.padPointerId = null;
        fh.padOpen = false;
        if (fh.detected) fh.setPadInput(fh.handX, fh.handY, false);
      } else if (fh && fh.padPointerId === 'mouse') {
        fh.clearPadInput();
      }
      if (e.button === 0 && this._mouseTouchActive) {
        this.touch.onEnd('mouse');
        this._mouseTouchActive = false;
      }
      this.mouseDown[e.button] = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this.onGesture) this.onGesture();
      this._lastTouchTime = performance.now();
      this.usingTouch = true;
      this.usingGamepad = false;
      const ctx = readCtx();
      const layout = getTouchLayout(ctx.w, ctx.h, ctx.insets);
      const fh = ctx.freeHand;
      for (const t of e.changedTouches) {
        const [x, y] = canvasPoint(t.clientX, t.clientY);
        if (ctx.state === 'playing' && fh && fh.enabled) {
          const fhHit = hitFreeHandPanel(x, y, layout, fh);
          if (fhHit === 'mode') {
            fh.toggleMode();
            continue;
          }
          if (fhHit === 'padOpen') {
            fh.padPointerId = t.identifier;
            fh.padOpen = true;
            fh.setPadInput(fh.handX, fh.handY, true);
            continue;
          }
          if (fhHit === 'pad') {
            if (fh.backend === 'pad') {
              const r = getFreeHandRect(layout);
              fh.padPointerId = t.identifier;
              fh.setPadInput((x - r.x) / r.w, (y - r.y) / r.h, fh.padOpen);
            }
            continue;
          }
        }
        this.touch.onStart(t.identifier, x, y, ctx.state, layout);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      this._lastTouchTime = performance.now();
      const ctx = readCtx();
      const layout = getTouchLayout(ctx.w, ctx.h, ctx.insets);
      const fh = ctx.freeHand;
      for (const t of e.changedTouches) {
        const [x, y] = canvasPoint(t.clientX, t.clientY);
        if (fh && fh.enabled && fh.backend === 'pad' && fh.padPointerId === t.identifier) {
          const r = getFreeHandRect(layout);
          fh.setPadInput((x - r.x) / r.w, (y - r.y) / r.h, fh.padOpen);
          continue;
        }
        this.touch.onMove(t.identifier, x, y, layout);
      }
    }, { passive: false });

    const endTouch = (e) => {
      e.preventDefault();
      this._lastTouchTime = performance.now();
      const ctx = readCtx();
      const fh = ctx.freeHand;
      for (const t of e.changedTouches) {
        if (fh && fh.padPointerId === t.identifier) {
          if (fh.padOpen) {
            fh.padPointerId = null;
            fh.padOpen = false;
            if (fh.detected) fh.setPadInput(fh.handX, fh.handY, false);
          } else {
            fh.clearPadInput();
          }
          continue;
        }
        this.touch.onEnd(t.identifier);
      }
    };
    canvas.addEventListener('touchend', endTouch, { passive: false });
    canvas.addEventListener('touchcancel', endTouch, { passive: false });
  }

  get touchTap() {
    return this.touch.taps.length ? this.touch.taps[0] : null;
  }

  down(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  hit(...codes) {
    return codes.some((c) => this.pressed.has(c));
  }

  padHit(i) {
    return this.padPressed.has(i);
  }

  pollGamepad() {
    this.pad = null;
    this.padPressed.clear();
    let pads = [];
    try {
      pads = navigator.getGamepads ? navigator.getGamepads() : [];
    } catch {
      return;
    }
    for (const p of pads) {
      if (p && p.connected) {
        this.pad = p;
        break;
      }
    }
    if (!this.pad) return;
    const p = this.pad;
    p.buttons.forEach((b, i) => {
      if (b.pressed && !this._padPrev[i]) {
        this.padPressed.add(i);
        this.usingGamepad = true;
        this.usingTouch = false;
      }
      this._padPrev[i] = b.pressed;
    });
    const mag = (x, y) => Math.hypot(x, y);
    if (mag(p.axes[0], p.axes[1]) > 0.3 || mag(p.axes[2] ?? 0, p.axes[3] ?? 0) > 0.3) {
      this.usingGamepad = true;
      this.usingTouch = false;
    }
  }

  // Axis with radial dead-zone.
  stick(ix, iy, dead = 0.2) {
    if (!this.pad) return [0, 0];
    const x = this.pad.axes[ix] ?? 0, y = this.pad.axes[iy] ?? 0;
    const m = Math.hypot(x, y);
    if (m < dead) return [0, 0];
    const k = Math.min(1, (m - dead) / (1 - dead)) / m;
    return [x * k, y * k];
  }

  padButton(i) {
    return !!(this.pad && this.pad.buttons[i] && this.pad.buttons[i].pressed);
  }

  padValue(i) {
    return this.pad && this.pad.buttons[i] ? this.pad.buttons[i].value : 0;
  }

  endFrame() {
    this.pressed.clear();
    this.mouseClicked = [false, false, false];
    this.touch.endFrame();
  }
}
