import { useState, useCallback, useEffect, useRef } from "react";
import Header from "./components/Header";
import Sidebar, { type Receipt, type PeriodFilter, type TaxpayerProfile, type ManualEntryForm, type ElsterSettings, TaxpayerModal, DEFAULT_PERIOD, filterByPeriod, EMPTY_ELSTER } from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import PreviewPanel from "./components/PreviewPanel";
import { type DBInfo } from "./components/DBSelector";
import Footer from "./components/Footer";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export default function App() {
  const [receipts,  setReceipts]  = useState<Receipt[]>([]);
  const [selected,  setSelected]  = useState<Receipt | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progressStep, setProgressStep] = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);
  const [activeDb,  setActiveDb]  = useState<string | null>(null);
  const [period,    setPeriod]    = useState<PeriodFilter>(DEFAULT_PERIOD);
  const [taxpayer,  setTaxpayer]  = useState<TaxpayerProfile | null>(null);
  const [elsterSettings, setElsterSettings] = useState<ElsterSettings>(EMPTY_ELSTER);
  const [showTaxpayerModal, setShowTaxpayerModal] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Load ELSTER settings from API
  const loadElsterSettings = useCallback((db: string | null) => {
    const qs = db ? `?db=${encodeURIComponent(db)}` : "";
    Promise.all([
      fetch(`${API_BASE}/tax/ebilanz/settings${qs}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/tax/ebilanz/cert${qs}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([settings, cert]) => {
      setElsterSettings({
        hersteller_id: settings?.hersteller_id ?? "",
        cert_pin:      settings?.cert_pin      ?? "",
        cert_saved:    cert?.stored            ?? false,
        elster_id:     settings?.elster_id     ?? "",
        eric_home:     settings?.eric_home     ?? "",
      });
    });
  }, []);

  // Reload taxpayer from project DB whenever the active DB changes
  useEffect(() => {
    const qs = activeDb ? `?db=${encodeURIComponent(activeDb)}` : "";
    fetch(`${API_BASE}/taxpayer${qs}`)
      .then((r) => r.json())
      .then((d) => setTaxpayer(d.taxpayer ?? null))
      .catch(() => setTaxpayer(null));
    loadElsterSettings(activeDb);
  }, [activeDb, loadElsterSettings]);

  const handleTaxpayerChange = useCallback((tp: TaxpayerProfile | null) => {
    setTaxpayer(tp);
    const qs = activeDb ? `?db=${encodeURIComponent(activeDb)}` : "";
    if (tp) {
      fetch(`${API_BASE}/taxpayer${qs}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tp),
      }).catch(() => {});
    } else {
      fetch(`${API_BASE}/taxpayer${qs}`, { method: "DELETE" }).catch(() => {});
    }
  }, [activeDb]);

  const dbQs = activeDb ? `?db=${encodeURIComponent(activeDb)}` : "";

  // All receipts from DB — filtering is client-side
  useEffect(() => {
    fetch(`${API_BASE}/receipts${dbQs}`)
      .then((r) => r.json())
      .then((d) => setReceipts(d.receipts ?? []))
      .catch(() => setError("Could not load receipts from server."));
  }, [activeDb]);

  // Filtered view — passed to Sidebar + Dashboard
  const visibleReceipts = filterByPeriod(receipts, period);

  const handleCancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
  }, []);

  const handleUpload = useCallback(async (files: File[], type: "purchase" | "sale" = "purchase") => {
    const abortController = new AbortController();
    uploadAbortRef.current = abortController;
    setUploading(true);
    setProgressStep(null);
    setError(null);
    let lastReceipt: Receipt | null = null;
    const total = files.length;
    for (let i = 0; i < total; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const prefix = total > 1 ? `[${i + 1}/${total}] ` : "";
      setProgressStep(prefix + "...");
      try {
        const body = new FormData();
        body.append("file", file);
        const tqs = taxpayer
          ? `&taxpayer_name=${encodeURIComponent(taxpayer.name)}&taxpayer_vat_id=${encodeURIComponent(taxpayer.vat_id)}&taxpayer_tax_number=${encodeURIComponent(taxpayer.tax_number)}&taxpayer_street=${encodeURIComponent(taxpayer.street)}&taxpayer_address_supplement=${encodeURIComponent(taxpayer.address_supplement ?? "")}&taxpayer_postcode=${encodeURIComponent(taxpayer.postcode)}&taxpayer_city=${encodeURIComponent(taxpayer.city)}&taxpayer_state=${encodeURIComponent(taxpayer.state)}&taxpayer_country=${encodeURIComponent(taxpayer.country)}`
          : "";
        const url = `${API_BASE}/receipts/upload/stream?receipt_type=${type}${activeDb ? `&db=${encodeURIComponent(activeDb)}` : ""}${tqs}`;
        const res = await fetch(url, { method: "POST", body, signal: abortController.signal });
        if (!res.ok || !res.body) throw new Error((await res.json()).detail ?? "Upload failed.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        outer: while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const lines = part.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) data = line.slice(6).trim();
            }
            if (eventType === "progress") {
              const msg: string = JSON.parse(data);
              const m = msg.match(/→\s+(PyMuPDF|PaddleOCR|Tesseract|Agent\s+([1-4]))/);
              if (m) {
                const label = m[2] ? `Agent ${m[2]}/4` : m[1].replace(/\s+/, " ");
                setProgressStep(prefix + label + "...");
              }
            } else if (eventType === "result") {
              lastReceipt = JSON.parse(data) as Receipt;
              // Update sidebar immediately so each completed receipt appears live
              setReceipts((prev) => [
                lastReceipt!,
                ...prev.filter((r) => r.id !== lastReceipt!.id),
              ]);
              break outer;
            } else if (eventType === "error") {
              throw new Error(JSON.parse(data));
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") break;
        const msg = e instanceof Error ? e.message : "Upload failed.";
        setError(total > 1 ? `${file.name}: ${msg}` : msg);
        // Continue processing remaining files
      }
    }

    // Refresh list once after all files processed
    try {
      const listRes = await fetch(`${API_BASE}/receipts${dbQs}`);
      const listData = await listRes.json();
      setReceipts(listData.receipts ?? []);
      if (lastReceipt) setSelected(lastReceipt);
    } catch { /* ignore */ }

    setUploading(false);
    setProgressStep(null);
  }, [activeDb, dbQs, taxpayer]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/receipts/${id}${dbQs}`, { method: "DELETE" });
      setReceipts((prev) => prev.filter((r) => r.id !== id));
      setSelected((prev) => (prev?.id === id ? null : prev));
    } catch {
      setError("Could not delete receipt.");
    }
  }, [activeDb]);

  const handleManualEntry = useCallback(async (entry: ManualEntryForm) => {
    setError(null);
    try {
      const qs = activeDb ? `?db=${encodeURIComponent(activeDb)}` : "";
      const body = {
        date:           entry.date,
        vendor:         entry.vendor || null,
        vendor_verified: entry.vendor_verified,
        receipt_type:   entry.receipt_type,
        category:       entry.category,
        subcategory:    entry.subcategory || null,
        net_amount:     parseFloat(entry.net_amount.replace(",", ".")) || 0,
        vat_percentage: parseFloat(entry.vat_percentage.replace(",", ".")) || 0,
        description:    entry.description || null,
        currency:       entry.currency,
      };
      const res = await fetch(`${API_BASE}/receipts${qs}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? "Save failed.");
      const receipt: Receipt = await res.json();
      setReceipts((prev) => [receipt, ...prev.filter((r) => r.id !== receipt.id)]);
      setSelected(receipt);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save entry.");
    }
  }, [activeDb]);

  const handleSaved = useCallback((updated: Receipt) => {
    setReceipts((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    setSelected(updated);
  }, []);

  const handleDbSelect = (db: DBInfo | null) => {
    setActiveDb(db?.path ?? null);
    setSelected(null);
    setReceipts([]);
    setPeriod(DEFAULT_PERIOD);
  };

  return (
    <div className="h-screen flex flex-col bg-white overflow-hidden">
      <Header
        apiBase={API_BASE}
        activeDb={activeDb}
        onDbSelect={handleDbSelect}
      />

      {error && (
        <div className="bg-red-50 border-b border-pink-200 px-6 py-2 text-xs text-pink-600 font-mono flex justify-between items-center">
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)} className="text-pink-400 hover:text-pink-700 font-bold ml-4">✕</button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          receipts={visibleReceipts}
          allReceipts={receipts}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onUpload={handleUpload}
          onManualEntry={handleManualEntry}
          onDelete={handleDelete}
          uploading={uploading}
          progressStep={progressStep}
          onCancelUpload={handleCancelUpload}
          error={null}
          period={period}
          onPeriodChange={setPeriod}
          taxpayer={taxpayer}
          onEditTaxpayer={() => setShowTaxpayerModal(true)}
          apiBase={API_BASE}
          dbPath={activeDb}
        />
        <Dashboard
          receipts={visibleReceipts}
          allReceipts={receipts}
          period={period}
          taxpayer={taxpayer}
          elsterSettings={elsterSettings}
          onEditTaxpayer={() => setShowTaxpayerModal(true)}
          onUpdateTaxpayer={(patch) => {
            const base = taxpayer ?? { name: "", vat_id: "", tax_number: "", street: "", address_supplement: "", postcode: "", city: "", state: "", country: "" };
            handleTaxpayerChange({ ...base, ...patch });
          }}
          apiBase={API_BASE}
          dbPath={activeDb}
        />
        <PreviewPanel
          receipt={selected}
          apiBase={API_BASE}
          dbPath={activeDb}
          onSaved={handleSaved}
        />
      </div>

      <Footer />

      {showTaxpayerModal && (
        <TaxpayerModal
          initial={taxpayer}
          apiBase={API_BASE}
          dbPath={activeDb}
          onSave={(tp) => { handleTaxpayerChange(tp); setShowTaxpayerModal(false); loadElsterSettings(activeDb); }}
          onClear={() => { handleTaxpayerChange(null); setShowTaxpayerModal(false); }}
          onClose={() => { setShowTaxpayerModal(false); loadElsterSettings(activeDb); }}
        />
      )}
    </div>
  );
}