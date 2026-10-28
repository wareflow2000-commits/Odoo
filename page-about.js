// ============================================================================
// OW — About
// ============================================================================
import { OW } from './core-registry.js';
import { tx, LANG } from './core-i18n.js';
import { pageHead, card, badge, btn } from './core-ui.js';
import { store } from './core-store.js';
import { fmtNum } from './core-utils.js';

const VERSION = '2.0.0';

function render() {
  const features = [
    ['fa-solid fa-boxes-stacked', tx('إدارة الأصناف والأرصدة', 'Items & balances'), tx('أكواد، وحدات، تحويلات، حد أمان، باركود QR.', 'Codes, units, conversions, safety stock, QR codes.')],
    ['fa-solid fa-right-left', tx('معاملات بدورة اعتماد', 'Transactions with approval'), tx('توريد، صرف، تسويات، مرتجعات، واعتماد تلقائي للأدوار العليا.', 'Receipts, issues, adjustments, returns and auto-approval for elevated roles.')],
    ['fa-solid fa-truck-arrow-right', tx('تحويلات بين المستودعات', 'Inter-warehouse transfers'), tx('إرسال، استلام جزئي، رفض استلام، ومراجعة مرتجعات.', 'Dispatch, partial receipt, receipt rejection and return review.')],
    ['fa-solid fa-clipboard-check', tx('جرد كامل ودوري ومفاجئ', 'Full, cycle & surprise counts'), tx('عد أعمى أو مرئي، مراجعة مستقلة، وتسوية باتجاه محدد.', 'Blind or visible counting, independent review, directed settlement.')],
    ['fa-solid fa-chart-line', tx('14 تقريرًا تشغيليًا', '14 operational reports'), tx('حركات، أرصدة، كارت صنف، صلاحيات، تدقيق، وتصدير CSV/PDF.', 'Movements, balances, item card, expiry, audit and CSV/PDF export.')],
    ['fa-solid fa-wifi', tx('عمل دون اتصال', 'Offline-first'), tx('قائمة مزامنة، كاش محلي، ودخول دون اتصال بعد أول تسجيل.', 'Sync queue, local cache and offline login after the first sign-in.')],
    ['fa-solid fa-user-shield', tx('صلاحيات دقيقة', 'Granular permissions'), tx('مصفوفة أدوار وصلاحيات مخصصة ووصول لكل مستودع.', 'Role matrix, custom permissions and per-warehouse access.')],
    ['fa-solid fa-language', tx('عربي / إنجليزي فوري', 'Instant AR / EN'), tx('تبديل فوري للاتجاه والترجمة دون إعادة تحميل.', 'Instant direction and translation switch, no reload.')]
  ];

  return `
  ${pageHead(tx('حول النظام', 'About'), tx('OW — نظام إدارة المستودعات', 'OW — Warehouse Management System'),
    `${btn(`<i class="fa-solid fa-arrow-left"></i> ${tx('لوحة التحكم', 'Dashboard')}`, `onclick="showPage('dashboard')"`, 'secondary')}`)}
  <div class="o_page_body">
    <div class="o_about_hero">
      <img src="assets/logo.png" alt="OW">
      <div>
        <h2>OW</h2>
        <p>${tx('نظام متكامل لإدارة المستودعات والمخزون والجرد والتحويلات، يعمل على الويب ودون اتصال.',
          'An integrated warehouse, inventory, counting and transfer system that works on the web and offline.')}</p>
        <div class="o_profile_badges">
          ${badge(`v${VERSION}`, 'purple')}
          ${badge(LANG === 'ar' ? 'العربية' : 'English', 'blue')}
          ${badge(navigator.onLine ? tx('متصل', 'Online') : tx('دون اتصال', 'Offline'), navigator.onLine ? 'green' : 'orange')}
          ${badge('PWA', 'gray')}
        </div>
      </div>
    </div>

    <div class="o_grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      ${features.map(([icon, title, desc]) => `
        <div class="o_feature">
          <span class="o_feature_icon"><i class="${icon}"></i></span>
          <div><b>${title}</b><p>${desc}</p></div>
        </div>`).join('')}
    </div>

    <div class="o_grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      ${card(`<i class="fa-solid fa-database"></i> ${tx('البيانات الحالية', 'Current data')}`,
        `<dl class="o_kv">
          <dt>${tx('المستودعات', 'Warehouses')}</dt><dd>${fmtNum(store.get('warehouses').length)}</dd>
          <dt>${tx('الأصناف', 'Items')}</dt><dd>${fmtNum(store.get('items').length)}</dd>
          <dt>${tx('الأرفف', 'Shelves')}</dt><dd>${fmtNum(store.get('shelves').length)}</dd>
          <dt>${tx('صفوف المخزون', 'Stock rows')}</dt><dd>${fmtNum(store.get('stock').length)}</dd>
          <dt>${tx('المعاملات', 'Transactions')}</dt><dd>${fmtNum(store.get('transactions').length)}</dd>
          <dt>${tx('سجل الحركة', 'Movement ledger')}</dt><dd>${fmtNum(store.get('inventory_ledger').length)}</dd>
        </dl>`)}
      ${card(`<i class="fa-solid fa-keyboard"></i> ${tx('اختصارات وخصائص', 'Shortcuts & capabilities')}`,
        `<dl class="o_kv">
          <dt><kbd>Ctrl</kbd> + <kbd>K</kbd></dt><dd>${tx('لوحة الأوامر والبحث السريع', 'Command palette & quick search')}</dd>
          <dt><kbd>Esc</kbd></dt><dd>${tx('إغلاق النوافذ واللوحات', 'Close modals and panels')}</dd>
          <dt>${tx('المزامنة التلقائية', 'Automatic sync')}</dt><dd>${tx('عند عودة الاتصال', 'When the connection returns')}</dd>
          <dt>${tx('الترجمة', 'Translation')}</dt><dd>${tx('زر اللغة في الشريط العلوي', 'Language button in the top bar')}</dd>
          <dt>${tx('الطباعة', 'Printing')}</dt><dd>${tx('تقارير ومعاملات وبطاقات QR', 'Reports, transactions and QR labels')}</dd>
        </dl>`)}
    </div>

    <div class="o_about_foot">
      <span>© ${new Date().getFullYear()} OW — ${tx('جميع الحقوق محفوظة', 'All rights reserved')}</span>
      <span>${tx('الإصدار', 'Version')} ${VERSION} · ${tx('واجهة OW', 'OW interface')}</span>
    </div>
  </div>`;
}

OW.registerPage('about', {
  brand: { name: 'OW', icon: 'fa-solid fa-circle-info' },
  menu: [
    { label: tx('لوحة التحكم', 'Dashboard'), page: 'dashboard' },
    { label: tx('حول النظام', 'About'), page: 'about' }
  ],
  render,
  mount: () => {}
});

export default OW.pages.about;
