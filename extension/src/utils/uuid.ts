export function generateId(prefix: string = ''): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    return prefix ? `${prefix}_${uuid}` : uuid;
  }
  const rand = Math.random().toString(36).substring(2, 10);
  const time = Date.now().toString(36);
  return prefix ? `${prefix}_${time}_${rand}` : `${time}_${rand}`;
}
