// Entry point: build the game once fonts are ready and start the frame loop.

import { Game } from './game.js';
import { detectLang, tr } from './i18n.js';

async function boot() {
  const canvas = document.getElementById('screen');
  const loading = document.getElementById('loading');
  const lang = detectLang();
  if (document.documentElement) document.documentElement.lang = lang;
  if (loading) loading.textContent = tr(lang).loading;
  try {
    // Canvas text only uses a web font once it has loaded, so request both up front.
    const fonts = Promise.all(['20px "Russo One"', '20px "Share Tech Mono"'].map((f) => document.fonts.load(f)));
    await Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))]);
  } catch {}
  // Let the loading screen paint before the (synchronous) world generation.
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(canvas);
  window.game = game;
  document.getElementById('loading').remove();
  const loop = (now) => {
    game.frame(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
