import { crc32 } from './cauchy_fallback.js';

function writeU16LE(view, offset, value) {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(view, offset, value) {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
  view[offset + 2] = (value >>> 16) & 0xff;
  view[offset + 3] = (value >>> 24) & 0xff;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

export function zipStore(files) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name.replace(/\\/g, '/'));
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + nameBytes.length + file.data.length);
    writeU32LE(local, 0, 0x04034b50);
    writeU16LE(local, 4, 20);
    writeU16LE(local, 6, 0);
    writeU16LE(local, 8, 0);
    writeU16LE(local, 10, time);
    writeU16LE(local, 12, date);
    writeU32LE(local, 14, crc);
    writeU32LE(local, 18, file.data.length);
    writeU32LE(local, 22, file.data.length);
    writeU16LE(local, 26, nameBytes.length);
    writeU16LE(local, 28, 0);
    local.set(nameBytes, 30);
    local.set(file.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    writeU32LE(central, 0, 0x02014b50);
    writeU16LE(central, 4, 20);
    writeU16LE(central, 6, 20);
    writeU16LE(central, 8, 0);
    writeU16LE(central, 10, 0);
    writeU16LE(central, 12, time);
    writeU16LE(central, 14, date);
    writeU32LE(central, 16, crc);
    writeU32LE(central, 20, file.data.length);
    writeU32LE(central, 24, file.data.length);
    writeU16LE(central, 28, nameBytes.length);
    writeU16LE(central, 30, 0);
    writeU16LE(central, 32, 0);
    writeU16LE(central, 34, 0);
    writeU16LE(central, 36, 0);
    writeU32LE(central, 38, 0);
    writeU32LE(central, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  writeU32LE(eocd, 0, 0x06054b50);
  writeU16LE(eocd, 4, 0);
  writeU16LE(eocd, 6, 0);
  writeU16LE(eocd, 8, files.length);
  writeU16LE(eocd, 10, files.length);
  writeU32LE(eocd, 12, centralSize);
  writeU32LE(eocd, 16, offset);
  writeU16LE(eocd, 20, 0);

  const out = new Uint8Array(offset + centralSize + eocd.length);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}
