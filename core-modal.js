// ============================================================================
// OW — modal system (stackable, promise-friendly)
// ============================================================================
import { OW } from './core-registry.js';
import { localizeDom } from './core-i18n.js';
import { tx } from './core-i18n.js';
import { playSound } from './core-sound.js';

let seq = 0;

export function modal({
  title = '', body = '', size = 'md', footer = '', cls = '',
  closeOnBackdrop = true, onMount = null, onClose = null, sound = ''
} = {}) {
  if (sound) playSound(sound);
  const id = `m${++seq}`;
  const overlay = document.createElement('div');
  overlay.className = 'o_modal_overlay';
  overlay.id = 'modal-' + id;
  overlay.dataset.modalId = id;
  overlay.innerHTML = `
    <div class="o_modal o_modal_${size} ${cls}" role="dialog" aria-modal="true">
      <div class="o_modal_header">
        <h3>${title}</h3>
        <button class="o_modal_close" aria-label="close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="o_modal_body">${body}</div>
      ${footer ? `<div class="o_modal_footer">${footer}</div>` : ''}
    </div>`;
  const close = () => {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 120);
    if (onClose) onClose();
  };
  overlay.querySelector('.o_modal_close').onclick = close;
  if (closeOnBackdrop) {
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  }
  document.getElementById('modalRoot').appendChild(overlay);
  localizeDom(overlay);
  if (onMount) setTimeout(() => onMount(overlay, close), 0);
  return {
    id, el: overlay, close,
    body: overlay.querySelector('.o_modal_body'),
    footer: overlay.querySelector('.o_modal_footer'),
    setTitle: (t) => { overlay.querySelector('.o_modal_header h3').innerHTML = t; }
  };
}

export function closeModal(id) {
  const el = document.getElementById('modal-' + id) ||
    document.querySelector(`[data-modal-id="${id}"]`);
  if (el) el.remove();
}

export function closeAllModals() {
  document.querySelectorAll('.o_modal_overlay').forEach(el => el.remove());
}

export function confirmDialog({
  title = tx('تأكيد', 'Confirm'),
  message = '',
  confirmText = tx('تأكيد', 'Confirm'),
  cancelText = tx('إلغاء', 'Cancel'),
  tone = 'primary',
  dangerous = false
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; m.close(); resolve(v); };
    const m = modal({
      title: `<i class="fa-solid ${dangerous ? 'fa-triangle-exclamation' : 'fa-circle-question'}"></i> ${title}`,
      size: 'sm',
      sound: dangerous ? 'alert' : 'notification',
      body: `<div class="o_confirm_message">${message}</div>`,
      footer: `<button class="o_btn o_btn_secondary" data-cancel>${cancelText}</button>
               <button class="o_btn o_btn_${dangerous ? 'danger' : tone}" data-ok>${confirmText}</button>`,
      onClose: () => { if (!settled) { settled = true; resolve(false); } },
      onMount: (el) => {
        el.querySelector('[data-cancel]').onclick = () => done(false);
        el.querySelector('[data-ok]').onclick = () => done(true);
        el.querySelector('[data-ok]')?.focus();
      }
    });
  });
}

export function promptDialog({
  title = tx('إدخال', 'Input'),
  label = '',
  value = '',
  placeholder = '',
  required = true,
  multiline = false,
  confirmText = tx('حفظ', 'Save')
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; m.close(); resolve(v); };
    const m = modal({
      title,
      size: 'sm',
      sound: 'notification',
      body: `<div class="o_field full"><label>${label}</label>
        ${multiline
          ? `<textarea class="o_form_input" id="promptInput" rows="3" placeholder="${placeholder}">${value}</textarea>`
          : `<input class="o_form_input" id="promptInput" value="${value}" placeholder="${placeholder}">`}
        <small class="o_hint o_prompt_error" style="display:none;color:#a61b1b"></small></div>`,
      footer: `<button class="o_btn o_btn_secondary" data-cancel>${tx('إلغاء', 'Cancel')}</button>
               <button class="o_btn o_btn_primary" data-ok>${confirmText}</button>`,
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
      onMount: (el) => {
        const input = el.querySelector('#promptInput');
        const err = el.querySelector('.o_prompt_error');
        input.focus(); input.select?.();
        const submit = () => {
          const v = input.value.trim();
          if (required && !v) { err.textContent = tx('هذا الحقل مطلوب', 'This field is required'); err.style.display = 'block'; return; }
          done(v);
        };
        el.querySelector('[data-cancel]').onclick = () => done(null);
        el.querySelector('[data-ok]').onclick = submit;
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && !multiline) submit(); });
      }
    });
  });
}

/* ── registry-based modals (legacy pages) ───────────────────────────────── */

export function openModal(id, opts = {}) {
  const def = OW.modals[id];
  if (!def) {
    console.warn('[modal] unknown modal:', id);
    return null;
  }
  const m = modal({
    title: def.title || '',
    body: typeof def.body === 'function' ? def.body(opts) : (def.body || ''),
    size: def.size || 'md',
    footer: typeof def.footer === 'function' ? def.footer(opts) : (def.footer || ''),
    onMount: (el, close) => def.mount?.(el, close, opts)
  });
  if (def.mount && !def.mount.length) setTimeout(() => def.mount(), 0);
  return m;
}

window.openModal = openModal;
window.closeModal = closeModal;
window.closeAllModals = closeAllModals;
