import { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';
import { AppError } from './errors';

export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodTypeAny) {}

  transform(value: unknown): unknown {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AppError('http.validation.400', 400, `请求参数不合法: ${msg}`);
    }
    return r.data;
  }
}
