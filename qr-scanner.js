// ============================================================================
// OW — QR scanner (camera + manual fallback)
// ----------------------------------------------------------------------------
// BarcodeDetector is used where the browser supports it; jsQR is the fallback
// (loaded by qr-reader.js). The scanner understands both the current OW-WMS
// payload and the legacy ORSHAP-WMS payloads printed by the previous app.
// ============================================================================
import { OW } from './core-registry.js';
import { tx } from './core-i18n.js';
import { modal } from './core-modal.js';
import { toast } from './core-toast.js';
import { playSound } from './core-sound.js';
import {
  store, stockQty, warehouseName, areaName, sectionName,
  shelfPath, itemNameOnly
} from './core-store.js';
import { fmtNum } from './core-utils.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const KIND_ALIASES = {
  item: 'item', items: 'item',
  shelf: 'shelf', shelves: 'shelf',
  zone: 'storage_area', zones: 'storage_area', area: 'storage_area', areas: 'storage_area',
  storage_area: 'storage_area', storagearea: 'storage_area', storage_areas: 'storage_area',
  warehouse: 'warehouse', warehouses: 'warehouse',
  category: 'item_category', categories: 'item_category',
  item_category: 'item_category', item_categories: 'item_category',
  section: 'section', sections: 'section'
};

const ENTITY = {
  item: {
    table: 'items',
    label: () => tx('صنف', 'Item'),
    title: record => itemNameOnly(record) || tx('تفاصيل الصنف', 'Item details'),
    code: record => record.code || record.item_number || record.id,
    name: record => itemNameOnly(record),
    codes: record => [record.code, record.item_number, record.id]
  },
  shelf: {
    table: 'shelves',
    label: () => tx('رف', 'Shelf'),
    title: record => record.full_path || record.code || tx('تفاصيل الرف', 'Shelf details'),
    code: record => record.code || record.id,
    name: record => record.full_path || record.code || '',
    codes: record => [record.code, record.full_path, record.id]
  },
  storage_area: {
    table: 'storage_areas',
    label: () => tx('منطقة تخزين', 'Storage area'),
    title: record => record.name || record.code || tx('تفاصيل منطقة التخزين', 'Storage area details'),
    code: record => record.code || record.id,
    name: record => record.name || record.code || '',
    codes: record => [record.code, record.name, record.id]
  },
  warehouse: {
    table: 'warehouses',
    label: () => tx('مستودع', 'Warehouse'),
    title: record => record.name || record.code || tx('تفاصيل المستودع', 'Warehouse details'),
    code: record => record.code || record.id,
    name: record => record.name || record.code || '',
    codes: record => [record.code, record.name, record.id]
  },
  item_category: {
    table: 'item_categories',
    label: () => tx('تصنيف أصناف', 'Item category'),
    title: record => record.name || record.code || tx('تفاصيل التصنيف', 'Category details'),
    code: record => record.code || record.id,
    name: record => record.name || record.code || '',
    codes: record => [record.code, record.name, record.id]
  },
  section: {
    table: 'sections',
    label: () => tx('قسم', 'Section'),
    title: record => record.name || record.code || tx('تفاصيل القسم', 'Section details'),
    code: record => record.code || record.id,
    name: record => record.name || record.code || '',
    codes: record => [record.code, record.name, record.id]
  }
};

const SEARCH_ORDER = ['item', 'shelf', 'storage_area', 'warehouse', 'item_category', 'section'];
const norm = value => String(value ?? '').trim().toLocaleLowerCase();

function normalKind(value) {
  return KIND_ALIASES[String(value || '').trim().toLowerCase()] || '';
}

function findRecord(kind, id) {
  const meta = ENTITY[kind];
  if (!meta || !id) return null;
  return store.byId(meta.table, id);
}

function findCode(kind, code) {
  const meta = ENTITY[kind];
  const needle = norm(code);
  if (!meta || !needle) return null;
  return store.get(meta.table).find(record =>
    meta.codes(record).some(value => norm(value) === needle)
  ) || null;
}

export function resolveQrPayload(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  let parsed = null;
  if (value.startsWith('{')) {
    try { parsed = JSON.parse(value); } catch (_) { parsed = null; }
  }

  if (parsed && typeof parsed === 'object') {
    const kind = normalKind(parsed.type || parsed.kind || parsed.entity);
    let record = kind ? findRecord(kind, parsed.id) : null;
    if (record) return { kind, record, id: record.id, raw: value, payload: parsed };

    const code = parsed.code || parsed.item_number || parsed.sku;
    if (kind && code) {
      record = findCode(kind, code);
      if (record) return { kind, record, id: record.id, raw: value, payload: parsed };
    }
    if (!record && parsed.id) {
      for (const candidate of SEARCH_ORDER) {
        record = findRecord(candidate, parsed.id);
        if (record) return { kind: candidate, record, id: record.id, raw: value, payload: parsed };
      }
    }
  }

  for (const kind of SEARCH_ORDER) {
    const record = findCode(kind, value);
    if (record) return { kind, record, id: record.id, raw: value, payload: null };
  }

  return null;
}

function activeSession(sessionId) {
  if (sessionId) {
    const session = store.byId('stocktake_sessions', sessionId);
    return session && session.status === 'IN_PROGRESS' ? session : null;
  }
  return [...store.get('stocktake_sessions')]
    .filter(session => session.status === 'IN_PROGRESS'
      && ['DRAFT', 'REJECTED'].includes(String(session.review_status || 'DRAFT').toUpperCase()))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

function recordBody(resolution) {
  const { kind, record } = resolution;
  const meta = ENTITY[kind];
  if (!meta) return '';
  const pairs = [];
  const add = (label, value) => {
    if (value == null || value === '') return;
    pairs.push(`<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`);
  };

  add(tx('الرمز', 'Code'), meta.code(record));
  if (kind === 'item') {
    add(tx('الاسم', 'Name'), itemNameOnly(record));
    add(tx('الوحدة الأساسية', 'Base unit'), record.base_unit || '—');
    add(tx('المتاح', 'On hand'), `${fmtNum(stockQty(record.id) || 0)} ${record.base_unit || ''}`.trim());
    add(tx('حد الأمان', 'Safety stock'), record.safety_stock ?? 0);
    add(tx('الحالة', 'Status'), record.status || 'ACTIVE');
  } else if (kind === 'shelf') {
    add(tx('المسار', 'Path'), record.full_path || shelfPath(record.id));
    add(tx('المستودع', 'Warehouse'), warehouseName(record.warehouse_id));
    add(tx('منطقة التخزين', 'Storage area'), areaName(record.storage_area_id));
    add(tx('القسم', 'Section'), record.section_id ? sectionName(record.section_id) : '');
  } else if (kind === 'storage_area') {
    add(tx('الاسم', 'Name'), record.name);
    add(tx('المستودع', 'Warehouse'), warehouseName(record.warehouse_id));
  } else if (kind === 'warehouse') {
    add(tx('الاسم', 'Name'), record.name);
  } else {
    add(tx('الاسم', 'Name'), record.name);
    add(tx('الوصف', 'Description'), record.description || '');
  }

  return `<div class="o_item_head">
      <div class="o_item_avatar"><i class="fa-solid ${kind === 'item' ? 'fa-box' : kind === 'shelf' ? 'fa-layer-group' : 'fa-qrcode'}"></i></div>
      <div><div class="o_tx_ref">${esc(meta.title(record))}</div><div class="o_muted">${esc(meta.label())} · ${esc(meta.code(record))}</div></div>
    </div>
    <div class="o_detail_grid">${pairs.join('')}</div>`;
}

function openResolvedRecord(resolution) {
  if (resolution.kind === 'item') {
    if (typeof OW.wms?.openItemDetails === 'function') {
      OW.wms.openItemDetails(resolution.record.id);
      return;
    }
    if (typeof OW.wms?.itemModal === 'function') {
      OW.wms.itemModal(resolution.record.id);
      return;
    }
  }
  const meta = ENTITY[resolution.kind];
  if (!meta) return;
  modal({
    title: `<i class="fa-solid fa-qrcode"></i> ${esc(meta.title(resolution.record))}`,
    size: 'md',
    body: recordBody(resolution),
    footer: `<button class="o_btn o_btn_primary" data-close>${tx('إغلاق', 'Close')}</button>`,
    onMount: (el, close) => {
      el.querySelector('[data-close]').onclick = close;
    }
  });
}

function canUseLiveCamera() {
  return !!navigator.mediaDevices?.getUserMedia
    && (window.isSecureContext || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
}

/**
 * Decode a QR code from a still photo. This is the reliable path on phones
 * opened over plain HTTP (LAN IP), where getUserMedia is blocked but the
 * native camera/file picker still works.
 */
async function decodeQrImageFile(file) {
  if (!file) return '';
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('image load failed'));
    });

    if ('BarcodeDetector' in window) {
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        const found = await detector.detect(image);
        if (found?.length && found[0].rawValue) return found[0].rawValue;
      } catch (_) { /* fall through to jsQR */ }
    }

    if (!window.jsQR && window.orshapQrReaderReady) {
      try { await window.orshapQrReaderReady; } catch (_) {}
    }
    if (!window.jsQR) {
      throw new Error(tx('تعذر تحميل قارئ QR المحلي. أعد تحميل الصفحة ثم حاول مرة أخرى.',
        'The local QR decoder could not be loaded. Reload the page and try again.'));
    }

    const maxWidth = 1400;
    const scale = Math.min(1, maxWidth / Math.max(1, image.naturalWidth || image.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
    return decoded?.data || '';
  } finally {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
}

function cameraMessage(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) {
    return tx('تم رفض الوصول إلى الكاميرا. اسمح بالكاميرا من إعدادات المتصفح ثم أعد المحاولة.',
      'Camera permission was denied. Allow camera access in the browser then try again.');
  }
  if (name === 'NotFoundError' || /not found|no camera/i.test(message)) {
    return tx('لم يتم العثور على كاميرا على هذا الجهاز.', 'No camera was found on this device.');
  }
  if (name === 'NotReadableError' || /in use|readable/i.test(message)) {
    return tx('تعذر تشغيل الكاميرا لأنها مستخدمة في تطبيق آخر.', 'The camera could not start because another app is using it.');
  }
  if (/secure|https|localhost/i.test(message)) {
    return tx('الكاميرا المباشرة تتطلب HTTPS أو localhost. استخدم «التقاط صورة QR» بدلاً منها.',
      'The live camera requires HTTPS or localhost. Use “Take QR photo” instead.');
  }
  return tx('تعذر تشغيل الكاميرا. تحقق من إذن الكاميرا ثم أعد المحاولة.',
    'Could not start the camera. Check the camera permission and try again.');
}

export function openQrScanner(options = {}) {
  const mode = options.mode === 'stocktake' ? 'stocktake' : 'lookup';
  const cameraOnly = mode === 'stocktake';
  const state = {
    stream: null,
    frame: 0,
    running: false,
    busy: false,
    detector: null,
    canvas: null,
    ctx: null,
    lastDecode: 0,
    resolving: false,
    stopped: false
  };
  let startButton = null;
  let stopButton = null;
  let video = null;
  let viewport = null;
  let statusEl = null;
  let feedbackEl = null;
  let manualInput = null;

  const setStatus = text => {
    if (statusEl) statusEl.textContent = text || '';
  };
  const setFeedback = (html = '') => {
    if (feedbackEl) feedbackEl.innerHTML = html;
  };
  const showError = message => {
    setFeedback(`<div class="o_alert o_alert_danger"><i class="fa-solid fa-triangle-exclamation"></i><div>${esc(message)}</div></div>`);
    setStatus(message);
  };

  function stopCamera() {
    state.stopped = true;
    state.running = false;
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = 0;
    if (state.stream) {
      state.stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
      state.stream = null;
    }
    if (video) {
      try { video.pause(); } catch (_) {}
      video.srcObject = null;
      video.hidden = true;
    }
    viewport?.classList.remove('has-video');
    if (startButton) startButton.hidden = false;
    if (stopButton) stopButton.hidden = true;
  }

  async function startCamera() {
    if (state.resolving) return;
    state.stopped = false;
    setFeedback('');
    if (!canUseLiveCamera()) {
      showError(tx('الكاميرا المباشرة تتطلب HTTPS أو localhost. استخدم زر «التقاط صورة QR» بدلاً منها، فهو يعمل حتى عبر HTTP.',
        'The live camera requires HTTPS or localhost. Use “Take QR photo” instead; it works over HTTP.'));
      return;
    }

    stopCamera();
    state.stopped = false;
    setStatus(tx('جارٍ تشغيل الكاميرا…', 'Starting the camera…'));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      if (state.stopped) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      state.stream = stream;
      video.srcObject = stream;
      video.hidden = false;
      viewport.classList.add('has-video');
      await video.play();
      if (startButton) startButton.hidden = true;
      if (stopButton) stopButton.hidden = false;

      if ('BarcodeDetector' in window) {
        try { state.detector = new window.BarcodeDetector({ formats: ['qr_code'] }); }
        catch (_) { state.detector = null; }
      }
      if (!state.detector && !window.jsQR) {
        setStatus(tx('جارٍ تحميل قارئ QR الاحتياطي…', 'Loading QR decoder fallback…'));
        try { await window.orshapQrReaderReady; } catch (_) {}
      }
      if (!state.detector && !window.jsQR) {
        throw new Error(tx('تعذر تحميل قارئ QR المحلي. أعد تحميل الصفحة ثم أعد فتح الكاميرا.',
          'The local QR decoder could not be loaded. Reload the page and reopen the camera.'));
      }

      state.running = true;
      setStatus(tx('وجّه الكاميرا إلى رمز QR بوضوح وأبقِه داخل الإطار.',
        'Aim at the QR code and keep it inside the frame.'));
      state.canvas = document.createElement('canvas');
      state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });
      state.lastDecode = 0;
      state.frame = requestAnimationFrame(scanFrame);
    } catch (error) {
      stopCamera();
      showError(cameraMessage(error));
    }
  }

  async function scanFrame() {
    if (!state.running || !state.stream) return;
    if (!video?.isConnected) { stopCamera(); return; }
    const now = performance.now();
    if (!state.busy && video.readyState >= 2 && video.videoWidth > 0 && now - state.lastDecode > 140) {
      state.busy = true;
      state.lastDecode = now;
      try {
        let value = '';
        if (state.detector) {
          // A failing native detector must never block the jsQR fallback.
          try {
            const found = await state.detector.detect(video);
            if (found?.length) value = found[0].rawValue || '';
          } catch (_) {
            state.detector = null;
          }
        }
        if (!value && window.jsQR && state.ctx) {
          const maxWidth = 900;
          const scale = Math.min(1, maxWidth / video.videoWidth);
          state.canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          state.canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          state.ctx.drawImage(video, 0, 0, state.canvas.width, state.canvas.height);
          const frame = state.ctx.getImageData(0, 0, state.canvas.width, state.canvas.height);
          const decoded = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
          if (decoded?.data) value = decoded.data;
        }
        if (value) {
          if (manualInput) manualInput.value = value;
          stopCamera();
          submitRaw(value);
          return;
        }
      } catch (error) {
        if (!/NotFoundException/i.test(String(error?.name || ''))) {
          setStatus(tx('وجّه الكاميرا إلى رمز QR بوضوح وأبقِه داخل الإطار.',
            'Aim at the QR code and keep it inside the frame.'));
        }
      } finally {
        state.busy = false;
      }
    }
    if (state.running) state.frame = requestAnimationFrame(scanFrame);
  }

  function stocktakeResolution(resolution) {
    if (!resultAllowed(resolution)) return;
    const session = activeSession(options.sessionId);
    if (!session) {
      showError(tx('افتح جلسة جرد نشطة أولاً، ثم امسح رمز الرف.',
        'Open an active stocktake session first, then scan a shelf QR.'));
      return;
    }
    let lines = [];
    if (resolution.kind === 'shelf') {
      lines = store.get('stocktake_lines').filter(line =>
        line.session_id === session.id && line.shelf_id === resolution.id
      );
    } else if (resolution.kind === 'item') {
      lines = store.get('stocktake_lines').filter(line =>
        line.session_id === session.id && line.item_id === resolution.id
      );
    } else {
      showError(tx('وضع الجرد بالكاميرا يتطلب مسح QR لرف أو صنف.',
        'Camera stocktake requires a shelf or item QR.'));
      return;
    }
    if (!lines.length) {
      showError(resolution.kind === 'shelf'
        ? tx('لا توجد أسطر جرد لهذا الرف في الجلسة الحالية.',
          'No stocktake lines for this shelf in the current session.')
        : tx('لا توجد أسطر جرد لهذا الصنف في الجلسة الحالية.',
          'No stocktake lines for this item in the current session.'));
      return;
    }
    finishWith({ ...resolution, session, lines });
  }

  function resultAllowed(resolution) {
    return !!resolution?.record;
  }

  function finishWith(payload) {
    if (state.resolving) return;
    state.resolving = true;
    stopCamera();
    modalRef.close();
    setTimeout(() => {
      if (typeof options.onResolved === 'function') options.onResolved(payload);
      else openResolvedRecord(payload);
    }, 90);
  }

  function submitRaw(raw) {
    const value = String(raw ?? '').trim();
    if (!value) {
      playSound('error');
      showError(tx('امسح رمز QR أو أدخل الرمز يدوياً.', 'Scan a QR code or enter its value manually.'));
      return;
    }
    const resolution = resolveQrPayload(value);
    if (!resolution) {
      playSound('error');
      showError(tx('لم يتم التعرف على الرمز. جرّب رمز الصنف أو ملصق QR صادراً من النظام.',
        'Code not recognized. Try an item code or an OW-generated QR label.'));
      if (startButton) startButton.hidden = false;
      return;
    }
    playSound('success');
    if (manualInput) manualInput.value = value;
    if (mode === 'stocktake') stocktakeResolution(resolution);
    else finishWith(resolution);
  }

  const modalRef = modal({
    title: `<i class="fa-solid fa-qrcode"></i> ${cameraOnly
      ? tx('الجرد بالكاميرا', 'Camera stocktake')
      : tx('مسح رمز QR', 'Scan QR code')}`,
    size: 'md',
    body: `
      <p class="o_qr_intro">${cameraOnly
        ? tx('وجّه كاميرا الهاتف إلى QR الرف أو الصنف؛ ستظهر الأسطر لتسجيل الكمية الفعلية. وإذا لم تعمل الكاميرا المباشرة فالتقط صورة للرمز.',
          'Point the phone camera at a shelf or item QR; its count lines will appear. If the live camera is unavailable, take a photo of the code.')
        : tx('وجّه الكاميرا إلى رمز QR أو أدخل رمز الصنف يدوياً. الكاميرا المباشرة تحتاج HTTPS أو localhost، بينما «التقاط صورة QR» يعمل أيضاً عبر HTTP.',
          'Point the camera at a QR code or enter an item code manually. The live camera needs HTTPS or localhost, while “Take QR photo” also works over HTTP.')}</p>
      <div class="o_qr_camera">
        <div class="o_qr_viewport">
          <video playsinline muted aria-label="QR scanner camera"></video>
          <div class="o_qr_placeholder"><i class="fa-solid fa-camera"></i><span>${tx('اضغط تشغيل الكاميرا ثم وجّهها إلى الرمز.', 'Start the camera, then point it at the code.')}</span></div>
          <div class="o_qr_frame" aria-hidden="true"></div>
        </div>
        <div class="o_qr_controls">
          <button type="button" class="o_btn o_btn_secondary" data-qr-start><i class="fa-solid fa-camera"></i> ${tx('تشغيل الكاميرا', 'Start camera')}</button>
          <button type="button" class="o_btn o_btn_secondary" data-qr-stop hidden><i class="fa-solid fa-stop"></i> ${tx('إيقاف الكاميرا', 'Stop camera')}</button>
          <span class="o_qr_status"></span>
        </div>
        <div class="o_qr_photo_tools">
          <input type="file" accept="image/*" capture="environment" data-qr-photo-input hidden>
          <input type="file" accept="image/*" data-qr-upload-input hidden>
          <button type="button" class="o_btn o_btn_primary" data-qr-photo><i class="fa-solid fa-camera-retro"></i> ${tx('التقاط صورة QR', 'Take QR photo')}</button>
          <button type="button" class="o_btn o_btn_ghost o_btn_sm" data-qr-upload><i class="fa-regular fa-image"></i> ${tx('اختيار صورة', 'Choose image')}</button>
        </div>
        <p class="o_qr_photo_hint">${tx('التقاط صورة يعمل على الهاتف حتى عند فتح التطبيق عبر HTTP.',
          'Photo capture works on phones even when the app is opened over HTTP.')}</p>
      </div>
      <form class="o_qr_manual" data-qr-form>
        <input type="text" data-qr-value autocomplete="off" spellcheck="false" placeholder="${tx('رمز الصنف أو محتوى QR', 'Item code or QR payload')}" aria-label="${tx('رمز الصنف أو محتوى QR', 'Item code or QR payload')}">
        <button type="submit" class="o_btn o_btn_primary"><i class="fa-solid fa-arrow-right-to-bracket"></i> ${tx('فتح', 'Open')}</button>
      </form>
      <div class="o_qr_feedback"></div>`,
    footer: `<button type="button" class="o_btn o_btn_secondary" data-qr-close>${tx('إغلاق', 'Close')}</button>`,
    closeOnBackdrop: true,
    onClose: stopCamera,
    onMount: (el, close) => {
      video = el.querySelector('video');
      viewport = el.querySelector('.o_qr_viewport');
      statusEl = el.querySelector('.o_qr_status');
      feedbackEl = el.querySelector('.o_qr_feedback');
      manualInput = el.querySelector('[data-qr-value]');
      startButton = el.querySelector('[data-qr-start]');
      stopButton = el.querySelector('[data-qr-stop]');
      const photoInput = el.querySelector('[data-qr-photo-input]');
      const uploadInput = el.querySelector('[data-qr-upload-input]');
      const readPhoto = async input => {
        const file = input.files?.[0];
        input.value = '';
        if (!file || state.resolving) return;
        stopCamera();
        setFeedback('');
        setStatus(tx('جارٍ قراءة صورة QR…', 'Reading the QR photo…'));
        try {
          const value = await decodeQrImageFile(file);
          if (value) {
            if (manualInput) manualInput.value = value;
            submitRaw(value);
          } else {
            showError(tx('لم نعثر على رمز QR واضح في الصورة. قرّب الكاميرا من الرمز وأعد التصوير.',
              'No clear QR code was found in the photo. Move closer to the code and try again.'));
          }
        } catch (error) {
          console.error('[qr] photo decode failed', error);
          showError(tx('تعذر قراءة الصورة. جرّب صورة أخرى أو التقط صورة أوضح.',
            'The image could not be read. Try another photo or take a clearer one.'));
        }
      };
      startButton.onclick = startCamera;
      stopButton.onclick = () => {
        stopCamera();
        setStatus(tx('أوقف الكاميرا. يمكنك إدخال الرمز يدوياً أو تشغيلها مجدداً.',
          'Camera stopped. Enter the code manually or start it again.'));
      };
      el.querySelector('[data-qr-photo]').onclick = () => { stopCamera(); photoInput.click(); };
      el.querySelector('[data-qr-upload]').onclick = () => { stopCamera(); uploadInput.click(); };
      photoInput.addEventListener('change', () => readPhoto(photoInput));
      uploadInput.addEventListener('change', () => readPhoto(uploadInput));
      el.querySelector('[data-qr-close]').onclick = close;
      el.querySelector('[data-qr-form]').addEventListener('submit', event => {
        event.preventDefault();
        submitRaw(manualInput.value);
      });
      const liveAllowed = canUseLiveCamera();
      setTimeout(() => {
        if (options.autoStart !== false && liveAllowed) startCamera();
        else {
          if (!liveAllowed) {
            setStatus(tx('الكاميرا المباشرة غير متاحة على هذا الاتصال. استخدم «التقاط صورة QR» أو الإدخال اليدوي.',
              'The live camera is unavailable on this connection. Use “Take QR photo” or manual entry.'));
          }
          setTimeout(() => manualInput?.focus({ preventScroll: true }), 30);
        }
      }, 40);
    }
  });

  return modalRef;
}

OW.openQrScanner = openQrScanner;
OW.resolveQrPayload = resolveQrPayload;
OW.wms = OW.wms || {};
OW.wms.openQrScanner = openQrScanner;
OW.wms.resolveQrPayload = resolveQrPayload;
OW.wms.quickScan = () => {
  if (OW.currentPage === 'stocktake' && typeof OW.wms.stocktakeScan === 'function') {
    return OW.wms.stocktakeScan();
  }
  return openQrScanner({
    mode: 'lookup',
    onResolved: resolved => {
      if (resolved.kind === 'item' && typeof OW.wms.quickIssue === 'function') {
        return OW.wms.quickIssue(resolved.id);
      }
      if (resolved.kind === 'shelf' && typeof OW.wms.quickIssue === 'function') {
        return OW.wms.quickIssue(null, { shelfId: resolved.id });
      }
      toast(tx('امسح QR صنف أو رف لبدء صرف سريع.', 'Scan an item or shelf QR to start a quick issue.'), 'warning');
    }
  });
};
