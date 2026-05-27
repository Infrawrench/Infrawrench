export function replacePeerPaneTrailingCount(title: string, count: number): string {
  return /\(\d+\)$/.test(title) ? title.replace(/\(\d+\)$/, `(${count})`) : title;
}
