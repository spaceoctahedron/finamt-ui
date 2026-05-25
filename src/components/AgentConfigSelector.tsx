import { useEffect, useRef, useState } from "react";
import {
  IconChevronDown, IconAgent, IconQwen, IconMistral, IconSpinner,
} from "../constants/icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentConfig = {
  agent_model:       string;
  agent_timeout:     number;
  agent_num_ctx:     number;
  agent_max_retries: number;
  ocr_language:      string;
  ocr_timeout:       number;
  ocr_preprocess:    boolean;
  tesseract_cmd:     string;
  pdf_dpi:           number;
};

type Props = {
  apiBase: string;
};

// ---------------------------------------------------------------------------
// Preset model list
// ---------------------------------------------------------------------------

type ModelPreset = { id: string; label: string; icon: React.ReactNode };

const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "mistral:7b",
    label: "mistral:7b",
    icon: <IconMistral className="w-3.5 h-3.5" />,
  },
  {
    id: "qwen2.5:7b-instruct-q4_K_M",
    label: "qwen2.5:7b",
    icon: <IconQwen className="w-3.5 h-3.5" />,
  },
];

const DEFAULT_CFG: AgentConfig = {
  agent_model:       "mistral:7b",
  agent_timeout:     60,
  agent_num_ctx:     4096,
  agent_max_retries: 2,
  ocr_language:      "german",
  ocr_timeout:       60,
  ocr_preprocess:    true,
  tesseract_cmd:     "tesseract",
  pdf_dpi:           150,
};

// ---------------------------------------------------------------------------
// Helper: pick the right brand icon for a model name
// ---------------------------------------------------------------------------

function ModelIcon({ model, className }: { model: string; className?: string }) {
  if (model.startsWith("qwen")) return <IconQwen className={className} />;
  if (model.startsWith("mistral")) return <IconMistral className={className} />;
  return <IconAgent className={className} />;
}

// ---------------------------------------------------------------------------
// Helper: shorten model name for the trigger badge
// ---------------------------------------------------------------------------

function shortModel(model: string): string {
  // "qwen2.5:7b-instruct-q4_K_M" → "qwen2.5:7b"
  const colon = model.indexOf(":");
  if (colon === -1) return model.length > 14 ? model.slice(0, 14) + "…" : model;
  const base = model.slice(0, colon);
  const tag  = model.slice(colon + 1).split("-")[0];
  return `${base}:${tag}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentConfigSelector({ apiBase }: Props) {
  const [open,    setOpen]    = useState(false);
  const [cfg,     setCfg]     = useState<AgentConfig>(DEFAULT_CFG);
  const [draft,   setDraft]   = useState<AgentConfig>(DEFAULT_CFG);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [saved,   setSaved]   = useState(false);

  // Custom model input toggle
  const [customModel, setCustomModel] = useState(false);
  const [customModelVal, setCustomModelVal] = useState("");

  const ref     = useRef<HTMLDivElement>(null);
  const loaded  = useRef(false);

  // ── Close on outside click ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Load config ─────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`${apiBase}/config`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const loaded: AgentConfig = {
        agent_model:       data.agent_model       ?? DEFAULT_CFG.agent_model,
        agent_timeout:     data.agent_timeout      ?? DEFAULT_CFG.agent_timeout,
        agent_num_ctx:     data.agent_num_ctx      ?? DEFAULT_CFG.agent_num_ctx,
        agent_max_retries: data.agent_max_retries  ?? DEFAULT_CFG.agent_max_retries,
        ocr_language:      data.ocr_language       ?? DEFAULT_CFG.ocr_language,
        ocr_timeout:       data.ocr_timeout        ?? DEFAULT_CFG.ocr_timeout,
        ocr_preprocess:    data.ocr_preprocess     ?? DEFAULT_CFG.ocr_preprocess,
        tesseract_cmd:     data.tesseract_cmd      ?? DEFAULT_CFG.tesseract_cmd,
        pdf_dpi:           data.pdf_dpi            ?? DEFAULT_CFG.pdf_dpi,
      };
      setCfg(loaded);
      setDraft(loaded);
      // Detect if current model is a preset
      const isPreset = MODEL_PRESETS.some((p) => p.id === loaded.agent_model);
      setCustomModel(!isPreset);
      if (!isPreset) setCustomModelVal(loaded.agent_model);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open && !loaded.current) { loaded.current = true; load(); } }, [open]);

  // ── Save config ─────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload = { ...draft };
    if (customModel) payload.agent_model = customModelVal.trim() || draft.agent_model;
    try {
      const res  = await fetch(`${apiBase}/config`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Save failed");
      const updated: AgentConfig = {
        agent_model:       data.agent_model       ?? payload.agent_model,
        agent_timeout:     data.agent_timeout      ?? payload.agent_timeout,
        agent_num_ctx:     data.agent_num_ctx      ?? payload.agent_num_ctx,
        agent_max_retries: data.agent_max_retries  ?? payload.agent_max_retries,
        ocr_language:      data.ocr_language       ?? payload.ocr_language,
        ocr_timeout:       data.ocr_timeout        ?? payload.ocr_timeout,
        ocr_preprocess:    data.ocr_preprocess     ?? payload.ocr_preprocess,
        tesseract_cmd:     data.tesseract_cmd      ?? payload.tesseract_cmd,
        pdf_dpi:           data.pdf_dpi            ?? payload.pdf_dpi,
      };
      setCfg(updated);
      setDraft(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(cfg)
    || (customModel && customModelVal.trim() !== cfg.agent_model);

  const effectiveModel = customModel ? (customModelVal.trim() || cfg.agent_model) : draft.agent_model;

  // ── Field helpers ────────────────────────────────────────────────────────
  const setField = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div ref={ref} className="relative flex items-center gap-1.5">

      {/* ── Trigger pill ── */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-sm font-mono text-black/70 hover:text-black
                   border border-black/15 rounded px-2 py-1 ml-2.5 hover:border-black/40
                   transition-colors select-none"
        title="Agent Config"
      >
        <ModelIcon model={cfg.agent_model} className="w-3.5 h-3.5 shrink-0 text-black/60" />
        <span className="text-black/80 font-semibold">{shortModel(cfg.agent_model)}</span>
        <IconChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-black/40 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* ── Dropdown panel ── */}
      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 z-50 w-80
                     bg-white border-2 border-black shadow-[4px_4px_0_#000]
                     rounded text-sm font-mono"
        >
          {/* header */}
          <div className="px-4 py-3 border-b border-black/10 flex items-center gap-2">
            <IconAgent className="w-4 h-4 text-black/50" />
            <span className="font-bold text-xs tracking-widest uppercase">Agent Config</span>
            {loading && <IconSpinner className="w-3.5 h-3.5 ml-auto text-black/40 animate-spin" />}
          </div>

          <div className="px-4 py-3 space-y-4 max-h-[70vh] overflow-y-auto">

            {/* error */}
            {error && (
              <p className="text-red-500 text-xs bg-red-50 border border-red-200 rounded px-2 py-1">
                {error}
              </p>
            )}

            {/* ── Model selection ── */}
            <section>
              <p className="text-[10px] uppercase tracking-widest text-black/40 mb-2 font-bold">Model</p>
              <div className="space-y-1">
                {MODEL_PRESETS.map((preset) => (
                  <label
                    key={preset.id}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer
                                border transition-colors
                                ${!customModel && draft.agent_model === preset.id
                                  ? "border-black bg-amber-50"
                                  : "border-transparent hover:border-black/20 hover:bg-black/3"}`}
                  >
                    <input
                      type="radio"
                      name="agent_model"
                      value={preset.id}
                      checked={!customModel && draft.agent_model === preset.id}
                      onChange={() => { setCustomModel(false); setField("agent_model", preset.id); }}
                      className="sr-only"
                    />
                    {/* custom radio dot */}
                    <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0
                      ${!customModel && draft.agent_model === preset.id ? "border-black" : "border-black/30"}`}>
                      {!customModel && draft.agent_model === preset.id && (
                        <span className="w-1.5 h-1.5 rounded-full bg-black block" />
                      )}
                    </span>
                    {preset.icon}
                    <span className={`text-xs ${!customModel && draft.agent_model === preset.id ? "font-bold" : ""}`}>
                      {preset.id}
                    </span>
                  </label>
                ))}

                {/* Custom model */}
                <label
                  className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer
                              border transition-colors
                              ${customModel
                                ? "border-black bg-amber-50"
                                : "border-transparent hover:border-black/20 hover:bg-black/3"}`}
                >
                  <input
                    type="radio"
                    name="agent_model"
                    checked={customModel}
                    onChange={() => setCustomModel(true)}
                    className="sr-only"
                  />
                  <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0
                    ${customModel ? "border-black" : "border-black/30"}`}>
                    {customModel && <span className="w-1.5 h-1.5 rounded-full bg-black block" />}
                  </span>
                  <IconAgent className="w-3.5 h-3.5 text-black/40" />
                  <span className="text-xs text-black/50">Custom…</span>
                </label>

                {customModel && (
                  <input
                    type="text"
                    value={customModelVal}
                    onChange={(e) => setCustomModelVal(e.target.value)}
                    placeholder="e.g. llama3.2:latest"
                    className="w-full mt-1 px-3 py-1.5 text-xs border-2 border-black rounded
                               focus:outline-none focus:ring-0 font-mono"
                    autoFocus
                  />
                )}
              </div>
            </section>

            {/* ── Agent settings ── */}
            <section>
              <p className="text-[10px] uppercase tracking-widest text-black/40 mb-2 font-bold">
                Agent settings
              </p>
              <div className="space-y-2">
                <NumberField
                  label="FINAMT_AGENT_TIMEOUT"
                  value={draft.agent_timeout}
                  onChange={(v) => setField("agent_timeout", v)}
                />
                <NumberField
                  label="FINAMT_AGENT_NUM_CTX"
                  value={draft.agent_num_ctx}
                  onChange={(v) => setField("agent_num_ctx", v)}
                />
                <NumberField
                  label="FINAMT_AGENT_MAX_RETRIES"
                  value={draft.agent_max_retries}
                  onChange={(v) => setField("agent_max_retries", v)}
                />
              </div>
            </section>

            {/* ── OCR settings ── */}
            <section>
              <p className="text-[10px] uppercase tracking-widest text-black/40 mb-2 font-bold">
                OCR settings
              </p>
              <div className="space-y-2">
                <TextField
                  label="FINAMT_OCR_LANGUAGE"
                  value={draft.ocr_language}
                  onChange={(v) => setField("ocr_language", v)}
                />
                <NumberField
                  label="FINAMT_OCR_TIMEOUT"
                  value={draft.ocr_timeout}
                  onChange={(v) => setField("ocr_timeout", v)}
                />
                <TextField
                  label="FINAMT_TESSERACT_CMD"
                  value={draft.tesseract_cmd}
                  onChange={(v) => setField("tesseract_cmd", v)}
                />
                <BoolField
                  label="FINAMT_OCR_PREPROCESS"
                  value={draft.ocr_preprocess}
                  onChange={(v) => setField("ocr_preprocess", v)}
                />
                <NumberField
                  label="FINAMT_PDF_DPI"
                  value={draft.pdf_dpi}
                  onChange={(v) => setField("pdf_dpi", v)}
                />
              </div>
            </section>
          </div>

          {/* footer — save button */}
          <div className="px-4 py-3 border-t border-black/10 flex items-center justify-between">
            <span className="text-[10px] text-black/30 font-mono truncate max-w-[160px]">
              {shortModel(effectiveModel)}
            </span>
            <button
              disabled={loading || saving || (!dirty && !saved)}
              onClick={handleSave}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded
                         transition-colors border-2
                         ${saved
                           ? "border-green-500 text-green-600 bg-green-50"
                           : dirty
                             ? "border-black bg-amber-400 text-black hover:bg-amber-300"
                             : "border-black/20 text-black/30 cursor-default"}`}
            >
              {saving && <IconSpinner className="w-3 h-3 animate-spin" />}
              {saved ? "Saved ✓" : "Apply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small field sub-components
// ---------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-black/50 w-44 shrink-0 truncate" title={label}>
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 px-2 py-1 text-xs border border-black/20 rounded
                   focus:border-black focus:outline-none font-mono"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-black/50 w-44 shrink-0 truncate" title={label}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 min-w-0 px-2 py-1 text-xs border border-black/20 rounded
                   focus:border-black focus:outline-none font-mono"
      />
    </div>
  );
}

function BoolField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="text-[10px] text-black/50 w-44 shrink-0 truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative w-8 h-4.5 rounded-full transition-colors duration-150 shrink-0
                    ${value ? "bg-amber-400" : "bg-black/20"}`}
        style={{ height: "18px" }}
      >
        <span
          className={`absolute top-[3px] left-[3px] w-3 h-3 bg-black rounded-full
                      transition-transform duration-150 ${value ? "translate-x-3" : "translate-x-0"}`}
        />
      </button>
      <span className="text-[10px] text-black/40">{value ? "true" : "false"}</span>
    </div>
  );
}
