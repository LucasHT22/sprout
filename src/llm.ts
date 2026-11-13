import {
  CreateWebWorkerMLCEngine,
  hasModelInCache,
  type InitProgressReport,
  type WebWorkerMLCEngine,
} from "@mlc-ai/web-llm";
import { SYSTEM_PROMPT, type Turn } from "./prompt";

export interface Tier {
  id: string;
  label: string;
  note: string;
  gb: number;
  thinks?: boolean;
}

export const TIERS: Tier[] = [
  { id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC", label: "Tiny", note: "Qwen2.5 Coder 1.5B · older laptops", gb: 1.6 },
  { id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC", label: "Standard", note: "Qwen2.5 Coder 3B · most laptops", gb: 2.5 },
  { id: "Qwen3.5-4B-q4f16_1-MLC", label: "Smart", note: "Qwen3.5 4B · better reasoning", gb: 3.9, thinks: true },
  { id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC", label: "Strong", note: "Qwen2.5 Coder 7B · gaming laptops", gb: 5.1 },
  { id: "Qwen3.5-9B-q4f16_1-MLC", label: "Strongest", note: "Qwen3.5 9B · big GPUs only", gb: 6.4, thinks: true },
];
export const DEFAULT_TIER = 1;

const CONTEXT_WINDOW = 8192;
const HISTORY_TURNS = 4;

export interface GpuInfo {
  ok: boolean;
  f16: boolean;
  reason?: string;
}

export async function checkGpu(): Promise<GpuInfo> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) {
    return { ok: false, f16: false, reason: "This browser doesn't support WebGPU. Try the latest Chrome or Edge on a laptop or desktop." };
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, f16: false, reason: "WebGPU is on, but no GPU was found. Check that hardware acceleration is enabled in your browser settings." };
    return { ok: true, f16: adapter.features.has("shader-f16") };
  } catch (e) {
    return { ok: false, f16: false, reason: String(e) };
  }
}

export function modelIdFor(tier: Tier, f16: boolean): string {
  return f16 ? tier.id : tier.id.replace("q4f16_1", "q4f32_1");
}

export function isCached(modelId: string): Promise<boolean> {
  return hasModelInCache(modelId).catch(() => false);
}

let engine: WebWorkerMLCEngine | null = null;
let worker: Worker | null = null;
let loadedId: string | null = null;
let thinks = false;

export function currentModel(): string | null {
  return loadedId;
}

export async function loadModel(
  tier: Tier,
  f16: boolean,
  onProgress: (r: InitProgressReport) => void,
): Promise<void> {
  const id = modelIdFor(tier, f16);
  if (engine && loadedId === id) return;

  await unload();
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  engine = await CreateWebWorkerMLCEngine(
    worker,
    id,
    { initProgressCallback: onProgress },
    { context_window_size: CONTEXT_WINDOW },
  );
  loadedId = id;
  thinks = !!tier.thinks;
}

export async function unload(): Promise<void> {
  try {
    await engine?.unload();
  } catch {

  }
  worker?.terminate();
  engine = null;
  worker = null;
  loadedId = null;
}

export function stop(): void {
  engine?.interruptGenerate();
}

export async function ask(
  history: Turn[],
  userMessage: string,
  onToken: (textSoFar: string) => void,
): Promise<string> {
  if (!engine) throw new Error("Load a model first.");

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history.slice(-HISTORY_TURNS * 2),
    { role: "user" as const, content: userMessage },
  ];

  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: 0.3,
    max_tokens: 1500,
    ...(thinks ? { extra_body: { enable_thinking: false } } : {}),
  });

  let text = "";
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta.content ?? "";
    onToken(stripThinking(text));
  }
  return stripThinking(text);
}

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)\s*/g, "");
}
