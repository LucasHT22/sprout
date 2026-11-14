// Automatic checks for common Sprig mistakes

export interface Finding {
  line: number;
  message: string;
  concept: string;
}

const PALETTE = new Set("0L123C7564FD48H9.".split(""));
const INPUTS = new Set(["w", "a", "s", "d", "i", "j", "k", "l"]);

const SPRIG_API = [
  "setLegend", "bitmap", "map", "setMap", "setBackground", "setSolids", "setPushables",
  "width", "height", "onInput", "afterInput", "getFirst", "getAll", "getTile", "tilesWith",
  "addSprite", "clearTile", "addText", "clearText", "tune", "playTune", "color",
];
const JS_GLOBALS = [
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "parseInt", "parseFloat",
  "isNaN", "isFinite", "Number", "String", "Boolean", "Array", "Object", "JSON", "Math",
  "Date", "Set", "Map", "Symbol", "Error", "console", "Promise", "structuredClone",
];
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "do",
  "else", "await", "async", "of", "in", "delete", "void", "throw", "case", "super", "class",
]);
const KNOWN = new Set([...SPRIG_API, ...JS_GLOBALS]);

function lineAt(code: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === "\n") n++;
  return n;
}

function keyConstants(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])(.*?)\2/g)) {
    out.set(m[1]!, m[3]!);
  }
  return out;
}

function resolveKey(token: string, consts: Map<string, string>): string | null {
  const t = token.trim();
  const lit = t.match(/^(["'`])(.*)\1$/);
  if (lit) return lit[2]!;
  return consts.get(t) ?? null;
}

function stripNonCode(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/`[\s\S]*?`/g, (m) => "`" + m.slice(1, -1).replace(/[^\n]/g, " ") + "`")
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

export function lint(code: string): Finding[] {
  const findings: Finding[] = [];
  if (!code.trim()) return findings;
  const consts = keyConstants(code);

  const legendKeys = new Set<string>();
  const legendCall = code.match(/setLegend\s*\(/);
  if (legendCall) {
    for (const m of code.matchAll(/\[\s*([^,\]\n]+?)\s*,\s*bitmap\s*`/g)) {
      const key = resolveKey(m[1]!, consts);
      if (key === null) continue;
      if (key.length !== 1) {
        findings.push({
          line: lineAt(code, m.index!),
          message: `Legend key ${m[1]!.trim()} is "${key}", which is ${key.length} characters. Legend keys must be exactly one character.`,
          concept: "legend keys",
        });
      }
      legendKeys.add(key);
    }
  }

  for (const m of code.matchAll(/bitmap\s*`([\s\S]*?)`/g)) {
    const start = lineAt(code, m.index!);
    const rows = m[1]!.split("\n").map((r) => r.trim()).filter((r) => r.length > 0);
    if (rows.length !== 16) {
      findings.push({
        line: start,
        message: `This bitmap has ${rows.length} rows, but sprites must be 16 rows tall.`,
        concept: "bitmaps are 16x16",
      });
    }
    const badRow = rows.findIndex((r) => r.length !== 16);
    if (badRow !== -1) {
      findings.push({
        line: start + 1 + badRow,
        message: `Row ${badRow + 1} of this bitmap is ${rows[badRow]!.length} characters wide, but every row must be 16.`,
        concept: "bitmaps are 16x16",
      });
    }
    const badChars = [...new Set(rows.join("").split("").filter((c) => !PALETTE.has(c)))];
    if (badChars.length) {
      findings.push({
        line: start,
        message: `This bitmap uses ${badChars.map((c) => `"${c}"`).join(", ")}, which ${badChars.length === 1 ? "is not a Sprig color" : "are not Sprig colors"}.`,
        concept: "the color palette",
      });
    }
  }

  if (legendKeys.size) {
    for (const m of code.matchAll(/(?<![\w$])map\s*`([\s\S]*?)`/g)) {
      const chars = new Set(m[1]!.replace(/\s/g, "").split(""));
      const missing = [...chars].filter((c) => c !== "." && !legendKeys.has(c));
      if (missing.length) {
        findings.push({
          line: lineAt(code, m.index!),
          message: `This map uses ${missing.map((c) => `"${c}"`).join(", ")}, but ${missing.length === 1 ? "that key isn't" : "those keys aren't"} in setLegend.`,
          concept: "maps use legend keys",
        });
      }
    }
  }

  const solidsMatch = code.match(/setSolids\s*\(\s*\[([^\]]*)\]/);
  const solids = new Set(
    (solidsMatch?.[1] ?? "").split(",").map((t) => resolveKey(t, consts)).filter((k): k is string => k !== null),
  );
  const push = code.match(/setPushables\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  if (push) {
    const line = lineAt(code, push.index!);
    const names = push[1]!.match(/\[\s*[^\]]+?\s*\]|["'][^"']+["']/g) ?? [];
    const keys = names
      .flatMap((n) => n.replace(/^\[|\]$/g, "").split(","))
      .map((t) => resolveKey(t, consts))
      .filter((k): k is string => k !== null && k.length > 0);
    const notSolid = [...new Set(keys)].filter((k) => !solids.has(k));
    if (notSolid.length) {
      findings.push({
        line,
        message: `${notSolid.map((k) => `"${k}"`).join(", ")} ${notSolid.length === 1 ? "is" : "are"} used in setPushables but not listed in setSolids, so pushing won't work.`,
        concept: "pushables must be solids",
      });
    }
  }

  for (const m of code.matchAll(/onInput\s*\(\s*(["'`])(.*?)\1/g)) {
    if (!INPUTS.has(m[2]!)) {
      findings.push({
        line: lineAt(code, m.index!),
        message: `onInput("${m[2]}") will never run. Sprig only has the keys w, a, s, d, i, j, k, l.`,
        concept: "Sprig's 8 buttons",
      });
    }
  }

  const clean = stripNonCode(code);
  const defined = new Set<string>();
  for (const m of clean.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]!);
  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]!);
  for (const m of clean.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]!;
    if (KNOWN.has(name) || KEYWORDS.has(name) || defined.has(name)) continue;
    const before = clean.slice(Math.max(0, m.index! - 12), m.index!);
    if (/function\s*$/.test(before)) continue;
    findings.push({
      line: lineAt(code, m.index!),
      message: `${name}() is called, but it isn't a Sprig function and isn't defined in this game.`,
      concept: "the Sprig API",
    });
    defined.add(name);
  }

  return findings.sort((a, b) => a.line - b.line).slice(0, 8);
}
