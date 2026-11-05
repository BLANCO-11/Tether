/**
 * A minimal zip reader and writer, only what is needed to open a finished `.xlsx`, add parts to it and write it back
 * (report-charts.ts). An `.xlsx` is a zip of XML parts. Built on node:zlib so the server gains no dependency.
 *
 * Reads through the central directory (the authoritative index, so data descriptors do not matter) and handles the two
 * methods a workbook uses: stored and deflate. Zip64, encryption and multi-disk archives are refused by name, not
 * misread: a workbook this server builds is none of them.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The parts of a zip, in archive order. A Map keeps insertion order, which a workbook wants (`[Content_Types].xml` first). */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  // The end record is at least 22 bytes and may be followed by a comment of up to 65535 bytes.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");

  const parts = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error("zip central directory is damaged");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error(`zip part ${name} is encrypted`);
    if (buf.readUInt32LE(local) !== LOCAL) throw new Error(`zip part ${name} has no local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) parts.set(name, Buffer.from(raw));
    else if (method === 8) parts.set(name, inflateRawSync(raw));
    else throw new Error(`zip part ${name} uses compression method ${method}, which is not supported`);
  }
  return parts;
}

export function writeZip(parts: ReadonlyMap<string, Buffer>): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00: a fixed stamp keeps the same workbook byte-identical from run to run.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  for (const [name, data] of parts) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    out.push(local, nameBuf, packed);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(CENTRAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);

    offset += 30 + nameBuf.length + packed.length;
  }

  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(parts.size, 8);
  end.writeUInt16LE(parts.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, ...central, end]);
}
