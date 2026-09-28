import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import { logAudit } from './audit';

/** 三段式错误码:模块.子模块.状态(PRD 7.2) */
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(ex: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<{ url?: string; userId?: string }>();
    const res = host.switchToHttp().getResponse();
    const status = ex instanceof AppError ? ex.status : ex instanceof HttpException ? ex.getStatus() : undefined;
    // 403 一律留痕(上线全检审计待办):越权尝试是灰度期重点监控对象;sync 内 op 级 403 在 sync.service 另行记录
    if (status === 403) {
      logAudit({
        actorUserId: req?.userId ?? null,
        action: 'authz.403',
        target: req?.url ?? null,
        summary: { code: ex instanceof AppError ? ex.code : undefined, message: ex instanceof Error ? ex.message : undefined },
      });
    }
    if (ex instanceof AppError) {
      return res.status(ex.status).json({ code: ex.code, message: ex.message, retryable: ex.retryable });
    }
    if (ex instanceof HttpException) {
      return res.status(status!).json({ code: `http.${status}`, message: ex.message, retryable: status! >= 500 });
    }
    // 上线前全检 #18:未知 500 必须留痕,灰度期不能盲飞
    // N3:body-parser 的 PayloadTooLargeError 不是 Nest HttpException,按 http-errors 的 status 归类(超限 → 413)
    const errStatus = typeof (ex as { status?: number }).status === 'number' ? (ex as { status: number }).status : undefined;
    if (errStatus === 413 || (ex as { type?: string }).type === 'entity.too.large') {
      return res.status(413).json({ code: 'http.413', message: '请求体过大,请减小单批数量后重试', retryable: false });
    }
    console.error('[ledgerone] unhandled error:', ex);
    return res.status(500).json({ code: 'http.500', message: '内部错误', retryable: true });
  }
}
