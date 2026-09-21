// 文本查找：支持精确、忽略大小写、模糊三种模式，返回带上下文的定位片段。
export type FindMode = "exact" | "case-insensitive" | "fuzzy";

const CONTEXT_CHARS = 400;
const MAX_OUTPUT_CHARS = 20_000;

interface Match {
  query: string;
  start: number;
  end: number;
}

interface Range {
  start: number;
  end: number;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function editDistanceWithin(left: string, right: string, maximum: number): boolean {
  if (Math.abs(left.length - right.length) > maximum) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j++) {
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      current[j] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return false;
    previous = current;
  }
  return previous[right.length] <= maximum;
}

function literalMatches(text: string, query: string, caseInsensitive: boolean): Match[] {
  const haystack = caseInsensitive ? text.toLocaleLowerCase() : text;
  const needle = caseInsensitive ? query.toLocaleLowerCase() : query;
  const matches: Match[] = [];
  for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + Math.max(needle.length, 1))) {
    matches.push({ query, start, end: start + query.length });
  }
  return matches;
}

function fuzzyMatches(text: string, query: string): Match[] {
  const queryTokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (queryTokens.length === 0) return [];
  const matches: Match[] = [];
  const paragraphs = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  for (const paragraph of text.matchAll(paragraphs)) {
    const paragraphText = paragraph[0];
    if (paragraphText.trim().length === 0 || paragraph.index === undefined) continue;
    const tokens = [...paragraphText.matchAll(/[\p{L}\p{N}]+/gu)];
    const matched = queryTokens.filter((queryToken) => tokens.some((token) => {
      const candidate = normalize(token[0]);
      const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
      return editDistanceWithin(queryToken, candidate, maximum);
    }));
    const required = queryTokens.length === 1 ? 1 : Math.ceil(queryTokens.length * 0.6);
    if (matched.length < required) continue;
    const first = tokens.find((token) => matched.some((queryToken) => {
      const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
      return editDistanceWithin(queryToken, normalize(token[0]), maximum);
    }));
    if (!first) continue;
    const start = paragraph.index + first.index!;
    matches.push({ query, start, end: start + first[0].length });
  }
  return matches;
}

function mergeRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function contextRanges(textLength: number, matches: Match[]): Range[] {
  return mergeRanges(matches.map((match) => ({ start: Math.max(0, match.start - CONTEXT_CHARS), end: Math.min(textLength, match.end + CONTEXT_CHARS) })));
}

export interface FindResult {
  text: string;
  matchCount: number;
  returnedMatches: number;
  queryResults: Array<{ query: string; matchCount: number }>;
}

/** findContent 在指定文本中查找一个或多个 query，返回带上下文的定位片段，超长时按重要性截断 */
export function findContent(text: string, queries: string[], mode: FindMode): FindResult {
  const normalizedQueries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  const occurrences = normalizedQueries.map((query) => {
    const matches = mode === "fuzzy" ? fuzzyMatches(text, query) : literalMatches(text, query, mode === "case-insensitive");
    return { query, matches };
  });
  const matches = occurrences.flatMap((r) => r.matches);
  const queryResults = occurrences.map((r) => ({ query: r.query, matchCount: r.matches.length }));
  const heading = matches.length > 0 ? `Text matches (${mode})` : `Text matches (${mode}): no matches`;
  const missing = queryResults.filter((r) => r.matchCount === 0).map((r) => `"${r.query}"`);
  const missingNotice = missing.length > 0 ? `No matches: ${missing.join(", ")}` : "";

  if (matches.length === 0) {
    return { text: [heading, missingNotice].filter(Boolean).join("\n\n"), matchCount: 0, returnedMatches: 0, queryResults };
  }

  const ranges = contextRanges(text.length, matches);
  const sections = [heading];
  let totalLength = heading.length;
  let usedRanges = 0;
  for (const range of ranges) {
    const prefix = range.start > 0 ? "…" : "";
    const suffix = range.end < text.length ? "…" : "";
    const snippet = `${prefix}${text.slice(range.start, range.end).replace(/\s+/g, " ").trim()}${suffix}`;
    const section = `${usedRanges + 1}. ${snippet}`;
    if (totalLength + section.length + 2 > MAX_OUTPUT_CHARS) break;
    sections.push(section);
    totalLength += section.length + 2;
    usedRanges++;
  }
  if (missingNotice) sections.push(missingNotice);
  if (usedRanges < ranges.length) sections.push(`Showing ${usedRanges} of ${ranges.length} match regions (output truncated at ${MAX_OUTPUT_CHARS} chars).`);

  return { text: sections.join("\n\n"), matchCount: matches.length, returnedMatches: matches.length, queryResults };
}
