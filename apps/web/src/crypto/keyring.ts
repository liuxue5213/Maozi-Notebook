/**
 * 字段加密密钥生命周期(F-05):DEK 由「PIN 派生的 KEK」包裹后落 localStorage。
 * 与应用锁(PBKDF2-SHA256/150k,见 security.tsx)同源不同盐:应用锁校验的是锁哈希,
 * 这里的 KEK 只用于解包 DEK —— 两者互不泄漏,改 PIN 哈希不影响 KEK 派生参数。
 *
 * 状态机:
 * - 未开启应用锁:无配置、无 DEK,字段保持明文(SecurityPanel 有明示)。
 * - 开启应用锁:enableFieldEncryption(pin) 生成 DEK + 包裹存储 + 存量明文重加密清扫。
 * - 解锁(含刷新页面后):unlockFieldEncryption(pin) 解包 DEK,并清扫「锁定期间被后台同步
 *   写入的明文」;锁定(lockFieldEncryption)只清内存 DEK,密文安全。
 * - 关闭应用锁:disableFieldEncryption(pin) 全量解密落盘后移除配置。
 */
import { aesGcmEncrypt, aesGcmDecrypt, encryptRow, TABLE_SPECS, setDek, setSuspended, hasDek } from './secure-fields';

const FENC_KEY = 'lo_fenc';
const PBKDF2_ITERATIONS = 150_000; // 与应用锁一致
const KEK_AAD = 'keyring:dek:v1';

/** 清扫目标由 db 模块注入(避免 Node/测试环境下依赖真实 IndexedDB) */
interface SweepTable {
  toArray: () => Promise<Record<string, unknown>[]>;
  bulkPut: (rows: unknown[]) => Promise<unknown>;
}
let sweepTables: Record<string, SweepTable | undefined> | null = null;
export function bindSweepTables(tables: Record<string, SweepTable | undefined>): void {
  sweepTables = tables;
}

interface StoredKeyConfig {
  v: 1;
  /** KEK 派生盐(hex) */
  ksalt: string;
  /** 包裹后的 DEK(enc1:iv:ct,AAD=KEK_AAD) */
  wrapped: string;
}

function getConfig(): StoredKeyConfig | null {
  try {
    const raw = localStorage.getItem(FENC_KEY);
    return raw ? (JSON.parse(raw) as StoredKeyConfig) : null;
  } catch {
    return null;
  }
}

export function fieldEncryptionConfigured(): boolean {
  return getConfig() !== null;
}

export function fieldEncryptionUnlocked(): boolean {
  return hasDek();
}

async function deriveKek(pin: string, ksaltHex: string): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(ksaltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** 由 PIN 解包 DEK(PIN 错误/配置损坏时抛出) */
async function loadDek(pin: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg) throw new Error('field encryption not configured');
  const kek = await deriveKek(pin, cfg.ksalt);
  const rawHex = await aesGcmDecrypt(kek, KEK_AAD, cfg.wrapped);
  const raw = new Uint8Array(rawHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  setDek(await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  raw.fill(0);
}

/** 存量明文重加密(开启应用锁后 & 每次解锁时执行,幂等) */
async function reencryptSweep(): Promise<void> {
  for (const [table, spec] of Object.entries(TABLE_SPECS)) {
    const t = sweepTables?.[table];
    if (!t) continue;
    const rows = await t.toArray();
    const changed: Record<string, unknown>[] = [];
    for (const row of rows) {
      const enc = await encryptRow(table, spec, row);
      // encryptRow 恒返回克隆:序列化对比,只写真正变化的行(避免解锁时全表重写,第 6 轮审查)
      if (JSON.stringify(enc) !== JSON.stringify(row)) changed.push(enc);
    }
    if (changed.length) await t.bulkPut(changed);
  }
}

/** 全量解密落盘(关闭应用锁):挂起写入加密后逐行还原明文 */
async function decryptSweep(): Promise<void> {
  for (const [table] of Object.entries(TABLE_SPECS)) {
    const t = sweepTables?.[table];
    if (!t) continue;
    const rows = await t.toArray(); // 中间件解密读 → 明文
    await t.bulkPut(rows); // suspended=true → 写入不再加密
  }
}

/** 开启端侧加密(在 PIN 设置成功后调用);幂等:已配置时仅解包 */
export async function enableFieldEncryption(pin: string): Promise<void> {
  if (getConfig()) {
    if (!hasDek()) await loadDek(pin);
    return;
  }
  const ksalt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const kek = await deriveKek(pin, ksalt);
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await aesGcmEncrypt(kek, KEK_AAD, Array.from(dekRaw, (b) => b.toString(16).padStart(2, '0')).join(''));
  dekRaw.fill(0);
  // 先落配置再解包(loadDek 依赖已保存的配置)
  localStorage.setItem(FENC_KEY, JSON.stringify({ v: 1, ksalt, wrapped } satisfies StoredKeyConfig));
  await loadDek(pin);
  await reencryptSweep();
}

/** 解锁(应用锁校验通过后调用):解包 DEK + 清扫锁定期间的明文写入 */
export async function unlockFieldEncryption(pin: string): Promise<void> {
  if (!getConfig() || hasDek()) return;
  await loadDek(pin);
  await reencryptSweep();
}

/** 锁定/切后台:只清内存 DEK(密文安全,刷新页面同样丢失内存态) */
export function lockFieldEncryption(): void {
  setDek(null);
}

/** 关闭端侧加密(在 PIN 校验通过后调用):全量解密 → 移除配置 */
export async function disableFieldEncryption(pin: string): Promise<void> {
  if (!getConfig()) return;
  if (!hasDek()) await loadDek(pin);
  setSuspended(true);
  try {
    await decryptSweep();
  } finally {
    setSuspended(false);
    lockFieldEncryption();
  }
  localStorage.removeItem(FENC_KEY);
}
