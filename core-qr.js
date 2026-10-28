// ============================================================================
// OW — local QR rendering
// ----------------------------------------------------------------------------
// QR codes are generated entirely in the browser from the bundled
// qrcode-generator library (MIT, Kazuhiko Arase). No CDN request is made, so
// labels still print when the device is offline. Rendering to inline SVG keeps
// labels crisp in print and removes the old “wait then print” race.
// ============================================================================

const ESC = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function qrLib() {
  const lib = window.qrcode;
  if (typeof lib !== 'function') {
    throw new Error('QR generator unavailable (qrcode-generator.js not loaded)');
  }
  return lib;
}

/**
 * Render a QR code as an inline SVG string.
 *
 * @param {string} text Payload to encode.
 * @param {{cellSize?: number, margin?: number, label?: string, className?: string}} opts
 * @returns {string} SVG markup. Consumers must not re-escape the result.
 */
export function qrSvg(text, opts = {}) {
  const payload = String(text ?? '');
  if (!payload) throw new Error('QR payload is empty');
  const cellSize = Math.max(2, Number(opts.cellSize) || 4);
  const margin = Number.isFinite(opts.margin) ? Math.max(0, Number(opts.margin)) : cellSize * 4;
  const qrcode = qrLib();

  // Encode as UTF-8 so Arabic names inside the JSON survive a round-trip.
  if (qrcode.stringToBytesFuncs?.['UTF-8']) {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  }
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const size = count * cellSize + margin * 2;
  const rect = `h${cellSize}v${cellSize}h-${cellSize}z`;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        path += `M${margin + col * cellSize},${margin + row * cellSize}${rect}`;
      }
    }
  }
  const label = ESC(opts.label || 'QR');
  const className = opts.className ? ` ${ESC(opts.className)}` : '';
  return `<svg class="ow-qr${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"` +
    ` width="${size}" height="${size}" role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`;
}

/** True when the bundled generator is available. */
export function qrReady() {
  return typeof window.qrcode === 'function';
}
