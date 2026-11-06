export function markdownCodeSpan(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ');
  const longestRun = Array.from(text.matchAll(/`+/g)).reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter} ${text} ${delimiter}`;
}
