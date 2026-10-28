// ============================================================================
// OW — application bootstrap
// ============================================================================
import { OW } from './core-registry.js';
import { showPage } from './core-router.js';
import { initI18n, tx, LANG, setLang, toggleLang, friendlyError } from './core-i18n.js';
import { initClickSounds } from './core-sound.js';
import { renderNavbar } from './ui-navbar.js';
import { renderAppsPanel, renderQuickSearch } from './ui-apps-panel.js';
import { renderUserMenu } from './ui-user-menu.js';
import { signIn, signUp, signOut, restoreSession, ensureOnlineSession, hasOfflineAccount } from './core-auth.js';
import { pullAll, syncAll, queueSnapshot } from './core-store.js';
import { toast } from './core-toast.js';
import { closeAllModals } from './core-modal.js';
import './core-searchable-select.js';
import './qr-scanner.js';

// Pages (side-effect registration)
import './page-dashboard.js';
import pageApps from './page-apps.js';
import './page-inventory.js';
import './page-transactions.js';
import './page-transfers.js';
import './page-stocktake.js';
import './page-reports.js';
import './page-settings.js';
import './page-profile.js';
import './page-about.js';
import './page-sync.js';
import './page-facilities.js';
import './page-orders.js';
// Secondary apps that remain part of the shipped WMS navigation.
import pageDiscuss from './page-discuss.js';
import pageCalendar from './page-calendar.js';

const EXTRA_PAGES = [pageDiscuss, pageCalendar];
for (const def of EXTRA_PAGES) {
  if (def && def.name) OW.registerPage(def.name, def);
}

// Full-screen apps home — the default landing page after sign-in.
OW.registerPage('apps', pageApps);

OW.openSearch = renderQuickSearch;

/* ── boot ───────────────────────────────────────────────────────────────── */

// Numeric inputs follow the browser locale unless we pin their language.
// Pin them to English so Arabic UI still displays Western (0-9) digits.
function pinWesternDigits(root = document) {
  root.querySelectorAll?.('input[type="number"]').forEach(input => {
    if (input.lang !== 'en') input.lang = 'en';
  });
}

initI18n();
initClickSounds();
pinWesternDigits();
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('input[type="number"]')) node.lang = 'en';
      else pinWesternDigits(node);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

renderShell();

function renderShell() {
  renderNavbar();
  renderAppsPanel();
  renderUserMenu();
}

/* ── sign-in / sign-up mode ─────────────────────────────────────────────── */

let loginMode = 'login'; // 'login' | 'signup'

function paintPasswordToggle() {
  const pwd = document.getElementById('loginPassword');
  const toggle = document.getElementById('loginPasswordToggle');
  if (!pwd || !toggle) return;
  const hidden = pwd.type === 'password';
  const label = hidden ? tx('إظهار كلمة المرور', 'Show password') : tx('إخفاء كلمة المرور', 'Hide password');
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('aria-pressed', String(!hidden));
  toggle.title = label;
  const icon = toggle.querySelector('i');
  if (icon) icon.className = hidden ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
}

window.__togglePassword = () => {
  const pwd = document.getElementById('loginPassword');
  if (!pwd) return;
  pwd.type = pwd.type === 'password' ? 'text' : 'password';
  paintPasswordToggle();
  pwd.focus({ preventScroll: true });
};

function paintLoginLanguage() {
  const ar = LANG === 'ar';
  const signup = loginMode === 'signup';
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('loginSubtitle', ar ? 'نظام إدارة المستودعات' : 'Warehouse Management System');
  set('loginTitle', signup
    ? tx('إنشاء حساب جديد', 'Create your account')
    : tx('مرحباً بعودتك', 'Welcome back'));
  set('loginDescription', signup
    ? tx('أدخل بياناتك لإنشاء حساب جديد.', 'Enter your details to create a new account.')
    : tx('سجّل الدخول لمتابعة المخزون والمعاملات بأمان.', 'Sign in to securely manage inventory and transactions.'));
  set('loginNameLabel', tx('الاسم الكامل', 'Full name'));
  set('loginEmailLabel', tx('البريد الإلكتروني', 'Email address'));
  set('loginPasswordLabel', tx('كلمة المرور', 'Password'));
  set('loginLangLabel', tx('الإنجليزية', 'Arabic'));
  const langBtn = document.getElementById('loginLangBtn');
  if (langBtn) langBtn.title = tx('التبديل إلى الإنجليزية', 'Switch to Arabic');
  set('loginSwitch', signup
    ? tx('لديك حساب؟ تسجيل الدخول', 'Already have an account? Sign in')
    : tx('ليس لديك حساب؟ إنشاء حساب', 'Need an account? Create account'));
  set('loginHint', signup
    ? tx('سيتم إنشاء الحساب على الخادم. إذا كان تأكيد البريد الإلكتروني مفعّلاً فستحتاج إلى تأكيده قبل الدخول.',
      'The account is created on the server. If email confirmation is enabled you must confirm it before signing in.')
    : tx('بعد أول تسجيل دخول ناجح، يمكنك الدخول دون اتصال على هذا الجهاز.',
      'After one successful sign-in you can access this device offline.'));
  const nameInput = document.getElementById('loginName');
  if (nameInput) nameInput.placeholder = tx('الاسم الكامل', 'Full name');
  const pwd = document.getElementById('loginPassword');
  if (pwd) {
    pwd.placeholder = tx('أدخل كلمة المرور', 'Enter your password');
    pwd.autocomplete = signup ? 'new-password' : 'current-password';
  }
  paintPasswordToggle();
  const btn = document.getElementById('loginButton');
  if (btn) {
    btn.innerHTML = signup
      ? `<i class="fa-solid fa-user-plus"></i> <span>${tx('إنشاء الحساب', 'Create account')}</span>`
      : `<i class="fa-solid fa-right-to-bracket"></i> <span>${tx('تسجيل الدخول', 'Sign in')}</span>`;
  }
  document.title = ar ? 'OW — إدارة المستودعات' : 'OW — Warehouse Management';
}

function applyLoginMode() {
  const signup = loginMode === 'signup';
  const nameField = document.getElementById('loginNameField');
  if (nameField) nameField.style.display = signup ? 'block' : 'none';
  paintLoginLanguage();
}

window.__toggleAuthMode = () => {
  loginMode = loginMode === 'login' ? 'signup' : 'login';
  const pwd = document.getElementById('loginPassword');
  if (pwd) pwd.type = 'password';
  showFeedback('');
  applyLoginMode();
};

paintLoginLanguage();
applyLoginMode();
window.__loginLang = () => { toggleLang(); paintLoginLanguage(); };
window.addEventListener('orshap-lang-changed', () => {
  paintLoginLanguage();
  renderShell();
});

function showFeedback(message, type = 'info') {
  const info = document.getElementById('authFeedback');
  const err = document.getElementById('authError');
  info.style.display = 'none';
  err.style.display = 'none';
  if (!message) return;
  const target = type === 'error' ? err : info;
  target.textContent = message;
  target.style.display = 'block';
}

function enterApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('appShell').style.display = 'block';
  renderShell();
}

function showLogin() {
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('loginPage').style.display = 'flex';
  showFeedback('');
}

/* ── queued operation synchronisation ─────────────────────────────────── */

let autoSyncPromise = null;

async function autoSync({ announce = false, rerender = true } = {}) {
  if (!navigator.onLine || !window.__session?.id) return null;
  if (autoSyncPromise) return autoSyncPromise;

  autoSyncPromise = (async () => {
    // An offline sign-in has no JWT. Try the persisted Supabase session first;
    // if it is missing, keep the queue untouched and ask for one online login.
    if (window.__session.offline) {
      const live = await ensureOnlineSession();
      if (!live) {
        if (queueSnapshot().length) {
          toast(tx('سجّل الدخول عبر الإنترنت مرة واحدة لمزامنة العمليات المحفوظة.',
            'Sign in online once to sync the locally saved operations.'), 'warning');
        }
        return null;
      }
      renderShell();
    }

    const pendingBefore = queueSnapshot().length;
    if (announce && pendingBefore) {
      toast(tx('جارٍ مزامنة العمليات المحفوظة…', 'Syncing locally saved operations…'), 'info');
    }

    const res = await syncAll();
    renderShell();
    const n = Number(res.master || 0) + Number(res.transactions || 0);
    const remaining = Number(res.remaining || 0);
    if (remaining) {
      toast(n
        ? tx(`تمت مزامنة ${n} عملية، وما زالت ${remaining} عملية بانتظار المعالجة.`,
          `Synced ${n} operation(s); ${remaining} still require attention.`)
        : tx(`تعذر إكمال المزامنة — ${remaining} عملية بانتظار المعالجة.`,
          `Sync incomplete — ${remaining} operation(s) still require attention.`), 'warning');
    } else if (res.refreshError) {
      toast(tx('تمت مزامنة العمليات، لكن تعذر تحديث البيانات من الخادم.',
        'Operations synced, but refreshing data from the server failed.'), 'warning');
    } else if (n) {
      toast(tx(`تمت مزامنة ${n} عملية`, `Synced ${n} operation(s)`), 'success');
    }

    // Never re-render under an open modal: the review/detail stack must survive
    // a background sync. Page content refreshes on the next navigation otherwise.
    if (rerender && OW.currentPage && !document.querySelector('.o_modal_overlay')) {
      await showPage(OW.currentPage);
    }
    return res;
  })();

  try {
    return await autoSyncPromise;
  } catch (e) {
    toast(String(e?.message || e), 'error');
    return null;
  } finally {
    autoSyncPromise = null;
  }
}

/* ── login / signup / logout ───────────────────────────────────────────── */

function authErrorMessage(message) {
  const m = String(message || '');
  if (/already registered|already been registered|user already exists/i.test(m)) {
    return tx('هذا البريد مسجّل مسبقاً. سجّل الدخول أو استخدم بريداً آخر.',
      'This email is already registered. Sign in or use another email.');
  }
  if (/password should be at least|password.*(6|six) characters/i.test(m)) {
    return tx('كلمة المرور يجب أن تكون 6 أحرف على الأقل.',
      'Password must be at least 6 characters.');
  }
  if (/invalid email|unable to validate email/i.test(m)) {
    return tx('البريد الإلكتروني غير صالح.', 'Invalid email address.');
  }
  if (/rate limit|too many requests/i.test(m)) {
    return tx('محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.',
      'Too many attempts. Please wait and try again.');
  }
  if (/fetch|network|load failed|timeout|timed out/i.test(m)) {
    return tx('تعذر الوصول إلى الخادم. تحقق من الاتصال ثم أعد المحاولة.',
      'Could not reach the server. Check your connection and retry.');
  }
  return m || tx('فشل إنشاء الحساب', 'Account creation failed');
}

async function finishAuthentication(session) {
  enterApp();
  showFeedback('');
  try {
    await pullAll();
  } catch (err) {
    console.warn('[boot] data pull failed', err);
    toast(tx('تم الدخول بالبيانات المحلية — تعذر تحديث البيانات من الخادم',
      'Signed in with local data — server refresh failed'), 'warning');
  }
  if (navigator.onLine && queueSnapshot().length) {
    await autoSync({ announce: false, rerender: false });
  }
  renderShell();
  // A fresh sign-in always opens the apps home; deep links are honoured on
  // reload/restore only.
  await showPage('apps');
  toast(tx('مرحبًا ', 'Welcome, ') + (session.name || ''), 'success');
}

window.__login = async function (e) {
  e.preventDefault();
  const form = e.target;
  const isSignup = loginMode === 'signup';
  const email = form.querySelector('[name="email"]').value.trim();
  const password = form.querySelector('[name="password"]').value;
  const name = (form.querySelector('[name="fullName"]')?.value || '').trim();
  const btn = document.getElementById('loginButton');

  if (!email || !password) {
    showFeedback(tx('أدخل البريد الإلكتروني وكلمة المرور.', 'Enter your email and password.'), 'error');
    return;
  }
  if (isSignup && !name) {
    showFeedback(tx('أدخل الاسم الكامل.', 'Enter your full name.'), 'error');
    return;
  }
  if (isSignup && password.length < 6) {
    showFeedback(tx('كلمة المرور يجب أن تكون 6 أحرف على الأقل.',
      'Password must be at least 6 characters.'), 'error');
    return;
  }

  if (btn) btn.disabled = true;
  showFeedback(navigator.onLine
    ? tx('جارٍ التحقق…', 'Verifying…')
    : tx('جارٍ التحقق دون اتصال…', 'Verifying offline…'));

  try {
    if (isSignup) {
      const result = await signUp(email, password, name);
      if (result?.pendingConfirmation) {
        loginMode = 'login';
        applyLoginMode();
        const pwd = document.getElementById('loginPassword');
        if (pwd) pwd.value = '';
        showFeedback(tx('تم إنشاء الحساب. تحقق من بريدك الإلكتروني لتأكيد الحساب ثم سجّل الدخول.',
          'Account created. Check your email to confirm the account, then sign in.'), 'info');
        return;
      }
      await finishAuthentication(window.__session || result);
      return;
    }

    const session = await signIn(email, password);
    await finishAuthentication(session);
  } catch (err) {
    console.error(err);
    showFeedback(isSignup
      ? friendlyError(authErrorMessage(err.message), tx('فشل إنشاء الحساب', 'Account creation failed'))
      : friendlyError(err, tx('فشل تسجيل الدخول', 'Sign-in failed')), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.__logout = async function () {
  await signOut();
  showLogin();
  closeAllModals();
  OW.closeAllPanels?.();
  toast(tx('تم تسجيل الخروج', 'Signed out'), 'info');
};

/* ── session restore ────────────────────────────────────────────────────── */

(async () => {
  try {
    const s = await restoreSession();
    if (!s) {
      if (!navigator.onLine && hasOfflineAccount()) {
        showFeedback(tx('أنت غير متصل. سجّل الدخول بكلمة المرور المحفوظة على هذا الجهاز.',
          'You are offline. Sign in with the password cached on this device.'), 'info');
      }
      return;
    }
    enterApp();
    try { await pullAll(); }
    catch (err) {
      console.warn('[boot] restore pull failed', err);
      toast(tx('تم استعادة الجلسة بالبيانات المحلية', 'Session restored with cached data'), 'warning');
    }
    // A pending queue must not wait for a manual visit to the Sync page after
    // a reload or an offline sign-in followed by reconnection.
    if (navigator.onLine && queueSnapshot().length) {
      await autoSync({ announce: false, rerender: false });
    }
    renderShell();
    const page = (location.hash || '').replace('#', '') || 'apps';
    await showPage(page in OW.pages ? page : 'apps');
  } catch (e) {
    console.warn('[boot] session restore skipped', e);
  }
})();

/* ── global keyboard ────────────────────────────────────────────────────── */

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (document.getElementById('appShell')?.style.display !== 'none') renderQuickSearch();
  }
  if (e.key === 'Escape') {
    closeAllModals();
    OW.closeAllPanels?.();
  }
});

/* ── connectivity ───────────────────────────────────────────────────────── */

window.addEventListener('online', () => {
  renderShell();
  if (!window.__session?.id) return;
  toast(tx('عاد الاتصال — تجري المزامنة…', 'Back online — syncing…'), 'info');
  void autoSync({ announce: true, rerender: true });
});

window.addEventListener('offline', () => {
  renderShell();
  toast(tx('انقطع الاتصال — يعمل النظام محليًا', 'Offline — local mode enabled'), 'warning');
});

window.addEventListener('orshap-store-updated', () => {
  // keep the navbar queue badge fresh
  renderNavbar();
});
