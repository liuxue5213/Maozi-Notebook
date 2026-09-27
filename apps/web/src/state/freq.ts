/** 分类使用频次(M01-F01 分类九宫格按频率动态排序),本地持久化 */
const KEY = 'lo_cat_freq';

type Freq = Record<string, number>;

function read(): Freq {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Freq;
  } catch {
    return {};
  }
}

export function bumpCategory(id: string): void {
  const f = read();
  f[id] = (f[id] ?? 0) + 1;
  localStorage.setItem(KEY, JSON.stringify(f));
}

export function categoryFreq(): Freq {
  return read();
}
