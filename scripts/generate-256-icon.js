const fs = require('fs');
const zlib = require('zlib');
const buf = fs.readFileSync('assets/logo/logo.ico');
const count = buf.readUInt16LE(4);
if (count < 1) throw new Error('No icon entries');
const entryOffset = 6;
const icoWidth = buf.readUInt8(entryOffset) || 256;
const icoHeight = buf.readUInt8(entryOffset + 1) || 256;
const size = buf.readUInt32LE(entryOffset + 8);
const off = buf.readUInt32LE(entryOffset + 12);
const dibSize = buf.readUInt32LE(off);
const dibWidth = buf.readInt32LE(off + 4);
const dibHeight = buf.readInt32LE(off + 8);
const bpp = buf.readUInt16LE(off + 14);
if (dibWidth !== 32 || dibHeight !== 64 || bpp !== 32) {
  throw new Error(`Unexpected ICO bitmap format: ${dibWidth}x${dibHeight} @ ${bpp}`);
}
const imgWidth = 32;
const imgHeight = 32;
const pixelStart = off + dibSize;
const rowBytes = imgWidth * 4;
const rows = [];
for (let y = 0; y < imgHeight; y++) {
  const row = Buffer.alloc(rowBytes);
  const srcRow = imgHeight - 1 - y;
  const srcStart = pixelStart + srcRow * rowBytes;
  buf.copy(row, 0, srcStart, srcStart + rowBytes);
  rows.push(row);
}
const scale = 8;
const targetWidth = imgWidth * scale;
const targetHeight = imgHeight * scale;
const rgba = Buffer.alloc(targetWidth * targetHeight * 4);
for (let y = 0; y < targetHeight; y++) {
  const srcY = Math.floor(y / scale);
  for (let x = 0; x < targetWidth; x++) {
    const srcX = Math.floor(x / scale);
    const srcPos = srcY * rowBytes + srcX * 4;
    const dstPos = (y * targetWidth + x) * 4;
    rgba[dstPos] = rows[srcY][srcPos + 2];
    rgba[dstPos + 1] = rows[srcY][srcPos + 1];
    rgba[dstPos + 2] = rows[srcY][srcPos];
    rgba[dstPos + 3] = rows[srcY][srcPos + 3];
  }
}
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(targetWidth, 0);
ihdr.writeUInt32BE(targetHeight, 4);
ihdr.writeUInt8(8, 8);
ihdr.writeUInt8(6, 9);
ihdr.writeUInt8(0, 10);
ihdr.writeUInt8(0, 11);
ihdr.writeUInt8(0, 12);
const scanlines = Buffer.alloc((targetWidth * 4 + 1) * targetHeight);
for (let y = 0; y < targetHeight; y++) {
  scanlines[y * (targetWidth * 4 + 1)] = 0;
  rgba.copy(scanlines, y * (targetWidth * 4 + 1) + 1, y * targetWidth * 4, y * targetWidth * 4 + targetWidth * 4);
}
const idat = zlib.deflateSync(scanlines);
const png = Buffer.concat([pngSignature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync('assets/logo/logo-256.png', png);
console.log('Generated assets/logo/logo-256.png');
