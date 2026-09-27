import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe';
import { JwtGuard } from '../common/guard';
import type { AuthedRequest } from '../common/guard';
import { AuthService } from './auth.service';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(64),
  nickname: z.string().max(30).default(''),
});

const codeSchema = z.object({ phone: z.string().regex(/^\d{5,20}$/) });

const loginSchema = z
  .object({
    email: z.string().email().optional(),
    password: z.string().optional(),
    phone: z.string().regex(/^\d{5,20}$/).optional(),
    code: z.string().regex(/^\d{4,8}$/).optional(),
  })
  .refine((v) => (v.email && v.password) || (v.phone && v.code), { message: '需提供邮箱密码或手机号验证码' });

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

type RegisterBody = z.infer<typeof registerSchema>;
type CodeBody = z.infer<typeof codeSchema>;
type LoginBody = z.infer<typeof loginSchema>;
type RefreshBody = z.infer<typeof refreshSchema>;

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) // 注册 3 次/小时/IP(F-07)
  @Post('v1/auth/register')
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterBody) {
    return this.auth.register(body);
  }

  @Throttle({ default: { limit: 5, ttl: 3_600_000 } }) // 验证码发送 5 次/小时/IP(另有 60s/号 冷却)
  @Post('v1/auth/code')
  code(@Body(new ZodValidationPipe(codeSchema)) body: CodeBody) {
    return this.auth.sendCode(body.phone);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 登录 5 次/分钟/IP(F-07)
  @Post('v1/auth/login')
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginBody) {
    return this.auth.login(body);
  }

  @Post('v1/auth/refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshBody) {
    return this.auth.refresh(body.refreshToken);
  }

  @Get('v1/users/me')
  @UseGuards(JwtGuard)
  me(@Req() req: AuthedRequest) {
    return this.auth.me(req.userId);
  }

  /** 全端下线(F-08):吊销当前用户全部 refresh token */
  @Post('v1/auth/logout')
  @UseGuards(JwtGuard)
  logout(@Req() req: AuthedRequest) {
    return this.auth.revokeAllSessions(req.userId).then(() => ({ ok: true }));
  }
}
