/** 只保留文本尾部，避免证据与命令输出无限膨胀。 */
export function tailText(text: string, limit = 2000): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}