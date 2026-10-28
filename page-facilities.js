// page-facilities.js
// صفحة إدارة المستودعات والهيكل التنظيمي — تستنسخ منطق OW facilitiesV12 + facilityModal + saveFacility
// مع تكييفها لواجهة OW (render/mount) واستخدام core-api-supabase.

import {
  listHierarchy,
  createWarehouse, updateWarehouse, deleteWarehouse,
  createStorageArea, updateStorageArea, deleteStorageArea,
  createSection, updateSection, deleteSection,
  createShelf, updateShelf, deleteShelf
} from './core-api-supabase.js';
import { fmtDate, esc, uuid } from './core-utils.js';
import { printDocument } from './core-ui.js';
import { qrSvg } from './core-qr.js';
import { friendlyError } from './core-i18n.js';
import { toast } from './core-toast.js';
import { currentUser } from './core-auth.js';
import { can, isAdmin, accessibleWarehouseIds } from './core-rbac.js';
import { OW } from './core-registry.js';

// ============ حالة محلية للصفحة ============
const localState = {
  hierarchy: {
    warehouses: [], storage_areas: [], zones: [], sections: [], shelves: []
  },
  selectedWarehouseId: null,
  loading: false,
  error: null
};

// ============ تحميل البيانات مع مراعاة الصلاحيات ============
async function loadAll() {
  localState.loading = true;
  localState.error = null;
  try {
    const hierarchy = await listHierarchy();
    // فلترة حسب المستودعات المسموح بها (null = كل شيء)
    const allowed = accessibleWarehouseIds();
    if (allowed !== null) {
      hierarchy.warehouses    = hierarchy.warehouses.filter(w => allowed.includes(w.id));
      hierarchy.storage_areas = hierarchy.storage_areas.filter(a => allowed.includes(a.warehouse_id));
      hierarchy.zones         = hierarchy.zones.filter(z => allowed.includes(z.warehouse_id));
      hierarchy.sections      = hierarchy.sections.filter(s => allowed.includes(s.warehouse_id));
      hierarchy.shelves       = hierarchy.shelves.filter(s => allowed.includes(s.warehouse_id));
    }
    localState.hierarchy = hierarchy;
    if (!localState.selectedWarehouseId && hierarchy.warehouses.length) {
      localState.selectedWarehouseId = hierarchy.warehouses[0].id;
    }
    // إن كان المستودع المختار محذوفًا، اختر أول متاح
    if (localState.selectedWarehouseId &&
        !hierarchy.warehouses.find(w => w.id === localState.selectedWarehouseId)) {
      localState.selectedWarehouseId = hierarchy.warehouses[0]?.id || null;
    }
    return true;
  } catch (e) {
    console.error('[facilities] load failed', e);
    localState.error = friendlyError(e, 'تعذر تحميل بيانات المستودعات. تحقق من الاتصال ثم أعد المحاولة.');
    return false;
  } finally {
    localState.loading = false;
  }
}

// ============ مساعدات عرض ============
function findWarehouse(id) { return localState.hierarchy.warehouses.find(w => w.id === id); }
function findArea(id)      { return localState.hierarchy.storage_areas.find(a => a.id === id); }
function findZone(id)      { return localState.hierarchy.zones.find(z => z.id === id); }
function findSection(id)   { return localState.hierarchy.sections.find(s => s.id === id); }
function findShelf(id)     { return localState.hierarchy.shelves.find(s => s.id === id); }

function areaName(shelf) {
  // نُظهر storage_area الحديث إن وُجد، وإلا zone القديم
  const a = shelf.storage_area_id ? findArea(shelf.storage_area_id) : null;
  if (a) return a.name;
  const z = shelf.zone_id ? findZone(shelf.zone_id) : null;
  return z?.name || '—';
}

function sectionName(section) {
  const z = section.zone_id ? findZone(section.zone_id) : null;
  return z?.name || '—';
}

function currentWh() {
  return localState.selectedWarehouseId ? findWarehouse(localState.selectedWarehouseId) : null;
}

// ============ بطاقات إحصائية ============
function statsCards() {
  const h = localState.hierarchy;
  return `
    <div class="o_facilities_stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:20px">
      ${[
        ['المستودعات', h.warehouses.length, 'fa-warehouse', '#714B67'],
        ['مناطق التخزين', h.storage_areas.length, 'fa-map-location-dot', '#985184'],
        ['الأقسام', h.sections.length, 'fa-layer-group', '#5B899E'],
        ['الأرفف', h.shelves.length, 'fa-bars-staggered', '#a24689']
      ].map(([label, val, icon, color]) => `
        <div class="o_facility_stat" style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-size:11px;color:#8a919a;font-weight:600;text-transform:uppercase;letter-spacing:.3px">${label}</span>
            <i class="fa-solid ${icon}" style="color:${color};font-size:18px;opacity:.7"></i>
          </div>
          <div style="font-size:26px;font-weight:700;color:#111827">${val}</div>
        </div>`).join('')}
    </div>`;
}

// ============ جدول المستودعات ============
function warehousesTable() {
  const wh = localState.hierarchy.warehouses;
  const sel = localState.selectedWarehouseId;
  if (!wh.length) {
    return `<div style="text-align:center;padding:40px;color:#9ca3af">
      لا توجد مستودعات. اضغط "مستودع جديد" للبدء.
    </div>`;
  }
  const rows = wh.map(w => {
    const areas = localState.hierarchy.storage_areas.filter(a => a.warehouse_id === w.id).length;
    const shelves = localState.hierarchy.shelves.filter(s => s.warehouse_id === w.id).length;
    const isSel = w.id === sel;
    return `<tr class="${isSel ? 'selected' : ''}" style="${isSel ? 'background:#f5eff3' : ''}">
      <td><input type="radio" name="wh-select" ${isSel ? 'checked' : ''}
                 onchange="window.__facilitySelectWarehouse('${w.id}')"
                 aria-label="Select"></td>
      <td class="o_ref">${esc(w.code)}</td>
      <td><strong>${esc(w.name)}</strong></td>
      <td class="num">${areas}</td>
      <td class="num">${shelves}</td>
      <td>
        <button class="o_btn o_btn_secondary" title="QR"
                onclick="window.__facilityPrintQR('warehouse','${w.id}')">
          <i class="fa-solid fa-qrcode"></i>
        </button>
        <button class="o_btn o_btn_secondary" title="تعديل"
                onclick="window.__facilityEdit('warehouse','${w.id}')">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="o_btn o_btn_secondary" title="حذف"
                onclick="window.__facilityDelete('warehouse','${w.id}')">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </td>
    </tr>`;
  }).join('');

  return `<div class="o_list_wrap"><table class="o_list_table">
    <thead><tr>
      <th></th><th>الرمز</th><th>الاسم</th>
      <th class="num">مناطق</th><th class="num">أرفف</th><th>إجراءات</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ============ جدول مناطق التخزين ============
function storageAreasTable() {
  const wh = currentWh();
  if (!wh) return `<div style="padding:30px;text-align:center;color:#9ca3af">اختر مستودعًا أولًا.</div>`;
  const areas = localState.hierarchy.storage_areas.filter(a => a.warehouse_id === wh.id);
  if (!areas.length) {
    return `<div style="padding:30px;text-align:center;color:#9ca3af">
      لا توجد مناطق تخزين في ${esc(wh.name)}.
    </div>`;
  }
  const rows = areas.map(a => {
    const zonesShelves = localState.hierarchy.shelves.filter(s => s.storage_area_id === a.id).length;
    const sections = localState.hierarchy.sections.filter(s => s.zone_id === a.legacy_zone_id).length;
    return `<tr>
      <td class="o_ref">${esc(a.code)}</td>
      <td><strong>${esc(a.name)}</strong></td>
      <td class="num">${sections}</td>
      <td class="num">${zonesShelves}</td>
      <td><span class="o_badge o_badge_${a.is_active === false ? 'gray' : 'green'}">${a.is_active === false ? 'معطلة' : 'نشطة'}</span></td>
      <td>
        <button class="o_btn o_btn_secondary" title="QR"
                onclick="window.__facilityPrintQR('area','${a.id}')">
          <i class="fa-solid fa-qrcode"></i>
        </button>
        <button class="o_btn o_btn_secondary" title="تعديل"
                onclick="window.__facilityEdit('area','${a.id}')">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="o_btn o_btn_secondary" title="حذف"
                onclick="window.__facilityDelete('area','${a.id}')">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="o_list_wrap"><table class="o_list_table">
    <thead><tr><th>الرمز</th><th>الاسم</th><th class="num">أقسام</th>
      <th class="num">أرفف</th><th>الحالة</th><th>إجراءات</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ============ جدول الأقسام ============
function sectionsTable() {
  const wh = currentWh();
  if (!wh) return `<div style="padding:30px;text-align:center;color:#9ca3af">اختر مستودعًا أولًا.</div>`;
  const sections = localState.hierarchy.sections.filter(s => s.warehouse_id === wh.id);
  if (!sections.length) {
    return `<div style="padding:30px;text-align:center;color:#9ca3af">
      لا توجد أقسام في ${esc(wh.name)}. الأقسام مواقع داخلية اختيارية.
    </div>`;
  }
  const rows = sections.map(s => {
    const shelvCount = localState.hierarchy.shelves.filter(x => x.section_id === s.id).length;
    return `<tr>
      <td class="o_ref">${esc(s.code)}</td>
      <td><strong>${esc(s.name)}</strong></td>
      <td>${esc(sectionName(s))}</td>
      <td class="num">${shelvCount}</td>
      <td>
        <button class="o_btn o_btn_secondary"
                onclick="window.__facilityEdit('section','${s.id}')">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="o_btn o_btn_secondary"
                onclick="window.__facilityDelete('section','${s.id}')">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="o_list_wrap"><table class="o_list_table">
    <thead><tr><th>الرمز</th><th>الاسم</th><th>منطقة التخزين</th>
      <th class="num">أرفف</th><th>إجراءات</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ============ جدول الأرفف ============
function shelvesTable() {
  const wh = currentWh();
  if (!wh) return `<div style="padding:30px;text-align:center;color:#9ca3af">اختر مستودعًا أولًا.</div>`;
  const shelves = localState.hierarchy.shelves.filter(s => s.warehouse_id === wh.id);
  if (!shelves.length) {
    return `<div style="padding:30px;text-align:center;color:#9ca3af">
      لا توجد أرفف في ${esc(wh.name)}. الأرفف هي أصغر وحدة تخزين.
    </div>`;
  }
  const rows = shelves
    .slice()
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map(s => {
      const sec = s.section_id ? findSection(s.section_id) : null;
      return `<tr>
        <td><input type="checkbox" data-qr-shelf="${s.id}" aria-label="QR ${esc(s.code)}"></td>
        <td class="o_ref">${esc(s.code)}</td>
        <td>${esc(areaName(s))}</td>
        <td>${esc(sec?.name || '—')}</td>
        <td style="font-family:monospace;font-size:11px;color:#6b7280">${esc(s.full_path || '—')}</td>
        <td>
          <button class="o_btn o_btn_secondary"
                  onclick="window.__facilityPrintQR('shelf','${s.id}')">
            <i class="fa-solid fa-qrcode"></i>
          </button>
          <button class="o_btn o_btn_secondary"
                  onclick="window.__facilityEdit('shelf','${s.id}')">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="o_btn o_btn_secondary"
                  onclick="window.__facilityDelete('shelf','${s.id}')">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </td>
      </tr>`;
    }).join('');
  return `<div class="o_list_wrap"><table class="o_list_table">
    <thead><tr><th></th><th>الرمز</th><th>منطقة التخزين</th>
      <th>القسم</th><th>المسار الكامل</th><th>إجراءات</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ============ النموذج المنبثق ============
function buildFacilityModal(kind, id) {
  const editing = !!id;
  const titles = {
    warehouse: editing ? 'تعديل مستودع' : 'مستودع جديد',
    area: editing ? 'تعديل منطقة تخزين' : 'منطقة تخزين جديدة',
    section: editing ? 'تعديل قسم' : 'قسم جديد',
    shelf: editing ? 'تعديل رف' : 'رف جديد'
  };
  const wh = currentWh();
  const whOptions = localState.hierarchy.warehouses.map(w =>
    `<option value="${w.id}" ${w.id === (editing ? itemWarehouseId(kind, id) : localState.selectedWarehouseId) ? 'selected' : ''}>${esc(w.name)} (${esc(w.code)})</option>`
  ).join('');

  let fieldsHtml = '';

  if (kind === 'warehouse') {
    const w = editing ? findWarehouse(id) : {};
    fieldsHtml = `
      <div class="o_field"><label>الرمز</label>
        <input name="code" value="${esc(w.code || '')}" required></div>
      <div class="o_field"><label>الاسم</label>
        <input name="name" value="${esc(w.name || '')}" required></div>`;
  }

  if (kind === 'area') {
    const a = editing ? findArea(id) : {};
    fieldsHtml = `
      <div class="o_field"><label>المستودع</label>
        <select name="warehouse_id" required>${whOptions}</select></div>
      <div class="o_field"><label>الرمز</label>
        <input name="code" value="${esc(a.code || '')}" required></div>
      <div class="o_field"><label>الاسم</label>
        <input name="name" value="${esc(a.name || '')}" required></div>`;
  }

  if (kind === 'section') {
    const s = editing ? findSection(id) : {};
    const selWh = editing ? s.warehouse_id : localState.selectedWarehouseId;
    const areas = localState.hierarchy.storage_areas.filter(a => a.warehouse_id === selWh);
    const areaOptions = areas.map(a =>
      `<option value="${a.legacy_zone_id || ''}" ${a.legacy_zone_id === s.zone_id ? 'selected' : ''}>${esc(a.name)} (${esc(a.code)})</option>`
    ).join('');
    fieldsHtml = `
      <div class="o_field"><label>المستودع</label>
        <select name="warehouse_id" required>${whOptions}</select></div>
      <div class="o_field"><label>منطقة التخزين</label>
        <select name="zone_id" required>${areaOptions || '<option value="">لا توجد مناطق — أضف منطقة أولًا</option>'}</select></div>
      <div class="o_field"><label>الرمز</label>
        <input name="code" value="${esc(s.code || '')}" required></div>
      <div class="o_field"><label>الاسم</label>
        <input name="name" value="${esc(s.name || '')}" required></div>`;
  }

  if (kind === 'shelf') {
    const sh = editing ? findShelf(id) : {};
    const selWh = editing ? sh.warehouse_id : localState.selectedWarehouseId;
    const areas = localState.hierarchy.storage_areas.filter(a => a.warehouse_id === selWh);
    const areaOptions = areas.map(a =>
      `<option value="${a.id}" ${a.id === sh.storage_area_id ? 'selected' : ''}>${esc(a.name)} (${esc(a.code)})</option>`
    ).join('');
    const selAreaId = editing ? sh.storage_area_id : areas[0]?.id;
    const sections = localState.hierarchy.sections.filter(s =>
      s.warehouse_id === selWh &&
      (!selAreaId || s.zone_id === findArea(selAreaId)?.legacy_zone_id)
    );
    const secOptions = sections.map(s =>
      `<option value="${s.id}" ${s.id === sh.section_id ? 'selected' : ''}>${esc(s.name)} (${esc(s.code)})</option>`
    ).join('');
    fieldsHtml = `
      <div class="o_field"><label>المستودع</label>
        <select name="warehouse_id" required>${whOptions}</select></div>
      <div class="o_field"><label>منطقة التخزين</label>
        <select name="storage_area_id" required>${areaOptions || '<option value="">لا توجد مناطق</option>'}</select></div>
      <div class="o_field"><label>القسم (اختياري)</label>
        <select name="section_id"><option value="">بدون قسم</option>${secOptions}</select></div>
      <div class="o_field"><label>الرمز</label>
        <input name="code" value="${esc(sh.code || '')}" required></div>
      <div class="o_field" style="grid-column:1/-1"><label>المسار الكامل (يُبنى تلقائيًا إن تركته فارغًا)</label>
        <input name="full_path" value="${esc(sh.full_path || '')}"></div>`;
  }

  return `
    <div class="o_modal" style="max-width:640px">
      <div class="o_modal_header">
        <h3>${titles[kind]}</h3>
        <button onclick="window.__facilityCloseModal()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="o_modal_body">
        <form id="facility-form" class="o_group">${fieldsHtml}</form>
        ${wh ? `<div class="o_field" style="margin-top:14px">
          <label>المستودع الحالي</label>
          <div class="val">${esc(wh.name)} (${esc(wh.code)})</div>
        </div>` : ''}
      </div>
      <div class="o_modal_footer">
        <button class="o_btn o_btn_secondary" onclick="window.__facilityCloseModal()">إلغاء</button>
        <button class="o_btn o_btn_primary" onclick="window.__facilitySave('${kind}','${id || ''}')">حفظ</button>
      </div>
    </div>`;
}

function itemWarehouseId(kind, id) {
  if (kind === 'area')   return findArea(id)?.warehouse_id;
  if (kind === 'section')return findSection(id)?.warehouse_id;
  if (kind === 'shelf')  return findShelf(id)?.warehouse_id;
  return null;
}

function showModal(html, modalId) {
  window.__facilityCloseModal();
  const overlay = document.createElement('div');
  overlay.className = 'o_modal_overlay';
  overlay.id = 'modal-facility';
  overlay.dataset.modalId = modalId;
  overlay.innerHTML = html;
  overlay.addEventListener('click', e => {
    if (e.target === overlay) window.__facilityCloseModal();
  });
  document.getElementById('modalRoot').appendChild(overlay);
  setTimeout(() => overlay.querySelector('input,select')?.focus(), 50);
}

window.__facilityCloseModal = function () {
  document.querySelectorAll('.o_modal_overlay[id^="modal-facility"]').forEach(el => el.remove());
};
// ============ CRUD Handlers ============
window.__facilitySelectWarehouse = function (id) {
  localState.selectedWarehouseId = id;
  import('./core-router.js').then(m => m.showPage('facilities'));
};

window.__facilityEdit = function (kind, id) {
  showModal(buildFacilityModal(kind, id), kind + '-' + (id || 'new'));
};

window.__facilitySave = async function (kind, id) {
  const form = document.getElementById('facility-form');
  if (!form) return;
  const data = Object.fromEntries(new FormData(form).entries());

  try {
    if (kind === 'warehouse') {
      if (!data.code?.trim() || !data.name?.trim()) {
        toast('الرمز والاسم مطلوبان', 'error'); return;
      }
      if (id) await updateWarehouse(id, data);
      else    await createWarehouse(data);
      toast('تم الحفظ');
    }
    else if (kind === 'area') {
      if (!data.warehouse_id || !data.code?.trim() || !data.name?.trim()) {
        toast('المستودع والرمز والاسم مطلوبة', 'error'); return;
      }
      if (id) await updateStorageArea(id, data);
      else    await createStorageArea(data);
      toast('تم الحفظ');
    }
    else if (kind === 'section') {
      if (!data.warehouse_id || !data.zone_id || !data.code?.trim() || !data.name?.trim()) {
        toast('كل الحقول مطلوبة', 'error'); return;
      }
      const zone = findZone(data.zone_id);
      if (!zone || zone.warehouse_id !== data.warehouse_id) {
        toast('المنطقة لا تنتمي للمستودع المحدد', 'error'); return;
      }
      if (id) await updateSection(id, data);
      else    await createSection(data);
      toast('تم الحفظ');
    }
    else if (kind === 'shelf') {
      if (!data.warehouse_id || !data.storage_area_id || !data.code?.trim()) {
        toast('المستودع ومنطقة التخزين والرمز مطلوبة', 'error'); return;
      }
      const area = findArea(data.storage_area_id);
      if (!area || area.warehouse_id !== data.warehouse_id) {
        toast('منطقة التخزين لا تنتمي للمستودع المحدد', 'error'); return;
      }
      const payload = {
        warehouse_id: data.warehouse_id,
        zone_id: area.legacy_zone_id,
        storage_area_id: area.id,
        section_id: data.section_id || null,
        code: data.code,
        full_path: data.full_path?.trim() || `${area.name} / ${data.code.trim()}`
      };
      if (id) await updateShelf(id, payload);
      else    await createShelf(payload);
      toast('تم الحفظ');
    }

    window.__facilityCloseModal();
    await loadAll();
    import('./core-router.js').then(m => m.showPage('facilities'));
  } catch (e) {
    console.error(e);
    toast(friendlyError(e, 'فشل الحفظ. تحقق من البيانات ثم أعد المحاولة.'), 'error');
  }
};

window.__facilityDelete = async function (kind, id) {
  const h = localState.hierarchy;
  let dependents = [];
  let label = '';

  if (kind === 'warehouse') {
    const w = findWarehouse(id);
    label = `${w?.name || ''}`;
    const zones = h.zones.filter(z => z.warehouse_id === id).length;
    const areas = h.storage_areas.filter(a => a.warehouse_id === id).length;
    const secs  = h.sections.filter(s => s.warehouse_id === id).length;
    const shelv = h.shelves.filter(s => s.warehouse_id === id).length;
    if (zones) dependents.push(`${zones} منطقة`);
    if (areas) dependents.push(`${areas} منطقة تخزين`);
    if (secs)  dependents.push(`${secs} قسم`);
    if (shelv) dependents.push(`${shelv} رف`);
  }
  else if (kind === 'area') {
    const a = findArea(id);
    label = `${a?.name || ''}`;
    const shelv = h.shelves.filter(s => s.storage_area_id === id).length;
    const secs  = h.sections.filter(s => s.zone_id === a?.legacy_zone_id).length;
    if (shelv) dependents.push(`${shelv} رف`);
    if (secs)  dependents.push(`${secs} قسم`);
  }
  else if (kind === 'section') {
    const s = findSection(id);
    label = `${s?.name || ''}`;
    const shelv = h.shelves.filter(x => x.section_id === id).length;
    if (shelv) dependents.push(`${shelv} رف`);
  }
  else if (kind === 'shelf') {
    const s = findShelf(id);
    label = `${s?.code || ''}`;
  }

  let msg = `حذف "${label}"؟`;
  if (dependents.length) {
    msg += `\n\nتنبيه: يوجد ${dependents.join('، ')} مرتبطة. إذا كانت قاعدة البيانات تمنع الحذف ستظهر رسالة خطأ — احذف العناصر التابعة أولًا.`;
  }
  if (!confirm(msg)) return;

  try {
    if (kind === 'warehouse')  await deleteWarehouse(id);
    if (kind === 'area')       await deleteStorageArea(id);
    if (kind === 'section')    await deleteSection(id);
    if (kind === 'shelf')      await deleteShelf(id);
    toast('تم الحذف');
    await loadAll();
    import('./core-router.js').then(m => m.showPage('facilities'));
  } catch (e) {
    console.error(e);
    toast(friendlyError(e, 'فشل الحذف — قد تكون هناك سجلات تابعة'), 'error');
  }
};

// ============ طباعة QR ============
function qrPayload(kind, record) {
  const typeMap = { warehouse: 'warehouse', area: 'zone', section: 'section', shelf: 'shelf' };
  return JSON.stringify({
    app: 'OW-WMS',
    version: 1,
    type: typeMap[kind] || kind,
    id: record.id,
    code: record.code || '',
    name: record.name || record.full_path || ''
  });
}

function printLabels(records) {
  if (!records?.length) { toast('حدد سجلًا واحدًا على الأقل', 'warning'); return; }
  let labels = '';
  try {
    labels = records.map(r => `
      <div class="label">
        <div class="qr">${qrSvg(r.payload, { cellSize: 5, label: r.code || r.name || 'QR' })}</div>
        <h3>${esc(r.code || r.name || '')}</h3>
        <p>${esc(r.typeLabel || r.type)}</p>
        ${r.detail ? `<p style="font-size:10px">${esc(r.detail)}</p>` : ''}
      </div>`).join('');
  } catch (e) {
    console.error(e);
    toast('تعذر توليد رموز QR. أعد تحميل الصفحة ثم حاول مرة أخرى.', 'error');
    return;
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>QR Labels</title>
    <style>
      body{font-family:Arial,Tahoma,sans-serif;margin:14mm;direction:rtl;color:#172033}
      .labels{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}
      .label{border:1px solid #cbd5e1;border-radius:8px;padding:5mm 2mm;text-align:center;break-inside:avoid}
      .label h3{font-size:11pt;margin:2mm 0 1mm;overflow-wrap:anywhere}
      .label p{font-size:8pt;color:#64748b;margin:1mm 0}
      .qr{display:flex;justify-content:center;min-height:34mm}
      .qr svg{display:block;width:32mm;height:32mm}
      @media print{body{margin:6mm}.label{border:1px solid #ddd}}
    </style>
  </head><body>
    <h2>OW — QR Labels</h2>
    <div class="labels">${labels}</div>
  </body></html>`;
  if (!printDocument(html)) toast('اسمح بالنوافذ المنبثقة', 'error');
}

window.__facilityPrintQR = async function (kind, id) {
  const map = {
    warehouse: { record: findWarehouse(id), typeLabel: 'مستودع' },
    area:      { record: findArea(id),      typeLabel: 'منطقة تخزين' },
    shelf:     { record: findShelf(id),     typeLabel: 'رف' }
  };
  const m = map[kind];
  if (!m?.record) { toast('السجل غير موجود', 'error'); return; }
  const payload = qrPayload(kind, m.record);
  await printLabels([{
    id: m.record.id,
    code: m.record.code || '',
    name: m.record.name || '',
    type: kind,
    typeLabel: m.typeLabel,
    detail: m.record.full_path || '',
    payload
  }]);
};

window.__facilityPrintAllShelves = async function () {
  const wh = currentWh();
  if (!wh) { toast('اختر مستودعًا أولًا', 'warning'); return; }
  const shelves = localState.hierarchy.shelves.filter(s => s.warehouse_id === wh.id);
  if (!shelves.length) { toast('لا توجد أرفف في هذا المستودع', 'warning'); return; }
  const records = shelves.map(s => ({
    id: s.id,
    code: s.code,
    name: areaName(s),
    type: 'shelf',
    typeLabel: 'رف',
    detail: s.full_path || '',
    payload: qrPayload('shelf', s)
  }));
  await printLabels(records);
};

// ============ ربط أحداث النموذج ============
function bindModalDependencies() {
  const overlay = document.getElementById('modal-facility');
  if (!overlay) return;
  const form = overlay.querySelector('#facility-form');
  if (!form) return;

  const whSel = form.querySelector('[name="warehouse_id"]');
  const areaSel = form.querySelector('[name="storage_area_id"]');
  const secSel = form.querySelector('[name="section_id"]');

  if (whSel && areaSel) {
    whSel.addEventListener('change', () => {
      const whId = whSel.value;
      const areas = localState.hierarchy.storage_areas.filter(a => a.warehouse_id === whId);
      areaSel.innerHTML = areas.length
        ? areas.map(a => `<option value="${a.id}">${esc(a.name)} (${esc(a.code)})</option>`).join('')
        : '<option value="">لا توجد مناطق</option>';
      if (secSel) secSel.innerHTML = '<option value="">بدون قسم</option>';
    });
  }
  if (areaSel && secSel) {
    areaSel.addEventListener('change', () => {
      const areaId = areaSel.value;
      const area = findArea(areaId);
      const sections = localState.hierarchy.sections.filter(s =>
        s.zone_id === area?.legacy_zone_id
      );
      secSel.innerHTML = '<option value="">بدون قسم</option>' +
        sections.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`).join('');
    });
  }
}

// بعد كل عرض للنموذج، نربط
const origShowModal = showModal;
showModal = function (html, modalId) {
  origShowModal(html, modalId);
  bindModalDependencies();
};

// ============ الصفحة (API العام) ============
const facilitiesPage = {
  name: 'facilities',
  brand: { name: 'المستودعات', icon: 'fa-solid fa-warehouse' },
  menu: [
    { label: 'لوحة التحكم', page: 'dashboard' },
    { label: 'المخزون',     page: 'inventory' },
    { label: 'المعاملات',   page: 'transactions' },
    { label: 'المستودعات',  page: 'facilities' },
    { label: 'التقارير',    page: 'reports' }
  ],

  async render() {
    await loadAll();

    if (localState.error) {
      return `
        <div class="o_control_panel">
          <div class="o_cp_top">
            <div class="o_breadcrumb">
              <a onclick="showPage('dashboard')">OW</a>
              <span class="sep">/</span>
              <span class="current">المستودعات</span>
            </div>
          </div>
        </div>
        <div style="padding:60px;text-align:center">
          <div style="font-size:48px;color:#dc2626;margin-bottom:16px">
            <i class="fa-solid fa-triangle-exclamation"></i>
          </div>
          <h2 style="margin:0 0 8px;font-size:18px;color:#111827">تعذر تحميل بيانات المستودعات</h2>
          <p style="color:#6b7280;font-size:13px;margin:0 0 20px">${esc(localState.error)}</p>
          <button class="o_btn o_btn_primary" onclick="window.__facilityReload()">
            <i class="fa-solid fa-rotate-right"></i> إعادة المحاولة
          </button>
        </div>`;
    }

    const wh = currentWh();

    return `
      <div class="o_control_panel">
        <div class="o_cp_top">
          <div class="o_breadcrumb">
            <a onclick="showPage('dashboard')">OW</a>
            <span class="sep">/</span>
            <span class="current">المستودعات</span>
          </div>
        </div>
        <div class="o_cp_bottom">
          <div class="o_cp_buttons">
            <button class="o_btn o_btn_primary" onclick="window.__facilityEdit('warehouse','')">
              <i class="fa-solid fa-plus"></i> مستودع جديد
            </button>
            ${wh ? `
              <button class="o_btn o_btn_secondary" onclick="window.__facilityEdit('area','')">
                <i class="fa-solid fa-plus"></i> منطقة تخزين
              </button>
              <button class="o_btn o_btn_secondary" onclick="window.__facilityEdit('section','')">
                <i class="fa-solid fa-plus"></i> قسم
              </button>
              <button class="o_btn o_btn_secondary" onclick="window.__facilityEdit('shelf','')">
                <i class="fa-solid fa-plus"></i> رف
              </button>
              <button class="o_btn o_btn_secondary" onclick="window.__facilityPrintAllShelves()">
                <i class="fa-solid fa-qrcode"></i> طباعة QR للأرفف
              </button>
            ` : ''}
            <button class="o_btn o_btn_ghost" onclick="window.__facilityReload()" title="تحديث">
              <i class="fa-solid fa-rotate-right"></i>
            </button>
          </div>
        </div>
      </div>

      <div class="o_facilities_page" style="padding:16px;max-width:1400px;margin:0 auto">
        ${statsCards()}

        <div class="o_facilities_card" style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:18px;margin-bottom:16px">
          <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#374151">
            <i class="fa-solid fa-warehouse" style="color:#714B67;margin-inline-end:6px"></i>
            المستودعات
          </h3>
          ${warehousesTable()}
        </div>

        ${wh ? `
          <div class="o_facilities_card" style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:18px;margin-bottom:16px">
            <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#374151">
              <i class="fa-solid fa-map-location-dot" style="color:#985184;margin-inline-end:6px"></i>
              مناطق التخزين — ${esc(wh.name)}
            </h3>
            ${storageAreasTable()}
          </div>

          <div class="o_facilities_card" style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:18px;margin-bottom:16px">
            <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#374151">
              <i class="fa-solid fa-layer-group" style="color:#5B899E;margin-inline-end:6px"></i>
              الأقسام — ${esc(wh.name)}
            </h3>
            ${sectionsTable()}
          </div>

          <div class="o_facilities_card" style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:18px;margin-bottom:16px">
            <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;color:#374151">
              <i class="fa-solid fa-bars-staggered" style="color:#a24689;margin-inline-end:6px"></i>
              الأرفف — ${esc(wh.name)}
            </h3>
            ${shelvesTable()}
          </div>
        ` : ''}
      </div>`;
  },

  mount() {
    window.__facilityReload = async () => {
      await loadAll();
      const m = await import('./core-router.js');
      m.showPage('facilities');
    };
  }
};

OW.registerPage('facilities', facilitiesPage);

export default facilitiesPage;