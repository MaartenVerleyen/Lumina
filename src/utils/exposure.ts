// A shutter speed as photographers write it. Some cameras store 1/60 s as a fraction like 10/600, which
// the EXIF reader gives as "0.016666666666666666s": short exposures become 1/60s again, long ones keep a decimal.
export function shutterLabel(value: string | null | undefined): string {
  if (!value) return "";
  const m = value.trim().match(/^(\d*\.\d+|\d+)\s*s?$/);
  if (!m) return value;
  const seconds = Number(m[1]);
  if (!(seconds > 0)) return value;
  if (seconds < 1) return `1/${Math.round(1 / seconds)}s`;
  return `${Number(seconds.toFixed(1))}s`;
}
