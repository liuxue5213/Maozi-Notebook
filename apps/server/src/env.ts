import 'dotenv/config'; // 支持 .env 文件(此前 .env.example 引导配置但应用从未加载,F-17)

const DEFAULT_JWT = 'ledgerone-dev-secret-CHANGE-ME';

/**
 * 启动即校验(上线前全检 B1/B2):
 * - 生产环境(NODE_ENV=production):JWT_SECRET 必须存在、≥32 位、≠默认值;禁止 DEV_MODE=true,否则拒绝启动;
 * - 非生产保持零配置可跑(PGlite + 默认密钥)。
 */
function failFast(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const secret = process.env.JWT_SECRET ?? '';
  if (!secret || secret.length < 32 || secret === DEFAULT_JWT) {
    console.error('[ledgerone] 生产环境 JWT_SECRET 缺失/短于 32 位/仍为默认值,拒绝启动');
    process.exit(1);
  }
  if (process.env.DEV_MODE === 'true') {
    console.error('[ledgerone] 生产环境禁止 DEV_MODE=true(验证码直通漏洞),拒绝启动');
    process.exit(1);
  }
}
failFast();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'pglite://data/ledgerone',
  JWT_SECRET: process.env.JWT_SECRET || DEFAULT_JWT,
  PORT: Number(process.env.PORT ?? 3000),
  DEV_MODE: process.env.DEV_MODE === 'true',
  IS_PROD: process.env.NODE_ENV === 'production',
};
