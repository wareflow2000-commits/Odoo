'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pngToIco = require('png-to-ico');

(async () => {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'assets', 'logo.png');
  const target = path.join(root, 'assets', 'ow.ico');
  if (!fs.existsSync(source)) throw new Error('Missing source app icon: assets/logo.png');
  const ico = await pngToIco(source);
  fs.writeFileSync(target, ico);
  if (fs.statSync(target).size < 1000) throw new Error('Generated ICO failed validation');
  process.stdout.write('Created assets/ow.ico from the existing OW app icon.\n');
})().catch(error => { console.error(error); process.exit(1); });
