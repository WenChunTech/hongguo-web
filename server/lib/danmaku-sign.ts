// SPDX-License-Identifier: GPL-3.0-only
// 红果/番茄弹幕接口的请求签名（X-Gorgon / X-Ladon / X-Argus）。
// Ported from hongguo-drama src/native/danmaku-sign.js (GPL-3.0), which adapts
// dawei233/hongguo-drama, itself a JS port of nas-backend/danmaku.py (guoapp Go).
//
// 硬约束（与上游一致）：
// 1. 不得“修正”参考实现里看似 bug 的写法（例如 RC4 KSA 的 box[i]=box[j] 赋值）。
// 2. 全部 64 位运算使用 BigInt 并显式掩码。
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { sm3 } from './sm3';

const M64 = (1n << 64n) - 1n;
const M32 = (1n << 32n) - 1n;

export const md5 = (data: Buffer | string) => createHash('md5').update(data).digest();

const rotl32 = (x: bigint, n: number) => {
  const v = x & 0xFFFFFFFFn;
  const s = BigInt(n & 31);
  return ((v << s) | (v >> ((32n - s) & 31n))) & 0xFFFFFFFFn;
};

const rotl64 = (x: bigint, n: number) => {
  const v = BigInt.asUintN(64, x);
  const s = BigInt(((n % 64) + 64) % 64);
  return BigInt.asUintN(64, (v << s) | (v >> ((64n - s) & 63n)));
};

const rotr64 = (x: bigint, n: number) => rotl64(x, -n);

const rotl8 = (x: number, n: number) => {
  const v = x & 0xff;
  const s = n & 7;
  return ((v << s) | (v >> ((8 - s) & 7))) & 0xff;
};

const reverse8 = (x: number) => {
  let v = x & 0xff;
  v = ((v & 0xf0) >> 4) | ((v & 0x0f) << 4);
  v = ((v & 0xcc) >> 2) | ((v & 0x33) << 2);
  v = ((v & 0xaa) >> 1) | ((v & 0x55) << 1);
  return v & 0xff;
};

/** PKCS#7，恒定补齐 1~16 字节。 */
function pad(data: Buffer) {
  const padding = 16 - (data.length % 16);
  return Buffer.concat([Buffer.from(data), Buffer.alloc(padding, padding)]);
}

const u64le = (buf: Buffer) => BigInt.asUintN(64, buf.readBigUInt64LE(0));
const putU64le = (value: bigint, target: Buffer, offset: number) =>
  target.writeBigUInt64LE(BigInt.asUintN(64, value), offset);

function uvarint(value: bigint): Buffer {
  let v = BigInt.asUintN(64, value);
  const out: number[] = [];
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) out.push(byte | 0x80);
    else {
      out.push(byte);
      return Buffer.from(out);
    }
  }
}

/** 与 Go 的 newHongguoDeviceID 一致：1e18 + 随机数，19 位数字串。 */
export function newDeviceId(random: (n: number) => Buffer = randomBytes) {
  const raw = BigInt.asUintN(64, BigInt('0x' + random(8).toString('hex')));
  return String(1000000000000000000n + (raw % 8000000000000000000n));
}

function baseParams(deviceId: string, installId: string): Record<string, string> {
  return {
    aid: '8662',
    app_name: 'novelread',
    version_code: '73532',
    version_name: '7.3.5.32',
    manifest_version_code: '73532',
    update_version_code: '73532',
    channel: 'update_64',
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    device_type: '25053RT47C',
    device_brand: 'Redmi',
    language: 'zh',
    os_api: '36',
    os_version: '16',
    resolution: '1280*2772',
    dpi: '520',
    ac: 'wifi',
    device_id: deviceId,
    iid: installId,
  };
}

// 模仿 Python 的 urlencode（默认 quote_plus）：encodeURIComponent 不转义 !'()*，
// 签名对 query 字节级敏感，必须补齐。
const quotePlus = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

const encodeQuery = (pairs: [string, string][]) =>
  pairs.map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join('&');

/** 键按字典序排序后编码，与 Go 的 url.Values.Encode 行为一致。 */
export function buildQuery({ stampMs, deviceId, installId, random = randomBytes }: {
  stampMs: number; deviceId?: string; installId?: string; random?: (n: number) => Buffer;
}) {
  const params = baseParams(deviceId ?? newDeviceId(random), installId ?? newDeviceId(random));
  params._rticket = String(stampMs);
  const pairs = Object.entries(params).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) as [string, string][];
  return encodeQuery(pairs);
}

/** 带 nonce 变体的 X-Gorgon。box[i] = box[j] 是赋值不是交换：照抄参考实现。 */
export function commentXGorgon(rawQuery: string, stamp: number, nonce: Buffer) {
  const head2 = ((nonce[0] % 7) + 1) << 5;
  const head3 = 0xe0 | (nonce[1] & 0x0f);

  const seed = Buffer.alloc(20);
  const digest = md5(Buffer.from(rawQuery, 'utf8'));
  digest.copy(seed, 0, 0, 4);
  seed.set([0, 1, 7, 4], 12);
  seed.writeUInt32BE(Number(BigInt(stamp) & M32), 16);

  const key = Buffer.from([0x4a, 0x00, 0x16, head3, 0x47, 0x6c, 0x00, head2]);

  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + box[i] + key[i & 7]) & 0xff;
    box[i] = box[j];
  }

  j = 0;
  for (let offset = 0; offset < 20; offset++) {
    const i = (offset + 1) & 0xff;
    j = (j + box[i]) & 0xff;
    box[i] = box[j];
    seed[offset] ^= box[(box[i] + box[j]) & 0xff];
  }

  for (let i = 0; i < 20; i++) {
    seed[i] = (reverse8(rotl8(seed[i], 4) ^ seed[(i + 1) % 20]) ^ 0xeb) & 0xff;
  }

  return Buffer.concat([Buffer.from([0x84, 0x04, head2 & 0xff, head3 & 0xff, 0x00, 0x00]), seed]).toString('hex');
}

/** 34 轮 uint64 密钥扩展 + TEA 风格变换 + base64。 */
export function commentLadon(aid: string, timestamp: number, prefix: Buffer) {
  const digest = Buffer.from(md5(Buffer.concat([Buffer.from(prefix), Buffer.from(String(aid), 'utf8')])).toString('hex'), 'ascii');

  let left = u64le(digest.subarray(0, 8));
  let right = u64le(digest.subarray(8, 16));
  const queue = [u64le(digest.subarray(16, 24)), u64le(digest.subarray(24, 32))];

  const keys: bigint[] = [];
  for (let i = 0; i < 34; i++) {
    keys.push(left);
    const mixed = BigInt.asUintN(64, (rotr64(right, 8) + left) ^ BigInt(i));
    queue.push(mixed);
    left = BigInt.asUintN(64, mixed ^ rotl64(left, 3));
    right = queue.shift()!;
  }

  const data = Buffer.from(pad(Buffer.from(`${Math.trunc(timestamp)}-1611921764-3019`, 'utf8')));
  for (let offset = 0; offset < data.length; offset += 16) {
    let bl = u64le(data.subarray(offset, offset + 8));
    let br = u64le(data.subarray(offset + 8, offset + 16));
    for (const key of keys) {
      br = BigInt.asUintN(64, key ^ BigInt.asUintN(64, bl + rotr64(br, 8)));
      bl = BigInt.asUintN(64, br ^ rotl64(bl, 3));
    }
    putU64le(bl, data, offset);
    putU64le(br, data, offset + 8);
  }

  return Buffer.concat([Buffer.from(prefix), data]).toString('base64');
}

const ARGUS_KEY = Buffer.from('ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c', 'hex');

/** 手写 protobuf 组包 + SM3 派生 + 72 轮变换 + AES-128-CBC 封装。 */
export function commentArgus(rawQuery: string, timestamp: number, nonce: Buffer) {
  const key = ARGUS_KEY;
  const parts: Buffer[] = [];

  const varint = (field: number, value: bigint) => {
    parts.push(uvarint(BigInt(field) * 8n));
    parts.push(uvarint(value));
  };
  const bytesField = (field: number, value: Buffer) => {
    parts.push(uvarint(BigInt(field) * 8n + 2n));
    parts.push(uvarint(BigInt(value.length)));
    parts.push(Buffer.from(value));
  };

  varint(1, BigInt(0x20200929 * 2));
  varint(2, 2n);
  varint(3, BigInt(nonce.readUInt32LE(6)));
  bytesField(4, Buffer.from('3019'));
  bytesField(6, Buffer.from('1611921764'));
  bytesField(7, Buffer.from('6.8.1.32'));
  bytesField(8, Buffer.from('v04.07.01-ml-android'));
  varint(9, 135135744n);
  bytesField(10, Buffer.alloc(8));
  varint(12, BigInt.asUintN(64, BigInt(timestamp) * 2n));

  const bodyHash = sm3(Buffer.alloc(16));
  const queryHash = sm3(Buffer.from(rawQuery, 'utf8'));
  bytesField(13, bodyHash.subarray(0, 6));
  bytesField(14, queryHash.subarray(0, 6));

  const nested = [0x08, (2 + (nonce[10] % 49) * 2) & 0xff];
  for (const field of [2, 3, 4]) {
    nested.push(...uvarint(BigInt(field) * 8n));
    nested.push(...uvarint(1388734n));
  }
  bytesField(15, Buffer.from(nested));
  bytesField(20, Buffer.from('none'));
  varint(21, 738n);

  const data = Buffer.from(pad(Buffer.concat(parts)));

  const derived = sm3(Buffer.concat([key, Buffer.from([0x3c, 0xcc, 0x56, 0x7b]), key]));

  const rounds = new Array<bigint>(72).fill(0n);
  for (let i = 0; i < 4; i++) rounds[i] = u64le(derived.subarray(i * 8, i * 8 + 8));
  for (let i = 4; i < 72; i++) {
    let mixed = BigInt.asUintN(64, rotr64(rounds[i - 1], 3) ^ rounds[i - 3]);
    mixed = BigInt.asUintN(64, mixed ^ rotr64(mixed, 1));
    rounds[i] = BigInt.asUintN(
      64,
      (~rounds[i - 4] & M64)
        ^ mixed
        ^ (BigInt.asUintN(64, 0x3DC94C3A046D678Bn >> BigInt((i - 4) % 62)) & 1n)
        ^ 3n,
    );
  }

  for (let offset = 0; offset < data.length; offset += 16) {
    let left = u64le(data.subarray(offset, offset + 8));
    let right = u64le(data.subarray(offset + 8, offset + 16));
    for (const round of rounds) {
      const next = BigInt.asUintN(64, left ^ (rotl64(right, 1) & rotl64(right, 8)) ^ rotl64(right, 2) ^ round);
      left = right;
      right = next;
    }
    putU64le(left, data, offset);
    putU64le(right, data, offset + 8);
  }

  const xor = Buffer.from([0xd0, 0x4f, 0xfd, 0xff, 0xd0, 0x4f, 0xfd, 0xff]);
  for (let i = 0; i < data.length; i++) data[i] ^= xor[i % 8];
  const reversed = Buffer.concat([xor, data]).reverse();

  const container = pad(Buffer.concat([
    Buffer.from([0xa6, 0xe7, 0x83, 0xee, 0x70, 0x01, 0x10, 0x09, 0x18]),
    reversed,
    Buffer.from([0x56, 0x7b]),
  ]));

  // 明文长度已是 16 的整数倍，且不再追加填充：必须关掉自动填充。
  const cipher = createCipheriv('aes-128-cbc', md5(key.subarray(0, 16)), md5(key.subarray(16)));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(container), cipher.final()]);

  return Buffer.concat([Buffer.from([0x3c, 0xcc]), encrypted]).toString('base64');
}

/**
 * 产出全部签名头部。nonce 必须是 11 字节：
 * [0:2] 进 Gorgon、[2:6] 进 Ladon、[6:11] 进 Argus。
 */
export function signCommentHeaders({ rawQuery, stamp, nonce, aid = '8662' }: {
  rawQuery: string; stamp: number; nonce: Buffer; aid?: string;
}) {
  return {
    'X-Gorgon': commentXGorgon(rawQuery, stamp, nonce),
    'X-Khronos': String(Math.trunc(stamp)),
    'X-SS-Req-Ticket': String(Math.trunc(stamp) * 1000),
    'X-SS-STUB': '',
    'X-Argus': commentArgus(rawQuery, stamp, nonce),
    'X-Ladon': commentLadon(aid, stamp, nonce.subarray(2, 6)),
  };
}

export const NONCE_BYTES = 11;
