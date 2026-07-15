export function chooseMarkdownSource<T>(
  explicit: T | undefined,
  active: T | undefined,
  recent: T | undefined,
): T | undefined {
  return explicit ?? active ?? recent;
}
