export type PeriodKind = 'day' | 'week' | 'month' | 'year';

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** 本地时区周期区间 [start, end);周起始日为周一(M14-F03 默认) */
export function periodRange(kind: PeriodKind, now: Date = new Date()): { start: number; end: number } {
  const start = new Date(startOfDay(now));
  switch (kind) {
    case 'day':
      return { start: start.getTime(), end: start.getTime() + DAY_MS };
    case 'week': {
      const offset = (start.getDay() + 6) % 7; // 周一=0
      const s = start.getTime() - offset * DAY_MS;
      return { start: s, end: s + 7 * DAY_MS };
    }
    case 'month': {
      start.setDate(1);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      return { start: start.getTime(), end: end.getTime() };
    }
    case 'year': {
      start.setMonth(0, 1);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);
      return { start: start.getTime(), end: end.getTime() };
    }
  }
}

export interface TrendBucket {
  label: string;
  start: number;
  end: number;
}

/** 迷你趋势分桶(M06-F01):日→近7天,周→本周7天,月→当月每日,年→12个月 */
export function trendBuckets(kind: PeriodKind, now: Date = new Date()): TrendBucket[] {
  switch (kind) {
    case 'day':
    case 'week': {
      // 两者都以「本周 7 天」为迷你趋势(day 视角下当前日高亮由调用方处理)
      const weekStart = periodRange('week', now).start;
      return Array.from({ length: 7 }, (_, i) => {
        const st = weekStart + i * DAY_MS;
        return { label: `周${'日一二三四五六'[new Date(st).getDay()]}`, start: st, end: st + DAY_MS };
      });
    }
    case 'month': {
      const { start, end } = periodRange('month', now);
      const days = Math.round((end - start) / DAY_MS);
      return Array.from({ length: days }, (_, i) => {
        const st = start + i * DAY_MS;
        return { label: String(new Date(st).getDate()), start: st, end: st + DAY_MS };
      });
    }
    case 'year': {
      const { start } = periodRange('year', now);
      return Array.from({ length: 12 }, (_, i) => {
        const st = new Date(start);
        st.setMonth(i, 1);
        const en = new Date(start);
        en.setMonth(i + 1, 1);
        return { label: `${i + 1}月`, start: st.getTime(), end: en.getTime() };
      });
    }
  }
}

/** datetime-local 输入框值(本地时区) */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInputValue(v: string): number {
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? Date.now() : t;
}
