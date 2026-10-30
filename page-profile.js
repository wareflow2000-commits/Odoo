// ============================================================================
// OW — My profile
// ============================================================================
import { OW } from './core-registry.js';
import { tx, toggleLang } from './core-i18n.js';
import { pageHead, card, table, empty, badge, btn, alertBox, input, field } from './core-ui.js';
import { store, updateRow, pullAll, warehouseName } from './core-store.js';
import { rolePermissions, customPermissions, role, accessibleWarehouseIds } from './core-rbac.js';
import { roleLabel, fmtDateTime, fmtNum, initials, statusLabel, permissionLabel, permissionDescription } from './core-utils.js';
import { toast } from './core-toast.js';
import { modal, confirmDialog } from './core-modal.js';

function currentProfile() {
  const id = window.__session?.id;
  return (id && store.byId('profiles', id)) || window.__session?.profile || {};
}

function render() {
  const p = currentProfile();
  const user = window.__session || {};
  const roleKey = role();
  const perms = [...new Set([...rolePermissions(), ...customPermissions()])].sort();
  const accessible = accessibleWarehouseIds();
  const warehouses = accessible === null
    ? store.get('warehouses')
    : store.get('warehouses').filter(w => accessible.includes(w.id));
  const activity = store.get('audit_logs')
    .filter(a => a.user_id === user.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 10);

  return `
  ${pageHead(p.name || user.name || tx('ملفي', 'My profile'),
    p.email || user.email || '',
    `${btn(`<i class="fa-solid fa-language"></i> ${tx('الإنجليزية', 'Arabic')}`, 'onclick="OW.wms.toggleProfileLang()"', 'secondary')}
     ${btn(`<i class="fa-solid fa-right-from-bracket"></i> ${tx('تسجيل الخروج', 'Sign out')}`, 'onclick="window.__logout()"', 'danger')}`)}
  <div class="o_page_body">
    <div class="o_profile_head">
      <div class="o_profile_avatar">${initials(p.name || user.name || p.email || '?')}</div>
      <div class="o_profile_ident">
        <h2>${p.name || user.name || '—'}</h2>
        <p>${p.email || user.email || '—'}</p>
        <div class="o_profile_badges">
          ${badge(roleLabel(roleKey || p.role), 'purple')}
          ${badge(statusLabel(p.status || 'ACTIVE'), (p.status || 'ACTIVE') === 'ACTIVE' ? 'green' : 'red')}
          ${p.can_approve_without_workflow ? badge(tx('اعتماد مباشر', 'Direct approval'), 'blue') : ''}
          ${user.offline ? badge(tx('جلسة دون اتصال', 'Offline session'), 'orange') : ''}
        </div>
      </div>
      <div class="o_profile_meta">
        <div><small>${tx('آخر دخول', 'Signed in')}</small><b>${user.signedInAt ? fmtDateTime(user.signedInAt) : '—'}</b></div>
        <div><small>${tx('الاتصال', 'Connection')}</small><b>${navigator.onLine ? tx('متصل', 'Online') : tx('دون اتصال', 'Offline')}</b></div>
      </div>
    </div>

    <div class="o_grid" style="grid-template-columns:1.1fr 1fr">
      ${card(`<i class="fa-solid fa-id-card"></i> ${tx('بيانات الحساب', 'Account details')}`,
        `<form id="profileForm" class="o_form_grid">
          ${input({ name: 'name', label: tx('الاسم', 'Name'), value: p.name || user.name || '' })}
          ${input({ name: 'email', label: tx('البريد الإلكتروني', 'Email'), value: p.email || user.email || '', attrs: 'readonly' })}
          ${input({ name: 'phone', label: tx('الهاتف', 'Phone'), value: p.phone || '' })}
        </form>
        <div class="o_line_tools" style="margin-top:10px">
          <button class="o_btn o_btn_primary o_btn_sm" id="profSave"><i class="fa-solid fa-floppy-disk"></i> ${tx('حفظ', 'Save')}</button>
          <span class="o_muted">${tx('الاسم والهاتف فقط قابلان للتعديل من هنا.', 'Only name and phone can be edited here.')}</span>
        </div>`)}
      ${card(`<i class="fa-solid fa-warehouse"></i> ${tx('المستودعات المتاحة', 'Accessible warehouses')}`,
        warehouses.length
          ? `<div class="o_chip_list">${warehouses.map(w => `<span class="o_chip"><i class="fa-solid fa-warehouse"></i> ${w.code} — ${w.name}</span>`).join('')}</div>
             ${accessible === null ? `<p class="o_hint">${tx('دورك يمنحك الوصول إلى كل المستودعات.', 'Your role grants access to every warehouse.')}</p>` : ''}`
          : alertBox(tx('لم يُعيَّن لك أي مستودع — تواصل مع مدير النظام.',
            'No warehouse assigned to you — contact your administrator.'), 'warning'),
        `<span class="o_muted">${fmtNum(warehouses.length)}</span>`)}
    </div>

    <div class="o_grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      ${card(`<i class="fa-solid fa-shield-halved"></i> ${tx('صلاحياتي', 'My permissions')}`,
        perms.length
          ? `<div class="o_chip_list">${perms.map(k => `<span class="o_chip o_chip_code" title="${permissionDescription(k)}"><i class="fa-solid fa-shield-halved"></i> ${permissionLabel(k)}</span>`).join('')}</div>`
          : alertBox(tx('لا توجد صلاحيات مخصصة — دورك يحدد الوصول.',
            'No explicit permissions — your role controls access.'), 'info'),
        `<span class="o_muted">${fmtNum(perms.length)}</span>`)}
      ${card(`<i class="fa-solid fa-clock-rotate-left"></i> ${tx('نشاطي الأخير', 'My recent activity')}`,
        activity.length
          ? table(
              [{ label: tx('التاريخ', 'Date') }, { label: tx('الإجراء', 'Action') }, { label: tx('الكيان', 'Entity') }, { label: tx('المرجع', 'Reference') }],
              activity.map(a => ({
                cells: [fmtDateTime(a.created_at), `<span class="o_cell_main">${a.action || '—'}</span>`,
                  a.entity || '—', a.reference || (a.entity_id ? String(a.entity_id).slice(0, 8) : '—')]
              }))
            )
          : empty(tx('لا يوجد نشاط مسجل', 'No recorded activity')))}
    </div>
  </div>`;
}

function bind(_, main) {
  const save = main.querySelector('#profSave');
  if (save) save.onclick = async () => {
    const form = main.querySelector('#profileForm');
    const d = Object.fromEntries(new FormData(form).entries());
    const id = window.__session?.id;
    if (!id) return;
    save.disabled = true;
    try {
      await updateRow('profiles', id, { name: d.name || null, phone: d.phone || null });
      if (window.__session) {
        window.__session.name = d.name || window.__session.name;
        if (window.__session.profile) window.__session.profile.name = d.name || window.__session.profile.name;
      }
      toast(tx('تم تحديث الملف الشخصي', 'Profile updated'), 'success');
    } catch (e) {
      toast(navigator.onLine ? String(e.message || e) : tx('يتطلب تعديل الملف اتصالًا بالإنترنت', 'Editing your profile requires a connection'), 'error');
    } finally { save.disabled = false; }
  };
}

OW.wms = OW.wms || {};
OW.wms.toggleProfileLang = () => toggleLang();
OW.wms.refreshProfile = async () => {
  try { await pullAll(); } catch (e) { toast(String(e.message || e), 'error'); }
  import('./core-router.js').then(({ showPage }) => showPage('profile'));
};

OW.registerPage('profile', {
  brand: { name: 'OW', icon: 'fa-regular fa-circle-user' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('ملفي', 'My profile'), page: 'profile' },
    { label: tx('المزامنة', 'Synchronization'), page: 'sync' },
    { label: tx('حول النظام', 'About'), page: 'about' }
  ],
  render,
  mount: bind
});

export default OW.pages.profile;
