/** 应用锁(T-04):生物识别优先,PIN 降级。PIN 哈希 = SHA-256(盐+PIN) 迭代 5000 次(简化 PBKDF2;Hermes 无原生 PBKDF2)。
 *  状态存 SecureStore:enabled / salt / pinHash / failCount / lockUntil。失败 5 次退避 60s。 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const K_ENABLED = 'lock_enabled';
const K_SALT = 'lock_salt';
const K_HASH = 'lock_hash';
const K_FAIL = 'lock_fail';
const K_LOCKUNTIL = 'lock_until';

const S = (k: string) => SecureStore.getItemAsync(k);
const SSET = (k: string, v: string) => SecureStore.setItemAsync(k, v);
const SDEL = (k: string) => SecureStore.deleteItemAsync(k);

async function hashPin(pin: string, salt: string): Promise<string> {
  let h = `${salt}:${pin}`;
  for (let i = 0; i < 5000; i++) {
    const bytes: number[] = [];
    for (let i = 0; i < h.length; i++) {
      const c = h.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    const d = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
    h = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return h;
}

export async function isLockEnabled(): Promise<boolean> {
  return (await S(K_ENABLED)) === '1';
}

/** 启用:优先生物识别;返回 'biometric' | 'pin'(设置了 PIN) | 'none'(都不可用) */
export async function enableLock(): Promise<'biometric' | 'pin' | 'none'> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const enrolled = hasHardware ? await LocalAuthentication.isEnrolledAsync() : false;
  await SSET(K_ENABLED, '1');
  if (enrolled) {
    await SDEL(K_SALT); await SDEL(K_HASH); await SDEL(K_FAIL); await SDEL(K_LOCKUNTIL);
    return 'biometric';
  }
  return 'pin';
}

export async function disableLock(): Promise<void> {
  await SDEL(K_ENABLED); await SDEL(K_SALT); await SDEL(K_HASH); await SDEL(K_FAIL); await SDEL(K_LOCKUNTIL);
}

export async function setPin(pin: string): Promise<void> {
  const salt = Array.from(await Crypto.getRandomBytesAsync(16), (b) => b.toString(16).padStart(2, '0')).join('');
  await SSET(K_SALT, salt);
  await SSET(K_HASH, await hashPin(pin, salt));
  await SDEL(K_FAIL); await SDEL(K_LOCKUNTIL);
}

export async function hasPin(): Promise<boolean> {
  return !!(await S(K_HASH));
}

export async function biometricAvailable(): Promise<boolean> {
  const has = await LocalAuthentication.hasHardwareAsync();
  return has && (await LocalAuthentication.isEnrolledAsync());
}

export async function biometricAuth(): Promise<boolean> {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: '解锁 帽子记账本' });
  return r.success;
}

/** PIN 校验;失败计数,5 次锁 60s。返回 'ok' | 'wrong' | 'locked' */
export async function verifyPin(pin: string): Promise<'ok' | 'wrong' | 'locked'> {
  const until = Number((await S(K_LOCKUNTIL)) ?? 0);
  if (until > Date.now()) return 'locked';
  const hash = await S(K_HASH);
  if (!hash) return 'ok';
  if ((await hashPin(pin, (await S(K_SALT)) ?? '')) === hash) {
    await SDEL(K_FAIL); await SDEL(K_LOCKUNTIL);
    return 'ok';
  }
  const fails = Number((await S(K_FAIL)) ?? 0) + 1;
  await SSET(K_FAIL, String(fails));
  if (fails >= 5) {
    await SSET(K_LOCKUNTIL, String(Date.now() + 60_000));
    await SDEL(K_FAIL);
    return 'locked';
  }
  return 'wrong';
}
