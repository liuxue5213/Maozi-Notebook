import 'dotenv/config'; // 支持 .env 文件(此前 .env.example 引导配置但应用从未加载,F-17)

const DEFAULT_JWT = 'ledgerone-dev-secret-CHANGE-ME';

/**
 * 启动即校验(上线前全检 B1/B2 + 第 19 轮 P0-6):
 * - 生产环境(NODE_ENV=production):JWT_SECRET 必须存在、≥32 位、≠默认值;禁止 DEV_MODE=true;
 *   DATABASE_URL 必须显式配置且为 MySQL URL。
 * - 开发环境也使用 MySQL,避免测试与生产采用不同 SQL 方言。
 */
function failFast(): void {
  const dbUrl = process.env.DATABASE_URL ?? 'mysql://ledgerone:ledgerone@127.0.0.1:3306/ledgerone';
  if (!dbUrl.startsWith('mysql://')) {
    console.error('[ledgerone] DATABASE_URL 必须为 mysql:// URL;旧 PostgreSQL/PGlite 配置已不再支持');
    process.exit(1);
  }
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
  if (!process.env.DATABASE_URL) {
    console.error('[ledgerone] 生产环境必须显式配置 DATABASE_URL,拒绝启动');
    process.exit(1);
  }
}
failFast();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://ledgerone:ledgerone@127.0.0.1:3306/ledgerone',
  JWT_SECRET: process.env.JWT_SECRET || DEFAULT_JWT,
  PORT: Number(process.env.PORT ?? 60505),
  DEV_MODE: process.env.DEV_MODE === 'true',
  IS_PROD: process.env.NODE_ENV === 'production',
  /** 允许的跨域来源,逗号分隔(F-09);生产漏配 = 拒绝跨域(不反射),开发态留空 = 放行本地前端 */
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '',
};
