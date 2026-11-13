import "./style.css";
import { diffLines } from "diff";
import { applyEdits, parseEdits, parseFullCode, type Edit } from "./edits";
import { buildUserMessage, type Turn } from "./prompt";
import {
  ask, checkGpu, currentModel, DEFAULT_TIER, isCached, loadModel, modelIdFor, stop, TIERS,
  type GpuInfo,
} from "./llm";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const codeEl = $<HTMLTextAreaElement>("code");
const errorEl = $<HTMLTextAreaElement>("error");
const codeStats = $("code-stats");
const copyBtn = $<HTMLButtonElement>("copy");
const undoBtn = $<HTMLButtonElement>("undo");
const clearBtn = $<HTMLButtonElement>("clear");
const diffWrap = $("diff-wrap");
const diffEl = $("diff");
const diffStats = $("diff-stats");
const gpuStatus = $("gpu-status");
const tiersEl = $("tiers");
const loadBtn = $<HTMLButtonElement>("load");
const progress = $("progress");
const barFill = $("bar-fill");
const progressText = $("progress-text");
const messagesEl = $("messages");
const chips = $("chips");
const form = $<HTMLFormElement>("ask");
const questionEl = $<HTMLTextAreaElement>("question");
const sendBtn = $<HTMLButtonElement>("send");
const newChatBtn = $<HTMLButtonElement>("new-chat");

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch {  } },
};

let gpu: GpuInfo = { ok: false, f16: false };
let tierIndex = Number(store.get("sprout-tier") ?? DEFAULT_TIER);
if (!(tierIndex >= 0 && tierIndex < TIERS.length)) tierIndex = DEFAULT_TIER;
let history: Turn[] = [];
const undoStack: string[] = [];
let busy = false;
let loading = false;

$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  store.set("sprout-theme", root.dataset.theme);
});

codeEl.value = store.get("sprout-code") ?? "";
errorEl.value = store.get("sprout-error") ?? "";
updateStats();

codeEl.addEventListener("input", () => {
  store.set("sprout-code", codeEl.value);
  updateStats();
});
errorEl.addEventListener("input", () => store.set("sprout-error", errorEl.value));

codeEl.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey) return;
  e.preventDefault();
  document.execCommand("insertText", false, "  ");
});

function updateStats() {
  const lines = codeEl.value ? codeEl.value.split("\n").length : 0;
  codeStats.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
}

function setCode(next: string, label: string) {
  const prev = codeEl.value;
  if (next === prev) return;
  undoStack.push(prev);
  undoBtn.disabled = false;
  codeEl.value = next;
  store.set("sprout-code", next);
  updateStats();
  showDiff(prev, next, label);
}

function showDiff(before: string, after: string, label: string) {
  const parts = diffLines(before, after);
  let added = 0, removed = 0;
  const html: string[] = [];
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.added || p.removed) {
      if (p.added) added += lines.length; else removed += lines.length;
      const cls = p.added ? "add" : "del";
      const sign = p.added ? "+ " : "- ";
      for (const l of lines) html.push(`<span class="${cls}">${esc(sign + l)}</span>`);
    } else if (lines.length > 6) {
      for (const l of lines.slice(0, 2)) html.push(`<span>${esc("  " + l)}</span>`);
      html.push(`<span class="gap">  ⋯ ${lines.length - 4} unchanged lines</span>`);
      for (const l of lines.slice(-2)) html.push(`<span>${esc("  " + l)}</span>`);
    } else {
      for (const l of lines) html.push(`<span>${esc("  " + l)}</span>`);
    }
  }
  diffEl.innerHTML = html.join("");
  diffStats.textContent = `${label} · +${added} −${removed}`;
  diffWrap.hidden = false;
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(codeEl.value);
    flash(copyBtn, "Copied! Paste it into Sprig");
  } catch {
    codeEl.select();
    flash(copyBtn, "Press Ctrl+C to copy");
  }
});

undoBtn.addEventListener("click", () => {
  const prev = undoStack.pop();
  if (prev === undefined) return;
  const cur = codeEl.value;
  codeEl.value = prev;
  store.set("sprout-code", prev);
  updateStats();
  showDiff(cur, prev, "Undone");
  undoBtn.disabled = undoStack.length === 0;
});

clearBtn.addEventListener("click", () => {
  if (!codeEl.value && !errorEl.value) return;
  if (codeEl.value) undoStack.push(codeEl.value);
  undoBtn.disabled = undoStack.length === 0;
  codeEl.value = "";
  errorEl.value = "";
  store.set("sprout-code", "");
  store.set("sprout-error", "");
  diffWrap.hidden = true;
  updateStats();
});

function flash(btn: HTMLButtonElement, text: string) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1600);
}

async function renderTiers() {
  tiersEl.innerHTML = "";
  for (const [i, t] of TIERS.entries()) {
    const label = document.createElement("label");
    label.className = "tier" + (i === tierIndex ? " selected" : "");
    label.innerHTML = `
      <input type="radio" name="tier" value="${i}" ${i === tierIndex ? "checked" : ""} />
      <span><strong>${esc(t.label)}<span class="pill-slot"></span></strong><small>${esc(t.note)}</small></span>
      <span class="size">~${t.gb} GB</span>`;
    label.querySelector("input")!.addEventListener("change", () => {
      tierIndex = i;
      store.set("sprout-tier", String(i));
      for (const el of tiersEl.querySelectorAll(".tier")) el.classList.remove("selected");
      label.classList.add("selected");
      updateLoadButton();
    });
    tiersEl.append(label);
  }
  await markCached();
}

async function markCached() {
  const slots = tiersEl.querySelectorAll<HTMLElement>(".pill-slot");
  await Promise.all(TIERS.map(async (t, i) => {
    const id = modelIdFor(t, gpu.f16);
    const loaded = currentModel() === id;
    const cached = loaded || (await isCached(id));
    slots[i]!.innerHTML = loaded
      ? `<span class="pill ok">loaded</span>`
      : cached ? `<span class="pill warn">downloaded</span>` : "";
  }));
}

function updateLoadButton() {
  const id = modelIdFor(TIERS[tierIndex]!, gpu.f16);
  if (!gpu.ok) { loadBtn.disabled = true; loadBtn.textContent = "WebGPU not available"; return; }
  if (loading) { loadBtn.disabled = true; loadBtn.textContent = "Loading…"; return; }
  const loaded = currentModel() === id;
  loadBtn.disabled = loaded || busy;
  loadBtn.textContent = loaded ? "Model ready ✓" : currentModel() ? "Switch model" : "Load model";
}

loadBtn.addEventListener("click", async () => {
  const tier = TIERS[tierIndex]!;
  loading = true;
  updateLoadButton();
  updateSend();
  progress.hidden = false;
  barFill.style.width = "0";
  progressText.textContent = "Starting…";
  try {
    await loadModel(tier, gpu.f16, (r) => {
      barFill.style.width = `${Math.round(r.progress * 100)}%`;
      progressText.textContent = friendlyProgress(r.text);
    });
    progressText.textContent = `${tier.label} is ready. Ask away!`;
    barFill.style.width = "100%";
  } catch (e) {
    progressText.textContent = "";
    progress.hidden = true;
    addError(
      `Couldn't load the model: ${errText(e)}. If your computer is low on GPU memory, try a smaller brain.`,
    );
  } finally {
    loading = false;
    updateLoadButton();
    updateSend();
    markCached();
  }
});

function friendlyProgress(text: string) {
  return text.replace(/\s*It can take a while.*$/i, "").slice(0, 140);
}

function updateSend() {
  const ready = !!currentModel() && !loading;
  sendBtn.disabled = !ready && !busy;
  sendBtn.textContent = busy ? "Stop" : "Send";
  sendBtn.classList.toggle("danger", busy);
  sendBtn.classList.toggle("primary", !busy);
  for (const c of chips.querySelectorAll("button")) c.disabled = !ready || busy;
  newChatBtn.disabled = busy;
}

chips.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn || btn.disabled) return;
  send(btn.textContent ?? "");
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { stop(); return; }
  send(questionEl.value);
});

questionEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    form.requestSubmit();
  }
});

newChatBtn.addEventListener("click", () => {
  history = [];
  for (const el of messagesEl.querySelectorAll(".msg:not(.intro)")) el.remove();
});

async function send(raw: string) {
  const question = raw.trim();
  if (!question || busy || !currentModel()) return;

  questionEl.value = "";
  addMessage("user", `<p>${esc(question)}</p>`);
  const bubble = addMessage("assistant", "");
  bubble.classList.add("thinking");

  busy = true;
  updateSend();
  updateLoadButton();

  const codeAtAsk = codeEl.value;
  const userMessage = buildUserMessage(question, codeAtAsk, errorEl.value);

  let reply = "";
  try {
    reply = await ask(history, userMessage, (text) => {
      bubble.innerHTML = renderReply(text);
      scrollDown();
    });
    bubble.innerHTML = renderReply(reply) || "<p class='muted'>(no answer)</p>";
    addActions(bubble, reply);
    history.push({ role: "user", content: question }, { role: "assistant", content: reply });
  } catch (e) {
    bubble.remove();
    const msg = errText(e);
    addError(
      /context|prompt.*(long|length)|exceed/i.test(msg)
        ? "Your game is too long for this model's memory. Try pasting just the part you need help with, or start a new chat."
        : `Something went wrong: ${msg}`,
    );
  } finally {
    bubble.classList.remove("thinking");
    busy = false;
    updateSend();
    updateLoadButton();
    scrollDown();
  }
}

function addActions(bubble: HTMLElement, reply: string) {
  const edits = parseEdits(reply);
  const full = edits.length ? null : parseFullCode(reply);
  if (!edits.length && !full) return;

  const row = document.createElement("div");
  row.className = "msg-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "button small primary";

  if (edits.length) {
    btn.textContent = `Apply ${edits.length} change${edits.length === 1 ? "" : "s"}`;
    btn.addEventListener("click", () => applyFromReply(bubble, btn, edits));
  } else {
    btn.textContent = codeEl.value.trim() ? "Replace my code with this" : "Use this code";
    btn.addEventListener("click", () => {
      setCode(full!, "New game");
      btn.disabled = true;
      btn.textContent = "Applied ✓";
    });
  }
  row.append(btn);
  bubble.append(row);
}

function applyFromReply(bubble: HTMLElement, btn: HTMLButtonElement, edits: Edit[]) {
  const res = applyEdits(codeEl.value, edits);
  if (res.applied > 0) setCode(res.code, `Applied ${res.applied} change${res.applied === 1 ? "" : "s"}`);
  btn.disabled = true;
  btn.textContent = res.failed.length ? `Applied ${res.applied} of ${edits.length}` : "Applied ✓";

  if (res.failed.length) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent =
      `${res.failed.length} change${res.failed.length === 1 ? "" : "s"} couldn't be matched to your code ` +
      `(the AI may have misquoted it). Ask "that change didn't apply, try again" or edit by hand.`;
    bubble.append(note);
  }
}

function addMessage(kind: "user" | "assistant", html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.innerHTML = html;
  messagesEl.append(el);
  scrollDown();
  return el;
}

function addError(text: string) {
  const el = document.createElement("div");
  el.className = "msg error";
  el.textContent = text;
  messagesEl.append(el);
  scrollDown();
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderReply(text: string): string {
  const out: string[] = [];
  const re = /(<{5,9} ?SEARCH[\s\S]*?(?:>{5,9} ?REPLACE|$)|```[\w]*\n[\s\S]*?(?:```|$))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(renderProse(text.slice(last, m.index)));
    const block = m[0];
    if (block.startsWith("<")) out.push(renderEdit(block));
    else out.push(`<pre><code>${esc(block.replace(/^```[\w]*\n/, "").replace(/```$/, "").trimEnd())}</code></pre>`);
    last = m.index! + block.length;
  }
  out.push(renderProse(text.slice(last)));
  return out.join("");
}

function renderEdit(block: string): string {
  const body = block.replace(/^<{5,9} ?SEARCH[^\n]*\n?/, "").replace(/\n?>{5,9} ?REPLACE$/, "");
  const [search = "", replace] = body.split(/\n?={5,9}[^\n]*\n?/);
  const lines: string[] = [];
  for (const l of search.split("\n")) lines.push(`<span class="del">${esc("- " + l)}</span>`);
  if (replace !== undefined) for (const l of replace.split("\n")) lines.push(`<span class="add">${esc("+ " + l)}</span>`);
  return `<div class="edit-block"><pre>${lines.join("\n")}</pre></div>`;
}

function renderProse(s: string): string {
  return s
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) =>
      "<p>" +
      esc(p)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>") +
      "</p>",
    )
    .join("");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

(async () => {
  updateSend();
  gpu = await checkGpu();
  if (gpu.ok) {
    gpuStatus.textContent = gpu.f16 ? "GPU ready" : "GPU ready (f32 mode)";
  } else {
    gpuStatus.textContent = "no WebGPU";
    addError(gpu.reason ?? "WebGPU isn't available in this browser.");
  }
  await renderTiers();
  updateLoadButton();
})();
