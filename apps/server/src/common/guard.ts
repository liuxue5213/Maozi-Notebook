import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { verifyJwt } from './crypto';
import { AppError } from './errors';

@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const h: string = req.headers['authorization'] ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    try {
      const payload = verifyJwt<{ sub: string }>(token);
      (req as { userId?: string }).userId = payload.sub;
      return true;
    } catch {
      throw new AppError('auth.token.401', 401, '未登录或令牌已失效');
    }
  }
}

export interface AuthedRequest {
  userId: string;
}
