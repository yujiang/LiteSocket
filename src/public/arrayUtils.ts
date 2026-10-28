/**
 * 原地在 index 插入元素
 */
export function insertAt<T>(arr: T[], index: number, ...items: T[]): void {
  arr.splice(index, 0, ...items);
}

/**
 * 原地删除，返回被删除元素
 */
export function removeAt<T>(arr: T[], index: number, count: number): T[] {
  return arr.splice(index, count);
}

export function remove1<T>(arr: T[], index: number, count = 1): T {
  return arr.splice(index, count)[0];
}

/**
 * 原地替换 index 单个元素
 */
export function replaceAt<T>(arr: T[], index: number, newItem: T): void {
  arr.splice(index, 1, newItem);
}

