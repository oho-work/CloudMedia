export const BYTES_PER_MEGABYTE = 1_000_000;

export const millisecondsToSeconds = (milliseconds: number): string => String(milliseconds / 1000);
export const bytesToMegabytes = (bytes: number): string => String(bytes / BYTES_PER_MEGABYTE);

function scaledInput(value: string, factor: number, minimum: number, maximum: number, message: string): number {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(message);
  const input = Number(text);
  if (!Number.isFinite(input) || input < minimum / factor || input > maximum / factor) throw new Error(message);
  const result = Math.round(input * factor);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(message);
  return result;
}

/** Settings continue to store integer milliseconds and bytes at the API boundary. */
export const secondsToMilliseconds = (seconds: string): number =>
  scaledInput(seconds, 1000, 1000, 60000, '单次请求超时须为 1 至 60 秒。');
export const megabytesToBytes = (megabytes: string): number =>
  scaledInput(megabytes, BYTES_PER_MEGABYTE, 16384, 4194304, '每个分片最多下载须为 0.016384 至 4.194304 MB。');
