'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = [
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css', 'vendor/fontawesome/css/all.min.css'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2', 'vendor/fontawesome/webfonts/fa-brands-400.woff2'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2', 'vendor/fontawesome/webfonts/fa-regular-400.woff2'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2', 'vendor/fontawesome/webfonts/fa-solid-900.woff2'],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-v4compatibility.woff2', 'vendor/fontawesome/webfonts/fa-v4compatibility.woff2'],
  ['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js', 'vendor/sql-wasm.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm', 'vendor/sql-wasm.wasm']
];

async function main() {
  for (const [url, relativePath] of assets) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    process.stdout.write('Downloading ' + relativePath + '\n');
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) throw new Error('Download failed (' + response.status + '): ' + url);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100) throw new Error('Downloaded asset is unexpectedly small: ' + relativePath);
    await fs.writeFile(target, bytes);
  }
  process.stdout.write('All local runtime assets downloaded and validated.\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
