// ============================================================================
// OW — authentication
// Online: Supabase Auth + profiles (RLS authoritative).
// Offline: PBKDF2-SHA256 verifier cached on this device after one online login.
// ============================================================================
import { sb } from './core-supabase.js';
import { isAr } from './core-i18n.js';

const OFFLINE_AUTH_KEY = 'orshap_offline_auth_v1';
const SESSION_KEY = 'orshap_session_v1';

const say = (ar, en) => (isAr() ? ar : en);

export function currentUser() { return window.__session || null; }

function buildSession(user, profile, extra = {}) {
  return {
    id: user.id,
    email: user.email,
    name: profile?.name || user.user_metadata?.name || user.email,
    role: String(profile?.role || 'CLERK').toUpperCase(),
    profile: profile || {},
    access_token: extra.access_token || null,
    offline: !!extra.offline
  };
}

function persistSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (_) {}
}

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.id ? s : null;
  } catch (_) { return null; }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/* ── PBKDF2 (WebCrypto + pure-JS fallback) ──────────────────────────────── */

const K256 = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];

function sha256(bytes) {
  const len = bytes.length, bitLen = len * 8;
  const total = ((len + 9 + 63) >> 6) << 6;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 4, bitLen >>> 0);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296));
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    const W = new Uint32Array(64);
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = rr(a, 7) ^ rr(a, 18) ^ (a >>> 3);
      const s1 = rr(b, 17) ^ rr(b, 19) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H = H.map((x, i) => (x + [a, b, c, d, e, f, g, h][i]) >>> 0);
  }
  const out = new Uint8Array(32), od = new DataView(out.buffer);
  H.forEach((x, i) => od.setUint32(i * 4, x));
  return out;
}

function hmac(key, data) {
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64);
  k.set(key);
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
  inner.set(data, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

async function pbkdf2Js(password, salt, iterations) {
  const pass = new TextEncoder().encode(password);
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  block.set([0, 0, 0, 1], salt.length);
  let u = hmac(pass, block);
  const out = new Uint8Array(u);
  for (let i = 1; i < iterations; i++) {
    u = hmac(pass, u);
    for (let j = 0; j < out.length; j++) out[j] ^= u[j];
    if (i % 2000 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return out;
}

function hex(a) {
  return Array.from(new Uint8Array(a), b => b.toString(16).padStart(2, '0')).join('');
}

async function passwordVerifier(password, saltHex, iterations, scheme) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g) || [], x => parseInt(x, 16))
    : (crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(16))
      : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
  const useSubtle = (!scheme || scheme === 'PBKDF2-SHA256-WebCrypto') && !!crypto.subtle;
  const rounds = iterations || (useSubtle ? 180000 : 60000);
  let bits;
  if (useSubtle) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, key, 256));
  } else {
    bits = await pbkdf2Js(password, salt, rounds);
  }
  return {
    salt: hex(salt), hash: hex(bits), iterations: rounds,
    scheme: useSubtle ? 'PBKDF2-SHA256-WebCrypto' : 'PBKDF2-SHA256-JS'
  };
}

async function cacheOfflineCredential(email, password, user, profile) {
  try {
    const v = await passwordVerifier(password);
    localStorage.setItem(OFFLINE_AUTH_KEY, JSON.stringify({
      email: String(email).toLowerCase(), userId: user.id,
      name: profile?.name || user.user_metadata?.name || email,
      role: String(profile?.role || 'CLERK').toUpperCase(),
      profile: profile || null,
      salt: v.salt, hash: v.hash, iterations: v.iterations, scheme: v.scheme,
      updatedAt: new Date().toISOString()
    }));
  } catch (e) {
    console.warn('[auth] offline credential cache unavailable', e);
  }
}

export function hasOfflineAccount() {
  try { return !!JSON.parse(localStorage.getItem(OFFLINE_AUTH_KEY) || 'null'); } catch (_) { return false; }
}

async function authenticateOffline(email, password) {
  let c;
  try { c = JSON.parse(localStorage.getItem(OFFLINE_AUTH_KEY) || 'null'); } catch (_) { c = null; }
  if (!c || String(c.email || '').toLowerCase() !== String(email || '').toLowerCase()) {
    throw new Error(say('لا يوجد حساب محفوظ لهذا البريد على هذا الجهاز. اتصل بالإنترنت وسجّل الدخول مرة واحدة.',
      'No offline account is cached for this email on this device. Connect and sign in once first.'));
  }
  const v = await passwordVerifier(password, c.salt, c.iterations, c.scheme);
  if (v.hash !== c.hash) {
    throw new Error(say('كلمة المرور غير صحيحة للدخول دون اتصال', 'Incorrect password for offline sign-in'));
  }
  const session = {
    id: c.userId, email: c.email, name: c.name || c.email,
    role: String(c.role || 'CLERK').toUpperCase(), profile: c.profile || {},
    access_token: null, offline: true
  };
  window.__session = session;
  persistSession(session);
  return session;
}

/* ── public API ─────────────────────────────────────────────────────────── */

export async function signIn(email, password) {
  email = String(email || '').trim();

  if (!navigator.onLine) return authenticateOffline(email, password);

  let c;
  try { c = await sb(); }
  catch (e) { return authenticateOffline(email, password); }

  let authResult;
  try {
    authResult = await c.auth.signInWithPassword({ email, password });
  } catch (e) {
    // A thrown transport error must use the cached verifier too; otherwise an
    // intermittent connection produces a raw "Failed to fetch" on the login page.
    if (/fetch|network|timeout|failed to load|load failed/i.test(e?.message || String(e))) {
      return authenticateOffline(email, password);
    }
    throw e;
  }
  const { data, error } = authResult;
  if (error) {
    // Network failure while the SDK is loaded → allow the cached verifier.
    if (/fetch|network|timeout|failed to load|load failed/i.test(error.message || '')) {
      return authenticateOffline(email, password);
    }
    throw new Error(isAr() ? 'بيانات الدخول غير صحيحة' : 'Invalid email or password');
  }
  const user = data.user, authSession = data.session;
  const { data: profile, error: perr } = await c.from('profiles')
    .select('*').eq('id', user.id).maybeSingle();
  if (perr) console.warn('[auth] profile read failed', perr);

  const status = profile?.status || 'ACTIVE';
  if (status !== 'ACTIVE') {
    await c.auth.signOut().catch(() => {});
    throw new Error(say('الحساب غير نشط. راجع المدير.', 'This account is inactive. Contact your administrator.'));
  }

  const session = buildSession(user, profile, { access_token: authSession?.access_token });
  window.__session = session;
  persistSession(session);
  cacheOfflineCredential(email, password, user, profile);
  return session;
}

export async function signUp(email, password, name) {
  email = String(email || '').trim();
  name = String(name || '').trim() || email;
  const c = await sb();
  const { data, error } = await c.auth.signUp({
    email, password, options: { data: { name } }
  });
  if (error) throw error;
  if (!data?.user) {
    throw new Error(say('لم يُرجع الخادم بيانات الحساب. تحقق من البريد وكلمة المرور.',
      'The server returned no account data. Check the email and password.'));
  }
  // If email confirmation is disabled, Supabase returns a session immediately.
  if (data.session && data.user) {
    const { data: profile, error: perr } = await c.from('profiles')
      .select('*').eq('id', data.user.id).maybeSingle();
    if (perr) console.warn('[auth] profile read after signup failed', perr);
    const session = buildSession(data.user, profile, { access_token: data.session.access_token });
    window.__session = session;
    persistSession(session);
    return session;
  }
  return { pendingConfirmation: true, user: data.user };
}

export async function signOut() {
  const wasOffline = window.__session?.offline;
  if (!wasOffline) {
    try {
      const c = await sb();
      await c.auth.signOut();
    } catch (e) { console.warn('[auth] signOut', e); }
  }
  window.__session = null;
  clearSession();
}

export async function restoreSession() {
  // 1. Offline cache first when the network is down.
  if (!navigator.onLine) {
    const s = readSession();
    if (s && s.id) {
      window.__session = { ...s, offline: true, access_token: null };
      return window.__session;
    }
    return null;
  }

  try {
    const c = await sb();
    const { data } = await c.auth.getSession();
    if (!data?.session) {
      // Network is up but no Supabase session: allow the last local session only
      // when it was created offline (queued work still needs to be visible).
      const s = readSession();
      if (s?.offline && s.id) { window.__session = { ...s, offline: true }; return window.__session; }
      return null;
    }
    const { data: profile } = await c.from('profiles')
      .select('*').eq('id', data.session.user.id).maybeSingle();
    if ((profile?.status || 'ACTIVE') !== 'ACTIVE') {
      await c.auth.signOut().catch(() => {});
      clearSession();
      return null;
    }
    const session = buildSession(data.session.user, profile, { access_token: data.session.access_token });
    window.__session = session;
    persistSession(session);
    return session;
  } catch (e) {
    console.warn('[auth] session restore failed', e);
    const s = readSession();
    if (s && s.id) { window.__session = { ...s, offline: true }; return window.__session; }
    return null;
  }
}

/**
 * Promotes an offline (locally verified) session back to a live Supabase
 * session when the SDK still has a persisted auth token. Offline sign-in never
 * has the password available, so this is the only safe way to resume queue
 * synchronisation after reconnecting. Returns null when a real online sign-in
 * is still required; the local queue must never be discarded in that case.
 */
export async function ensureOnlineSession() {
  const current = window.__session;
  if (!current?.id || !navigator.onLine) return null;
  if (!current.offline) return current;
  try {
    const c = await sb();
    const { data, error } = await c.auth.getSession();
    if (error || !data?.session?.user) return null;
    if (data.session.user.id !== current.id) return null;

    let profile = null;
    try {
      const result = await c.from('profiles').select('*').eq('id', current.id).maybeSingle();
      if (!result.error) profile = result.data;
    } catch (_) { /* cached profile remains usable */ }

    const sourceProfile = profile || current.profile || {};
    const status = String(sourceProfile.status || 'ACTIVE').toUpperCase();
    if (status !== 'ACTIVE') {
      await c.auth.signOut().catch(() => {});
      return null;
    }
    const session = buildSession(data.session.user, sourceProfile, {
      access_token: data.session.access_token
    });
    window.__session = session;
    persistSession(session);
    return session;
  } catch (e) {
    console.warn('[auth] online session recovery failed', e);
    return null;
  }
}

export async function refreshProfile() {
  const u = window.__session;
  if (!u?.id) return null;
  if (!navigator.onLine) return u.profile;
  try {
    const c = await sb();
    const { data } = await c.from('profiles').select('*').eq('id', u.id).maybeSingle();
    if (data) {
      window.__session = { ...u, profile: data, role: String(data.role || u.role).toUpperCase() };
      persistSession(window.__session);
      return data;
    }
  } catch (e) { console.warn('[auth] refreshProfile', e); }
  return u.profile;
}

export function isOfflineSession() { return !!window.__session?.offline; }
