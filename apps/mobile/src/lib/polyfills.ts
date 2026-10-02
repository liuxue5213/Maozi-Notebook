/**
 * Hermes 引擎缺少若干 Web 全局对象,而业务代码(uuid v7 / dedupe 的 crypto.subtle /
 * TextEncoder)依赖它们。必须在其它业务模块之前导入本文件。
 * subtle.digest 用 expo-crypto 的 digest 原生实现兜底;算法名与 Web 保持一致。
 */
import * as ExpoCrypto from 'expo-crypto';

type DigestInput = ArrayBuffer | Uint8Array;

const toBytes = (data: DigestInput): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data);

type CryptoLike = {
  getRandomValues?: (array: ArrayBufferView) => ArrayBufferView;
  randomUUID?: () => string;
  subtle?: {
    digest?: (algorithm: string | { name: string }, data: DigestInput) => Promise<ArrayBuffer>;
  };
};

const g = globalThis as typeof globalThis & { crypto?: CryptoLike; TextEncoder?: unknown; TextDecoder?: unknown };

if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (array: ArrayBufferView) =>
    ExpoCrypto.getRandomValues(array as Uint8Array) as unknown as ArrayBufferView;
}
if (!g.crypto.randomUUID) {
  g.crypto.randomUUID = () => ExpoCrypto.randomUUID();
}
if (!g.crypto.subtle?.digest) {
  g.crypto.subtle = {
    digest: async (algorithm, data) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const out = await (ExpoCrypto.digest as unknown as (
        a: string, d: Uint8Array,
      ) => Promise<Uint8Array> | Uint8Array)(name, toBytes(data));
      // subtle.digest 契约返回 ArrayBuffer(兼容同步/异步两种 expo 实现)
      const u8 = out instanceof Uint8Array ? out : new Uint8Array(out as unknown as ArrayBuffer);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    },
  };
}

// Hermes 无 TextEncoder/TextDecoder(RN 0.86 仍未内置),dedupe 等处需要
if (!g.TextEncoder) {
  g.TextEncoder = class {
    encode(input = ''): Uint8Array {
      const out: number[] = [];
      for (const codePoint of input) {
        let c = codePoint.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  } as unknown as { encode: (s?: string) => Uint8Array };
}
if (!g.TextDecoder) {
  g.TextDecoder = class {
    decode(input?: ArrayBuffer | Uint8Array): string {
      if (!input) return '';
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i];
        let cp: number;
        if (b < 0x80) { cp = b; i += 1; }
        else if (b < 0xe0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
        else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
        else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  } as unknown as { decode: (d?: ArrayBuffer | Uint8Array) => string };
}
