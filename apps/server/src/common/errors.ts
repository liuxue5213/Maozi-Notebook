import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';

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
    const res = host.switchToHttp().getResponse();
    if (ex instanceof AppError) {
      return res.status(ex.status).json({ code: ex.code, message: ex.message, retryable: ex.retryable });
    }
    if (ex instanceof HttpException) {
      const status = ex.getStatus();
      return res.status(status).json({ code: `http.${status}`, message: ex.message, retryable: status >= 500 });
    }
    // 上线前全检 #18:未知 500 必须留痕,灰度期不能盲飞
    // N3:body-parser 的 PayloadTooLargeError 不是 Nest HttpException,按 http-errors 的 status 归类(超限 → 413)
    const status = typeof (ex as { status?: number }).status === 'number' ? (ex as { status: number }).status : undefined;
    if (status === 413 || (ex as { type?: string }).type === 'entity.too.large') {
      return res.status(413).json({ code: 'http.413', message: '请求体过大,请减小单批数量后重试', retryable: false });
    }
    console.error('[ledgerone] unhandled error:', ex);
    return res.status(500).json({ code: 'http.500', message: '内部错误', retryable: true });
  }
}
