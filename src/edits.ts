export interface Edit {
  search: string;
  replace: string;
}

export interface ApplyResult {
  code: string;
  applied: number;
  failed: Edit[];
}

const EDIT_RE =
  /<{5,9} ?SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9} ?REPLACE/g;

export function parseEdits(reply: string): Edit[] {
  const edits: Edit[] = [];
  for (const m of reply.matchAll(EDIT_RE)) {
    edits.push({ search: stripLineNumbers(m[1] ?? ""), replace: stripLineNumbers(m[2] ?? "") });
  }
  return edits;
}

function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  const numbered = /^\s*\d+ \| ?/;
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length || !nonEmpty.every((l) => numbered.test(l))) return text;
  return lines.map((l) => l.replace(numbered, "")).join("\n");
}

export function parseFullCode(reply: string): string | null {
  const m = reply.match(/```(?:js|javascript)?\n([\s\S]*?)```/);
  if (!m) return null;
  const code = m[1] ?? "";
  return /setLegend\s*\(/.test(code) ? code : null;
}

export function applyEdits(code: string, edits: Edit[]): ApplyResult {
  let out = code.replace(/\r\n/g, "\n");
  let applied = 0;
  const failed: Edit[] = [];

  for (const edit of edits) {
    const next = applyOne(out, edit);
    if (next === null) failed.push(edit);
    else {
      out = next;
      applied++;
    }
  }
  return { code: out, applied, failed };
}

function applyOne(code: string, { search, replace }: Edit): string | null {
  if (!search.trim()) return code.trimEnd() + "\n" + replace + "\n";

  for (let i = code.indexOf(search); i !== -1; i = code.indexOf(search, i + 1)) {
    const end = i + search.length;
    const startsLine = i === 0 || code[i - 1] === "\n";
    const endsLine = end === code.length || code[end] === "\n" || search.endsWith("\n");
    if (startsLine && endsLine) return code.slice(0, i) + replace + code.slice(end);
  }

  const lines = code.split("\n");
  const want = search.split("\n").map((l) => l.trim());
  while (want.length && want[0] === "") want.shift();
  while (want.length && want[want.length - 1] === "") want.pop();
  if (!want.length) return null;

  for (let start = 0; start + want.length <= lines.length; start++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[start + k]!.trim() !== want[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const indent = lines[start]!.match(/^\s*/)![0];
    const repLines = replace.split("\n");
    const repIndent = repLines.find((l) => l.trim())?.match(/^\s*/)![0] ?? "";
    const fixed = repLines.map((l) =>
      l.startsWith(repIndent) ? indent + l.slice(repIndent.length) : l,
    );
    lines.splice(start, want.length, ...fixed);
    return lines.join("\n");
  }
  return null;
}
