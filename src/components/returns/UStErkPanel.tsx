import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconSend, IconEye, IconEyeOff, IconCheck, IconClose, IconWarning, IconInfo, IconXml, IconCopy, IconDownload } from "../../constants/icons";
import type { Receipt, PeriodFilter, TaxpayerProfile } from "../Sidebar";
import { fmt } from "../Sidebar";
import { ElsterTip, VatRow, LawLink } from "./shared";

// ---------------------------------------------------------------------------
// USt panel — Umsatzsteuerjahreserklärung · § 18 UStG · USt 2A
// ---------------------------------------------------------------------------
export function UStErkPanel({
  allReceipts,
  period,
  apiBase = "",
  dbPath,
  taxpayer,
}: {
  allReceipts:  Receipt[];
  period:       PeriodFilter;
  apiBase?:     string;
  dbPath?:      string | null;
  taxpayer?:    TaxpayerProfile | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // ── ELSTER submission state ────────────────────────────────────────
  const [elsterOpen, setElsterOpen]         = useState(false);
  const [certFile, setCertFile]             = useState<File | null>(null);
  const certFileRef                         = useRef<HTMLInputElement>(null);
  const [certSaved, setCertSaved]           = useState(false);
  const [certUploading, setCertUploading]   = useState(false);
  const [certPassword, setCertPassword]     = useState("");
  const [certPinSaved, setCertPinSaved]     = useState(false);
  const [showPin, setShowPin]               = useState(false);
  const [herstellerId, setHerstellerId]     = useState("");
  const [steuernummer, setSteuernummer]     = useState("");
  const [finanzamtNr, setFinanzamtNr]       = useState("");
  const [bundeslandKz, setBundeslandKz]     = useState("");
  const [useTest, setUseTest]               = useState(true);
  const [submitting, setSubmitting]         = useState(false);
  const [validating, setValidating]         = useState(false);
  const [submitError, setSubmitError]       = useState<string | null>(null);
  const [validateMsg, setValidateMsg]       = useState<string | null>(null);
  const [transferticket, setTransferticket] = useState<string | null>(null);
  const [usteXml, setUsteXml]               = useState<string | null>(null);
  const [usteXmlOpen, setUsteXmlOpen]       = useState(false);
  const [usteXmlCopied, setUsteXmlCopied]   = useState(false);
  const [usteXmlLoading, setUsteXmlLoading] = useState(false);

  // Load stored cert / settings from the E-Bilanz shared endpoints on mount
  useEffect(() => {
    setCertSaved(false); setCertFile(null); setCertPassword(""); setCertPinSaved(false);
    setHerstellerId(""); setSteuernummer(""); setFinanzamtNr(""); setBundeslandKz("");
    setTransferticket(null); setSubmitError(null); setValidateMsg(null);
    if (!apiBase) return;
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/tax/ebilanz/settings${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        if (d.hersteller_id) setHerstellerId(d.hersteller_id);
        if (d.cert_pin)      { setCertPassword(d.cert_pin); setCertPinSaved(true); }
      })
      .catch(() => {});
    fetch(`${apiBase}/tax/ebilanz/cert${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCertSaved(d.stored); })
      .catch(() => {});
  }, [apiBase, dbPath]);

  // Pre-fill from taxpayer profile
  useEffect(() => {
    if (taxpayer?.tax_number) setSteuernummer(taxpayer.tax_number);
  }, [taxpayer]);

  async function uploadCert(file: File) {
    setCertUploading(true);
    try {
      const ab  = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ebilanz/cert${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cert_data_b64: b64 }),
      });
      if (res.ok) setCertSaved(true);
    } catch { /* retry */ }
    finally { setCertUploading(false); }
  }

  async function previewUsteXml() {
    setUsteXmlLoading(true);
    setSubmitError(null);
    let certDataB64: string | undefined;
    if (certFile) {
      const ab = await certFile.arrayBuffer();
      certDataB64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
    }
    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/uste/xml${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:  steuernummer  || undefined,
          bundesland_kz: bundeslandKz  || undefined,
          finanzamt_nr:  finanzamtNr   || undefined,
          hersteller_id: herstellerId  || undefined,
          cert_data_b64: certDataB64,
          cert_password: certPassword  || undefined,
          use_test:      useTest,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? res.statusText);
      }
      const text = await res.text();
      setUsteXml(text);
      setUsteXmlOpen(true);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setUsteXmlLoading(false);
    }
  }

  async function callUsteEndpoint(validateOnly: boolean) {
    const isSend = !validateOnly;
    if (isSend) { setSubmitting(true); setTransferticket(null); }
    else        { setValidating(true);  setValidateMsg(null); }
    setSubmitError(null);

    let certDataB64: string | undefined;
    if (certFile) {
      const ab  = await certFile.arrayBuffer();
      certDataB64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
    }

    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/uste/submit${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:  steuernummer || undefined,
          bundesland_kz: bundeslandKz || undefined,
          finanzamt_nr:  finanzamtNr  || undefined,
          hersteller_id: herstellerId || undefined,
          cert_data_b64: certDataB64,
          cert_password: certPassword || undefined,
          use_test:      useTest,
          validate_only: validateOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error_message ?? data.detail ?? res.statusText);
      }
      if (isSend) {
        setTransferticket(data.telenummer ?? "✓ OK");
      } else {
        setValidateMsg(data.message ?? "✓ XML valid");
      }
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isSend) setSubmitting(false);
      else        setValidating(false);
    }
  }

  const currentYear  = new Date().getFullYear();
  const year         = period.mode === "all" ? currentYear - 1 : period.year;
  const yearReceipts = allReceipts.filter((r) => r.receipt_date?.startsWith(String(year)));

  const purchases    = yearReceipts.filter((r) => r.receipt_type === "purchase");
  const sales        = yearReceipts.filter((r) => r.receipt_type === "sale");
  const regularInputVat = purchases.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const einfuhrInputVat = purchases.reduce((s, r) => s + (r.einfuhr_vat ?? 0), 0);
  const inputVat     = regularInputVat + einfuhrInputVat;
  const outputVat    = sales.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const netLiability = outputVat - inputVat;

  const salesByRate = sales.reduce<Record<string, { net: number; vat: number }>>((acc, r) => {
    if (r.vat_percentage == null) return acc;
    const key = String(r.vat_percentage);
    if (!acc[key]) acc[key] = { net: 0, vat: 0 };
    const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 0) / 100));
    const vat = r.business_vat ?? r.vat_amount ?? ((r.total_amount ?? 0) - net);
    acc[key].net += net;
    acc[key].vat += vat;
    return acc;
  }, {});

  return (
    <div className="bg-white border-2 border-amber-400 rounded">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">{t("dashboard.uste_title")}</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            {t("dashboard.decl_annual")} · <LawLink law="§ 18 UStG" href="https://www.gesetze-im-internet.de/ustg_1980/__18.html" /> · USt 2 A · {year}
          </p>
        </div>
        <IconChevronDown className={`w-4 h-4 text-black shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-amber-200 p-4 flex flex-col gap-4">

          {/* Year badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_year")}</span>
            <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{year}</span>
            {period.mode === "all" && (
              <span className="text-[10px] text-black font-mono">← {t("dashboard.jab_year_hint_all")}</span>
            )}
          </div>

          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="pb-1.5 pr-3 w-8" />
                <th className="pb-1.5 text-left text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.uste_col_section")}
                </th>
                <th className="pb-1.5 text-right text-[10px] font-bold uppercase tracking-wider text-black/70 w-28 pl-6">
                  {t("dashboard.vat_col_base")}
                </th>
                <th className="pb-1.5 text-right text-[10px] font-bold uppercase tracking-wider text-black/70 w-28 pl-4">
                  {t("dashboard.vat_col_tax")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr><td colSpan={4} className="pt-3 pb-1">
                <span className="inline-flex items-center gap-0 text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.vat_taxable_supplies")}
                  <ElsterTip lines={[t("dashboard.elster_tip_taxable_supplies_uste")]} />
                </span>
              </td></tr>
              <VatRow label={t("dashboard.vat_line_19")}
                base={fmt(salesByRate["19"]?.net ?? 0)}
                tax={fmt(salesByRate["19"]?.vat ?? 0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line22")]} />} />
              <VatRow label={t("dashboard.vat_line_7")}
                base={fmt(salesByRate["7"]?.net ?? 0)}
                tax={fmt(salesByRate["7"]?.vat ?? 0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line25")]} />} />
              <VatRow label={t("dashboard.vat_line_0")}
                base={fmt(salesByRate["0"]?.net ?? 0)}
                tax={fmt(salesByRate["0"]?.vat ?? 0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line28")]} />} />
              <tr><td colSpan={4} className="pt-4 pb-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.vat_input_section")}
                </span>
              </td></tr>
              <VatRow label={t("dashboard.uste_input_regular_label")}
                tax={fmt(regularInputVat)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line79")]} />} />
              {einfuhrInputVat > 0 && (
                <VatRow label={t("dashboard.vat_einfuhr_label")}
                  tax={fmt(einfuhrInputVat)} />
              )}
              {einfuhrInputVat > 0 && (
                <VatRow label={t("dashboard.uste_input_sum_label")} bold
                  tax={fmt(inputVat)} />
              )}
              <tr><td colSpan={4} className="pt-4 pb-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.uste_calculation_section")}
                </span>
              </td></tr>
              <VatRow label={t("dashboard.uste_prepayment_soll_label")}
                tax={`${netLiability < 0 ? "−" : ""}${fmt(Math.abs(netLiability))}`}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line119")]} />} />
              <VatRow label={t("dashboard.uste_final_balance_label")} bold
                tax={fmt(0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line120")]} />} />
            </tbody>
          </table>

          <p className="text-[10px] text-black font-mono leading-relaxed flex items-start gap-1">
            <IconInfo className="w-3 h-3 shrink-0 mt-px" /> {t("dashboard.uste_disclaimer")}
          </p>

          {/* ── ELSTER submission section ────────────────────────────── */}
          <div className="border border-amber-300 rounded-lg bg-amber-50">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-left"
              onClick={() => setElsterOpen(v => !v)}
            >
              <span className="text-[11px] font-black uppercase tracking-wider text-black flex items-center gap-1.5">
                <IconSend className="w-3.5 h-3.5 shrink-0" /> An ELSTER übermitteln
                {transferticket && (
                  <span className="ml-2 text-black normal-case font-mono flex items-center gap-1"><IconCheck className="w-3 h-3" />{transferticket}</span>
                )}
              </span>
              <IconChevronDown className={`w-3.5 h-3.5 text-black shrink-0 transition-transform ${elsterOpen ? "rotate-180" : ""}`} />
            </button>

            {elsterOpen && (
              <div className="px-3 pb-3 flex flex-col gap-2.5 text-[11px]">

                {/* Steuernummer */}
                <label className="flex flex-col gap-0.5">
                  <span className="font-bold text-black">Steuernummer</span>
                  <input
                    className="border border-amber-300 rounded px-2 py-1 font-mono text-[11px] bg-white"
                    value={steuernummer}
                    onChange={e => setSteuernummer(e.target.value)}
                    placeholder={taxpayer?.tax_number ?? "37/539/50531"}
                  />
                </label>

                {/* Finanzamt-Nr + Länderkennzeichen */}
                <div className="flex gap-2">
                  <label className="flex flex-col gap-0.5 flex-1">
                    <span className="font-bold text-black">Finanzamtsnr. (4-stlg.)</span>
                    <input
                      className="border border-amber-300 rounded px-2 py-1 font-mono text-[11px] bg-white"
                      value={finanzamtNr}
                      onChange={e => setFinanzamtNr(e.target.value)}
                      placeholder="3752"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 w-24">
                    <span className="font-bold text-black">Länder-Kz.</span>
                    <input
                      className="border border-amber-300 rounded px-2 py-1 font-mono text-[11px] bg-white"
                      value={bundeslandKz}
                      onChange={e => setBundeslandKz(e.target.value)}
                      placeholder="11"
                    />
                  </label>
                </div>

                {/* Hersteller-ID */}
                <label className="flex flex-col gap-0.5">
                  <span className="font-bold text-black">Hersteller-ID</span>
                  <input
                    className="border border-amber-300 rounded px-2 py-1 font-mono text-[11px] bg-white"
                    value={herstellerId}
                    onChange={e => setHerstellerId(e.target.value)}
                    placeholder="Hersteller-ID"
                  />
                </label>

                {/* Certificate upload */}
                <div className="flex flex-col gap-0.5">
                  <span className="font-bold text-black">
                    ELSTER-Zertifikat (.pfx)
                    {certSaved && <span className="ml-1.5 text-black font-normal flex items-center gap-0.5 inline-flex"><IconCheck className="w-3 h-3" /> gespeichert</span>}
                  </span>
                  <div className="flex gap-2 items-center">
                    <input
                      type="file"
                      accept=".pfx,.p12"
                      ref={certFileRef}
                      className="hidden"
                      onChange={async e => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        setCertFile(f);
                        await uploadCert(f);
                      }}
                    />
                    <button
                      className="border border-amber-400 rounded px-2 py-0.5 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors"
                      onClick={() => certFileRef.current?.click()}
                      disabled={certUploading}
                    >
                      {certUploading ? "Wird hochgeladen…" : certFile ? certFile.name : "Zertifikat wählen…"}
                    </button>
                  </div>
                </div>

                {/* Certificate PIN */}
                <label className="flex flex-col gap-0.5">
                  <span className="font-bold text-black">
                    Zertifikat-PIN
                    {certPinSaved && <span className="ml-1.5 text-black font-normal flex items-center gap-0.5 inline-flex"><IconCheck className="w-3 h-3" /> gespeichert</span>}
                  </span>
                  <div className="flex gap-1 items-center">
                    <input
                      type={showPin ? "text" : "password"}
                      className="border border-amber-300 rounded px-2 py-1 font-mono text-[11px] bg-white flex-1"
                      value={certPassword}
                      onChange={e => setCertPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <button
                      className="text-[10px] px-1.5 py-0.5 border border-amber-300 rounded bg-white hover:bg-amber-100"
                      onClick={() => setShowPin(v => !v)}
                    >
                      {showPin ? <IconEyeOff className="w-3.5 h-3.5" /> : <IconEye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </label>

                {/* Test mode toggle */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={useTest}
                    onChange={e => setUseTest(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className="text-black">Testmodus (nicht rechtswirksam)</span>
                </label>

                {!useTest && (
                  <div className="text-black font-bold text-[10px] border border-amber-500 rounded p-2 bg-amber-50 flex items-start gap-1.5">
                    <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px" /> <span>Produktivmodus — Übermittlung ist <em>rechtswirksam</em> und wird an das Finanzamt gesendet!</span>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-0.5 flex-wrap">
                  <button
                    className="border border-black rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50 flex items-center gap-1"
                    onClick={previewUsteXml}
                    disabled={usteXmlLoading || submitting}
                  >
                    <IconXml className="w-3.5 h-3.5" />
                    {usteXmlLoading ? "Lade…" : "XML anzeigen"}
                  </button>
                  <button
                    className="border border-amber-400 rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50"
                    onClick={() => callUsteEndpoint(true)}
                    disabled={validating || submitting}
                  >
                    {validating ? "Prüfe…" : "Validieren"}
                  </button>
                  <button
                    className={`rounded px-3 py-1 text-[11px] font-bold transition-colors disabled:opacity-50 ${
                      useTest
                        ? "bg-amber-400 hover:bg-amber-500 text-black border border-amber-500"
                        : "bg-black hover:bg-amber-500 text-white hover:text-black border border-black"
                    }`}
                    onClick={() => callUsteEndpoint(false)}
                    disabled={submitting || validating}
                  >
                    {submitting ? "Wird übermittelt…" : useTest ? "Test-Übermittlung" : "An Finanzamt senden"}
                  </button>
                </div>

                {/* Result feedback */}
                {validateMsg && !submitError && (
                  <div className="text-[10px] text-black bg-amber-50 border border-amber-300 rounded p-1.5">
                    {validateMsg}
                  </div>
                )}
                {transferticket && !submitError && (
                  <div className="text-[11px] text-black bg-amber-50 border border-amber-400 rounded p-2 flex items-start gap-1.5">
                    <IconCheck className="w-4 h-4 shrink-0 mt-px" /> <span>Erfolgreich übermittelt — Telenummer: <strong className="font-mono">{transferticket}</strong></span>
                  </div>
                )}
                {submitError && (
                  <div className="text-[10px] text-black bg-white border border-black rounded p-1.5 font-mono break-words flex items-start gap-1">
                    <IconClose className="w-3.5 h-3.5 shrink-0 mt-px" /> {submitError}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── USt XML Preview Modal ────────────────────────────────────── */}
      {usteXmlOpen && usteXml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="relative bg-white border-2 border-black rounded w-[90vw] max-w-4xl h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b-2 border-black bg-amber-50">
              <span className="text-xs font-black uppercase tracking-wider">ELSTER XML · USt {year}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(usteXml).then(() => {
                      setUsteXmlCopied(true);
                      setTimeout(() => setUsteXmlCopied(false), 2000);
                    });
                  }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconCopy className="w-3.5 h-3.5" />
                  {usteXmlCopied ? "Kopiert" : "Kopieren"}
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([usteXml], { type: "application/xml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `USt_${year}_ELSTER.xml`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  Download
                </button>
                <button
                  onClick={() => setUsteXmlOpen(false)}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-black hover:text-white transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-[10px] font-mono text-black leading-relaxed whitespace-pre select-all">
              {usteXml}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
