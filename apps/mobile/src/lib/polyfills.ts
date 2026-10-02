/**
 * Hermes 引擎没有 Web Crypto 全局对象,而 uuid v7(newId)与 dedupe(crypto.subtle)都依赖它。
 * 必须在其它业务模块之前导入:用 expo-crypto 补齐 getRandomValues/randomUUID。
 * subtle 仅在需要哈希去重时用到,Hermes 无原生实现,这里留空对象并在调用处降级。
 */
import * as ExpoCrypto from 'expo-crypto';

type CryptoLike = {
  getRandomValues?: (array: ArrayBufferView) => ArrayBufferView;
  randomUUID?: () => string;
  subtle?: Record<string, unknown>;
};

const g = globalThis as typeof globalThis & { crypto?: CryptoLike };

if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (array: ArrayBufferView) =>
    ExpoCrypto.getRandomValues(array as Uint8Array) as unknown as ArrayBufferView;
}
if (!g.crypto.randomUUID) {
  g.crypto.randomUUID = () => ExpoCrypto.randomUUID();
}
