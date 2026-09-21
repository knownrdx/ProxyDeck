#!/usr/bin/env node
/**
 * Builds dist/proxydeck-<version>.zip containing exactly the files Chrome needs.
 * No dependencies — writes a stored+deflated ZIP by hand.
 *
 * Always test the SHIPPED artifact, not the working tree:
 *   node tools/build-zip.js
 *   unzip -o dist/proxydeck-*.zip -d "$LOCALAPPDATA/Temp/pd-ship"
 *   EXT_DIR="$LOCALAPPDATA/Temp/pd-ship" bash tools/restart-chrome.sh
 *   CDP_PORT=9335 python tools/e2e.py
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const INCLUDE = ['manifest.json', 'src', 'icons'];
const SKIP_EXT = new Set(['.md', '.log']);

function walk(rel, out = []) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name), out);
  } else if (!SKIP_EXT.has(path.extname(rel))) {
    out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

const files = INCLUDE.flatMap((p) => walk(p));

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const locals = [];
const central = [];
let offset = 0;

for (const name of files) {
  const data = fs.readFileSync(path.join(ROOT, name));
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(0, 10);          // time
  lh.writeUInt16LE(0x21, 12);       // date (2000-01-01)
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(payload.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  locals.push(lh, nameBuf, payload);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(payload.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt32LE(0, 38);          // external attrs
  ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `proxydeck-${manifest.version}.zip`);
fs.writeFileSync(out, Buffer.concat([...locals, centralBuf, eocd]));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`Built ${out}  (${files.length} files, ${kb} KB)`);
for (const f of files) console.log('  ' + f);
