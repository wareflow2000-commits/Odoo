/* OW QR decoder. jsQR is bundled locally (jsqr.js) and cached by the service
 * worker, so decoding works offline. There is deliberately no CDN fallback. */
(function () {
  'use strict';

  function loadLocal() {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'jsqr.js';
      script.async = true;
      script.onload = function () {
        if (window.jsQR) resolve(window.jsQR);
        else reject(new Error('jsQR global missing'));
      };
      script.onerror = function () {
        script.remove();
        reject(new Error('jsQR failed to load'));
      };
      document.head.appendChild(script);
    });
  }

  window.orshapQrReaderReady = (async function () {
    if (window.jsQR) return window.jsQR;
    return loadLocal();
  })();
  window.orshapQrReaderReady.catch(function () {});
})();
