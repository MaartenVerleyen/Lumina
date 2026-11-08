// A count with its noun: "1 photo", "3 photos", "1 person", "2 people"
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
