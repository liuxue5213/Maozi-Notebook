/** 应用锁(T-04):生物识别优先,PIN 降级。PIN 哈希 = 盐 + SHA-256 链式迭代(N-2 自适应 KDF)。
 *  迭代数在启用时按本机吞吐校准,目标单次派生 ≈250ms(与 Web PBKDF2-150k 同一量级的破解成本,
 *  且不因机型快慢差异造成解锁卡顿);迭代数随盐一起持久化,旧数据无迭代记录时回落 5000 次保持兼容。
 *  生物识别可被用户独立关闭(lock_bio_off):关掉后即使已录指纹也走 PIN 路径(需求:解锁方式自由切换)。
 *  状态存 SecureStore:enabled / salt / pinHash / iter / failCount / lockUntil。失败 5 次退避 60s。 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const K_ENABLED = 'lock_enabled';
const K_SALT = 'lock_salt';
const K_HASH = 'lock_hash';
const K_ITER = 'lock_iter';
const K_FAIL = 'lock_fail';
const K_LOCKUNTIL = 'lock_until';
const K_BIO_OFF = 'lock_bio_off';

/** 自校准目标:单次派生时长。250ms 无感解锁,暴力枚举单次成本同量级 */
const KDF_TARGET_MS = 250;
/** 校准结果夹在 [2 万, 40 万] 次:下限保底安全,上限防慢设备把校准值抬过高后解锁超时 */
const KDF_MIN_ITER = 20_000;
const KDF_MAX_ITER = 400_000;
/** 旧版哈希(固定 5000 次)的回落值:仅用于校验存量 PIN,新设 PIN 一律走校准 */
const KDF_LEGACY_ITER = 5_000;
/** 校准探针迭代数:先用小样本测吞吐,避免校准本身耗时过久 */
const KDF_PROBE_ITER = 2_000;

const S = (k: string) => SecureStore.getItemAsync(k);
const SSET = (k: string, v: string) => SecureStore.setItemAsync(k, v);
const SDEL = (k: string) => SecureStore.deleteItemAsync(k);

async function hashPin(pin: string, salt: string, iterations: number): Promise<string> {
  let h = `${salt}:${pin}`;
  for (let i = 0; i < iterations; i++) {
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

/** N-2:按本机吞吐校准迭代数 —— 探针测出单次耗时,换算到 KDF_TARGET_MS,并夹在安全区间 */
async function calibrateIterations(salt: string): Promise<number> {
  const t0 = Date.now();
  await hashPin('kdf-calibrate', salt, KDF_PROBE_ITER);
  const perIterMs = Math.max((Date.now() - t0) / KDF_PROBE_ITER, 0.001);
  const iter = Math.round(KDF_TARGET_MS / perIterMs);
  return Math.min(KDF_MAX_ITER, Math.max(KDF_MIN_ITER, iter));
}

export async function isLockEnabled(): Promise<boolean> {
  return (await S(K_ENABLED)) === '1';
}

/** 用户对生物识别的自主开关(默认开):关掉后即使录了指纹也走 PIN 路径 */
export async function isBiometricDisabled(): Promise<boolean> {
  return (await S(K_BIO_OFF)) === '1';
}

export async function setBiometricDisabled(off: boolean): Promise<void> {
  if (off) await SSET(K_BIO_OFF, '1');
  else await SDEL(K_BIO_OFF);
}

/** 当前生效的解锁方式:'pin'(生物识别被关/不可用) | 'biometric' */
export async function activeLockMode(): Promise<'pin' | 'biometric'> {
  if ((await S(K_BIO_OFF)) === '1') return 'pin';
  const has = await LocalAuthentication.hasHardwareAsync();
  const enrolled = has ? await LocalAuthentication.isEnrolledAsync() : false;
  return enrolled ? 'biometric' : 'pin';
}

/** 启用:优先生物识别;返回 'biometric' | 'pin'(设置了 PIN) | 'none'(都不可用) */
export async function enableLock(): Promise<'biometric' | 'pin' | 'none'> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const enrolled = hasHardware ? await LocalAuthentication.isEnrolledAsync() : false;
  await SSET(K_ENABLED, '1');
  if (enrolled) {
    await SDEL(K_SALT); await SDEL(K_HASH); await SDEL(K_ITER); await SDEL(K_FAIL); await SDEL(K_LOCKUNTIL);
    return 'biometric';
  }
  return 'pin';
}

export async function disableLock(): Promise<void> {
  await SDEL(K_ENABLED); await SDEL(K_SALT); await SDEL(K_HASH); await SDEL(K_ITER); await SDEL(K_FAIL); await SDEL(K_LOCKUNTIL); await SDEL(K_BIO_OFF);
}

export async function setPin(pin: string): Promise<void> {
  const salt = Array.from(await Crypto.getRandomBytesAsync(16), (b) => b.toString(16).padStart(2, '0')).join('');
  const iter = await calibrateIterations(salt);
  await SSET(K_SALT, salt);
  await SSET(K_ITER, String(iter));
  await SSET(K_HASH, await hashPin(pin, salt, iter));
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

/** PIN 校验;失败计数,5 次锁 60s。返回 'ok' | 'wrong' | 'locked'。
 *  迭代数读启用时校准并持久化的值;旧数据无记录 → 5000 次(与旧哈希口径一致)。 */
export async function verifyPin(pin: string): Promise<'ok' | 'wrong' | 'locked'> {
  const until = Number((await S(K_LOCKUNTIL)) ?? 0);
  if (until > Date.now()) return 'locked';
  const hash = await S(K_HASH);
  if (!hash) return 'ok';
  const iter = Number((await S(K_ITER)) ?? '') || KDF_LEGACY_ITER;
  if ((await hashPin(pin, (await S(K_SALT)) ?? '', iter)) === hash) {
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
