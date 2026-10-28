// ============================================================================
// OW — toast notifications (stacking + types)
// ============================================================================
import { friendlyError } from './core-i18n.js';
import { playSound } from './core-sound.js';

const ICONS = {
  success: 'fa-solid fa-circle-check',
  error: 'fa-solid fa-circle-xmark',
  warning: 'fa-solid fa-triangle-exclamation',
  info: 'fa-solid fa-circle-info'
};

const SOUND_BY_TYPE = {
  success: 'success',
  error: 'error',
  warning: 'alert',
  info: 'notification'
};

function container() {
  let root = document.getElementById('toastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toastRoot';
    document.body.appendChild(root);
  }
  root.classList.add('o_toast_stack');
  return root;
}

export function toast(msg, type = 'success', opts = {}) {
  playSound(SOUND_BY_TYPE[type] || 'notification');
  const root = container();
  const el = document.createElement('div');
  el.className = `o_toast_item o_toast_${type}`;
  const icon = document.createElement('i');
  icon.className = ICONS[type] || ICONS.info;
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'o_toast_text';
  // Error toasts may be fed a raw exception. Never expose technical text to
  // the user; translate it into a short, actionable message instead.
  text.textContent = type === 'error' ? friendlyError(msg) : String(msg ?? '');
  el.append(icon, text);
  if (opts.action) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'o_toast_action';
    action.textContent = String(opts.action.label ?? '');
    if (opts.action.onClick) {
      action.onclick = () => { el.remove(); opts.action.onClick(); };
    }
    el.appendChild(action);
  }
  root.appendChild(el);
  const ms = opts.duration || (type === 'error' ? 5200 : 3000);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

export const toastSuccess = (m, o) => toast(m, 'success', o);
export const toastError = (m, o) => toast(m, 'error', o);
export const toastWarning = (m, o) => toast(m, 'warning', o);
export const toastInfo = (m, o) => toast(m, 'info', o);

window.toast = toast;
window.showToast = toast;
