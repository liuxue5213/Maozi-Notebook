import { v7 } from 'uuid';

/** 客户端生成的时间有序 UUID:保证离线可写 + 服务端幂等 upsert(PRD 5.4) */
export function newId(): string {
  return v7();
}
