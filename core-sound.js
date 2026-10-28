// ============================================================================
// OW — interface sounds
// ----------------------------------------------------------------------------
// All sounds are synthesised with the Web Audio API, so nothing is downloaded
// and offline mode stays fully functional. The mute preference is stored in
// localStorage and shared by the navbar button, Settings and every page.
// ============================================================================

import { tx } from './core-i18n.js';

const STORAGE_KEY = 'ow-sound-muted';

let context = null;
let muted = readMuted();

function readMuted() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; }
  catch (_) { return false; }
}

function writeMuted(value) {
  try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0'); } catch (_) {}
}

function audioContext() {
  if (muted) return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!context) {
    try { context = new AudioCtx(); } catch (_) { return null; }
  }
  if (context.state === 'suspended') {
    // Browsers only allow audio after a gesture; a rejected resume is harmless.
    try { context.resume().catch(() => {}); } catch (_) {}
  }
  return context;
}

function tone(ctx, { frequency, start = 0, duration = 0.12, gain = 0.05, type = 'sine', glide = 0 }) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, t0);
  if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, glide), t0 + duration);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

const PATTERNS = {
  click: ctx => tone(ctx, { frequency: 1250, duration: 0.045, gain: 0.035, type: 'sine' }),
  message: ctx => {
    tone(ctx, { frequency: 880, duration: 0.1, gain: 0.05, type: 'triangle' });
    tone(ctx, { frequency: 1320, start: 0.09, duration: 0.12, gain: 0.04, type: 'triangle' });
  },
  notification: ctx => {
    tone(ctx, { frequency: 988, duration: 0.09, gain: 0.045, type: 'sine' });
    tone(ctx, { frequency: 1319, start: 0.1, duration: 0.14, gain: 0.04, type: 'sine' });
  },
  alert: ctx => {
    [0, 0.16, 0.32].forEach(start =>
      tone(ctx, { frequency: 740, start, duration: 0.1, gain: 0.05, type: 'square' }));
  },
  success: ctx => {
    [660, 880, 1320].forEach((frequency, i) =>
      tone(ctx, { frequency, start: i * 0.085, duration: 0.14, gain: 0.05, type: 'triangle' }));
  },
  error: ctx => {
    tone(ctx, { frequency: 392, duration: 0.24, gain: 0.06, type: 'sawtooth', glide: 180 });
    tone(ctx, { frequency: 196, start: 0.13, duration: 0.22, gain: 0.05, type: 'sawtooth', glide: 120 });
  }
};

/**
 * Play a named interface sound. Unknown names are ignored.
 * @param {'click'|'message'|'notification'|'alert'|'success'|'error'} name
 */
export function playSound(name) {
  const pattern = PATTERNS[name];
  if (!pattern) return false;
  const ctx = audioContext();
  if (!ctx) return false;
  try { pattern(ctx); } catch (_) { return false; }
  return true;
}

export function isSoundMuted() {
  return muted;
}

export function setSoundMuted(value) {
  muted = !!value;
  writeMuted(muted);
  document.dispatchEvent(new CustomEvent('ow:sound-mute', { detail: muted }));
  return muted;
}

export function toggleSoundMuted() {
  return setSoundMuted(!muted);
}

/** Attach a light click to discrete controls, without hijacking typing or forms. */
export function initClickSounds(root = document) {
  const SELECTOR = 'button, .o_btn, a.o_clickable, [role="tab"], .o_menu_item, .o_chip_action';
  root.addEventListener('pointerdown', event => {
    const target = event.target.closest?.(SELECTOR);
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    if (target.matches('[data-sound-toggle], [data-sound-toggle-input]')) return;
    playSound('click');
  }, { capture: true, passive: true });

  // Mute controls are delegated so they keep working after any page rerender.
  root.addEventListener('click', event => {
    const button = event.target.closest?.('[data-sound-toggle]');
    if (!button) return;
    event.preventDefault();
    toggleSoundMuted();
  });
  root.addEventListener('change', event => {
    const input = event.target.closest?.('[data-sound-toggle-input]');
    if (input) setSoundMuted(!input.checked);
  });
  document.addEventListener('ow:sound-mute', () => syncSoundControls());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => syncSoundControls(), { once: true });
  } else {
    syncSoundControls();
  }
}

/** Reflect the current mute state on every [data-sound-toggle] control. */
export function syncSoundControls(root = document) {
  const mutedNow = isSoundMuted();
  root.querySelectorAll('[data-sound-toggle]').forEach(button => {
    button.setAttribute('aria-pressed', String(mutedNow));
    button.setAttribute('title', mutedNow
      ? tx('تشغيل الأصوات', 'Unmute sounds')
      : tx('كتم الأصوات', 'Mute sounds'));
    button.setAttribute('aria-label', button.getAttribute('title'));
    const icon = button.querySelector('i');
    if (icon) icon.className = `fa-solid ${mutedNow ? 'fa-volume-xmark' : 'fa-volume-high'}`;
  });
  root.querySelectorAll('[data-sound-toggle-input]').forEach(input => {
    input.checked = !mutedNow;
  });
}

/** Sounds are global state; expose a tiny debug/help surface. */
export const SOUND_NAMES = Object.keys(PATTERNS);
