import { useState, useRef, useEffect } from "react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconFilePdf, IconCheck, IconClose, IconInfo } from "../../constants/icons";
import type { Receipt, PeriodFilter, TaxpayerProfile } from "../Sidebar";
import { CASHFLOW_ONLY_CATS } from "../Sidebar";
import { LawLink, ElsterTip } from "./shared";

// ---------------------------------------------------------------------------
// Jahresabschluss (Bilanz + GuV) — § 267a HGB Kleinstkapitalgesellschaft
// ---------------------------------------------------------------------------
const MATERIAL_CATS_JAB = new Set(["material", "equipment"]);
const INCOME_CATS_JAB   = new Set(["services", "consulting", "products", "licensing"]);

type JabSettings = {
  nettomethode: boolean;
};

type JabResult = {
  guv: {
    umsatzerlöse:             number;
    sonstigeBetriebserlöse:   number;
    gesamtleistung:           number;
    materialaufwand:          number;
    sonstigeBetriebsausgaben: number;
    gesamtaufwand:            number;
    jahresergebnis:           number;
  };
  bilanz: {
    kassenbestand:             number;
    ausstehendeEinlagenAktiva: number;
    summeAktiva:               number;
    stammkapital:              number;
    nichtEingefordert:         number;
    jahresergebnis:            number;
    gewinnvortrag:             number;   // auto-computed from prior years
    /** Net cash from cashflow-only items (tax_settlement, capital_movement)
     *  in the reporting year.  Positive = net refund / inflow received.
     *  Shown as a separate Passiva line so the balance sheet stays balanced. */
    steuerpositionen:          number;
    summeEigenkapital:         number;
    summePassiva:              number;
    ausgeglichen:              boolean;
    differenz:                 number;
  };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function computeJab(
  allReceipts:   Receipt[],
  gründungsjahr: number,
  stammkapital:  number,
  eingezahlt:    number,
  nettomethode:  boolean,
  year:          number,
): JabResult {
  // Split receipts into prior years (for vortrag + opening cash)
  // and the reporting year (for GuV).
  let umsatzerlöse = 0, sonstigeBetriebserlöse = 0;
  let materialaufwand = 0, sonstigeBetriebsausgaben = 0;
  let priorNet = 0; // cumulative net result from Gründungsjahr to year-1
  // Net cash from cashflow-only receipts (tax_settlement, capital_movement)
  // in the reporting year only.  Prior-year cashflow IS folded into priorNet
  // so that opening-cash and gewinnvortrag stay correct for subsequent years.
  let cashflowNetCurrent = 0;

  for (const r of allReceipts) {
    if (!r.receipt_date) continue;
    const ry = parseInt(r.receipt_date.slice(0, 4), 10);
    if (ry < gründungsjahr || ry > year) continue;
    const net = r.net_amount ?? ((r.total_amount ?? 0) - (r.vat_amount ?? 0));
    const cat = r.category ?? "other";
    const isPurchase = r.receipt_type === "purchase";
    const cashImpact = isPurchase ? -net : net;

    // Cashflow-only items (tax settlements, capital movements):
    // — excluded from GuV entirely
    // — their cash impact is tracked separately so it reaches the bank balance
    if (CASHFLOW_ONLY_CATS.has(cat)) {
      if (ry < year) priorNet += cashImpact; // carry into opening cash of next year
      else           cashflowNetCurrent += cashImpact;
      continue;
    }

    if (ry < year) {
      // Accumulate into Gewinnvortrag and opening-cash carry-forward.
      priorNet += isPurchase ? -net : net;
    } else {
      // Current reporting year → GuV.
      if (isPurchase) {
        if (MATERIAL_CATS_JAB.has(cat)) materialaufwand          += net;
        else                            sonstigeBetriebsausgaben += net;
      } else {
        if (INCOME_CATS_JAB.has(cat))   umsatzerlöse             += net;
        else                            sonstigeBetriebserlöse   += net;
      }
    }
  }

  umsatzerlöse             = r2(umsatzerlöse);
  sonstigeBetriebserlöse   = r2(sonstigeBetriebserlöse);
  materialaufwand          = r2(materialaufwand);
  sonstigeBetriebsausgaben = r2(sonstigeBetriebsausgaben);
  priorNet                 = r2(priorNet);
  cashflowNetCurrent       = r2(cashflowNetCurrent);

  const gesamtleistung = r2(umsatzerlöse + sonstigeBetriebserlöse);
  const gesamtaufwand  = r2(materialaufwand + sonstigeBetriebsausgaben);
  const jahresergebnis = r2(gesamtleistung - gesamtaufwand);

  // Opening cash for the reporting year:
  //   Capital was injected ONCE in the Gründungsjahr.
  //   Each subsequent year's opening cash = prior year's closing cash
  //   = eingezahlt + cumulative net result of all prior years
  //     (priorNet now also contains prior-year cashflow-only flows).
  const openingCash  = r2(eingezahlt + priorNet);
  // kassenbestand: P&L flows + cashflow-only flows (refunds/payments to Finanzamt etc.)
  const kassenbestand = r2(Math.max(openingCash + gesamtleistung - gesamtaufwand + cashflowNetCurrent, 0));

  const ausstehend = r2(stammkapital - eingezahlt);
  const ausstehendeEinlagenAktiva = nettomethode ? 0 : ausstehend;
  const summeAktiva = r2(kassenbestand + ausstehendeEinlagenAktiva);

  const nichtEingefordert = nettomethode ? ausstehend : 0;
  // Gewinnvortrag = cumulative result of all years BEFORE the reporting year
  // (includes prior cashflow-only items so it mirrors the actual opening cash).
  const gewinnvortrag     = priorNet;
  const summeEigenkapital = r2(stammkapital - nichtEingefordert + gewinnvortrag + jahresergebnis);
  // cashflow-only items of the reporting year appear here as a dedicated Passiva position
  // so the balance sheet stays balanced without distorting the GuV.
  const steuerpositionen  = cashflowNetCurrent;
  const summePassiva      = r2(summeEigenkapital + steuerpositionen);

  const differenz    = r2(summeAktiva - summePassiva);
  const ausgeglichen = Math.abs(differenz) < 0.005;

  return {
    guv: {
      umsatzerlöse, sonstigeBetriebserlöse, gesamtleistung,
      materialaufwand, sonstigeBetriebsausgaben, gesamtaufwand, jahresergebnis,
    },
    bilanz: {
      kassenbestand, ausstehendeEinlagenAktiva, summeAktiva,
      stammkapital, nichtEingefordert,
      jahresergebnis, gewinnvortrag, steuerpositionen,
      summeEigenkapital, summePassiva, ausgeglichen, differenz,
    },
  };
}

export function JahresabschlussPanel({ allReceipts, period, taxpayer, onEditTaxpayer, apiBase = "", dbPath }: {
  allReceipts:     Receipt[];
  period:          PeriodFilter;
  taxpayer?:       TaxpayerProfile | null;
  onEditTaxpayer?: () => void;
  apiBase?:        string;
  dbPath?:         string | null;
}) {
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();

  // Derive the reporting year from the sidebar period — the user should not enter it manually.
  const year = period.mode === "all" ? currentYear - 1 : period.year;

  const [open, setOpen] = useState(false);
  const [s, setS] = useState<JabSettings>({
    nettomethode: true,
  });
  const [xbrlError, setXbrlError] = useState<string | null>(null);
  const [xbrlXml, setXbrlXml] = useState<string | null>(null);
  const [xbrlPreviewOpen, setXbrlPreviewOpen] = useState(false);
  const [xbrlCopied, setXbrlCopied] = useState(false);
  const [localLogo, setLocalLogo] = useState<string | null>(null);
  const logoFileRef = useRef<HTMLInputElement>(null);

  const [bilanzPreviewOpen, setBilanzPreviewOpen] = useState(false);
  const [bilanzHtml, setBilanzHtml] = useState<string | null>(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const bilanzIframeRef = useRef<HTMLIFrameElement>(null);

  type Submission = { type: string; year: number; submitted_at: string; note?: string };
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [markSubmitting, setMarkSubmitting] = useState(false);
  // ERiC submit form
  const [ericHome, setEricHome]             = useState("");
  const [ericHomeSaved, setEricHomeSaved]   = useState(false);
  const [certFile, setCertFile]             = useState<File | null>(null);
  const certFileRef                         = useRef<HTMLInputElement>(null);
  const ericHomeInputRef                    = useRef<HTMLInputElement>(null);
  const [certSaved, setCertSaved]           = useState(false);
  const [certUploading, setCertUploading]   = useState(false);
  const [certPassword, setCertPassword]     = useState("");
  const [certPinSaved, setCertPinSaved]     = useState(false);
  const [elsterId, setElsterId]             = useState("");
  const [herstellerId, setHerstellerId]     = useState("");
  const [taxonomy, setTaxonomy]             = useState("de-gaap-ci-2025-04-01"); // 6.9 default
  const [showTaxDropdown, setShowTaxDropdown] = useState(false);
  const [showPin, setShowPin]               = useState(false);
  const [useTest, setUseTest]               = useState(true);
  const [submitting, setSubmitting]         = useState(false);
  const [validating, setValidating]         = useState(false);
  const [submitError, setSubmitError]       = useState<string | null>(null);
  const [validateMsg, setValidateMsg]       = useState<string | null>(null);
  const [transferticket, setTransferticket] = useState<string | null>(null);

  // Load stored ERiC home and cert on mount / project change
  useEffect(() => {
    // Clear immediately so previous project's values don't persist
    setEricHome("");
    setEricHomeSaved(false);
    setCertSaved(false);
    setCertFile(null);
    setCertPassword("");
    setCertPinSaved(false);
    setElsterId("");
    setHerstellerId("");
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/tax/ebilanz/settings${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        if (d.eric_home)     { setEricHome(d.eric_home); setEricHomeSaved(true); }
        if (d.elster_id)     { setElsterId(d.elster_id); }
        if (d.hersteller_id) { setHerstellerId(d.hersteller_id); }
        if (d.cert_pin)      { setCertPassword(d.cert_pin); setCertPinSaved(true); }
      })
      .catch(() => {});
    fetch(`${apiBase}/tax/ebilanz/cert${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setCertSaved(d.stored); } })
      .catch(() => {});
    fetch(`${apiBase}/submissions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.submissions) setSubmissions(d.submissions); })
      .catch(() => {});
  }, [apiBase, dbPath]);

  async function downloadBilanzPdf() {
    const iframe = bilanzIframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    setPdfGenerating(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const { default: jsPDF } = await import("jspdf");
      const canvas = await html2canvas(iframe.contentDocument.body, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        width: 794,
        windowWidth: 794,
      });
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pdfW = pdf.internal.pageSize.getWidth();
      const pdfH = (canvas.height * pdfW) / canvas.width;
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, pdfW, pdfH);
      pdf.save(`Bilanz_${year}_${(taxpayer?.name ?? "GmbH").replace(/\s+/g, "_")}.pdf`);
    } finally {
      setPdfGenerating(false);
    }
  }

  async function markAsSubmitted() {
    setMarkSubmitting(true);
    const record: Submission = {
      type: "bundesanzeiger",
      year,
      submitted_at: new Date().toISOString(),
    };
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    try {
      const res = await fetch(`${apiBase}/submissions${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (res.ok) setSubmissions(prev => [...prev, record]);
    } catch { /* ignore */ }
    setMarkSubmitting(false);
  }

  async function saveSetting(key: string, value: string) {
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    try {
      await fetch(`${apiBase}/tax/ebilanz/settings${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
    } catch { /* ignore */ }
  }

  async function saveEricHome(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    try {
      const res = await fetch(`${apiBase}/tax/ebilanz/eric-home${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eric_home: trimmed }),
      });
      if (res.ok) setEricHomeSaved(true);
    } catch { /* ignore */ }
  }

  async function previewXbrl() {
    setXbrlError(null);
    try {
      const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ebilanz/envelope${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:         taxpayer?.tax_number ?? "",
          company_name:         taxpayer?.name ?? "",
          legal_form:           taxpayer?.rechtsform ?? "GmbH",
          stammkapital:         stammkapital,
          eingezahltes_kapital: eingezahlt,
          vortrag:              bilanz.gewinnvortrag,
          nettomethode:         s.nettomethode,
          hersteller_id:        herstellerId || undefined,
          use_test:             useTest,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        const msg = Array.isArray(err.detail)
          ? err.detail.map((e: { msg?: string }) => e.msg ?? JSON.stringify(e)).join("; ")
          : (err.detail ?? res.statusText);
        throw new Error(msg);
      }
      const text = await res.text();
      setXbrlXml(text);
      setXbrlPreviewOpen(true);
    } catch (e: unknown) {
      setXbrlError(e instanceof Error ? e.message : String(e));
    }
  }

  async function downloadXbrlFile() {
    setXbrlError(null);
    try {
      const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ebilanz/envelope${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:         taxpayer?.tax_number ?? "",
          company_name:         taxpayer?.name ?? "",
          legal_form:           taxpayer?.rechtsform ?? "GmbH",
          stammkapital:         stammkapital,
          eingezahltes_kapital: eingezahlt,
          vortrag:              bilanz.gewinnvortrag,
          nettomethode:         s.nettomethode,
          hersteller_id:        herstellerId || undefined,
          use_test:             useTest,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        const msg = Array.isArray(err.detail)
          ? err.detail.map((e: { msg?: string }) => e.msg ?? JSON.stringify(e)).join("; ")
          : (err.detail ?? res.statusText);
        throw new Error(msg);
      }
      const text = await res.text();
      const blob = new Blob([text], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Bilanz_${year}_${(taxpayer?.name ?? "GmbH").replace(/\s+/g, "_")}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setXbrlError(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadCert(file: File) {
    setCertUploading(true);
    try {
      const ab  = await file.arrayBuffer();
      const u8  = new Uint8Array(ab);
      const bin = Array.from(u8).map(b => String.fromCharCode(b)).join("");
      const b64 = btoa(bin);
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ebilanz/cert${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cert_data_b64: b64 }),
      });
      if (res.ok) {
        await res.json();
        setCertSaved(true);
      }
    } catch { /* ignore — user can retry */ }
    finally { setCertUploading(false); }
  }

  async function callEricEndpoint(validateOnly: boolean) {
    const isSend = !validateOnly;
    if (isSend) { setSubmitting(true); setTransferticket(null); }
    else        { setValidating(true);  setValidateMsg(null); }
    setSubmitError(null);

    let certDataB64: string | undefined;
    if (certFile) {
      const ab  = await certFile.arrayBuffer();
      const u8  = new Uint8Array(ab);
      const bin = Array.from(u8).map(b => String.fromCharCode(b)).join("");
      certDataB64 = btoa(bin);
    }
    // If no new file but a cert is stored server-side, backend will use it automatically

    try {
      const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ebilanz/submit${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:         taxpayer?.tax_number ?? "",
          elster_id:            elsterId || undefined,
          company_name:         taxpayer?.name ?? "",
          legal_form:           taxpayer?.rechtsform ?? "GmbH",
          stammkapital,
          eingezahltes_kapital: eingezahlt,
          vortrag:              bilanz.gewinnvortrag,
          nettomethode:         s.nettomethode,
          eric_home:            ericHome || undefined,
          hersteller_id:        herstellerId || undefined,
          cert_data_b64:        certDataB64,
          cert_password:        certPassword || undefined,
          use_test:             useTest,
          validate_only:        validateOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error_message ?? data.detail ?? res.statusText);
      }
      if (isSend) {
        setTransferticket(data.telenummer ?? "✓ OK");
        // Persist ELSTER submission record so the Returns Overview can reflect it
        const _qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
        const _rec: Submission = { type: "ebilanz", year, submitted_at: new Date().toISOString() };
        fetch(`${apiBase}/submissions${_qs}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(_rec) }).catch(() => {});
        setSubmissions(prev => [...prev, _rec]);
      } else {
        setValidateMsg("✓ OK — XBRL valid");
      }
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isSend) setSubmitting(false);
      else        setValidating(false);
    }
  }

  // Company facts come from taxpayer profile (persisted in DB).
  // Fall back to sensible defaults so the panel is always usable.
  const gründungsjahr = Math.min(taxpayer?.gründungsjahr ?? year, year);
  const stammkapital  = taxpayer?.stammkapital ?? 25000;
  const eingezahlt    = taxpayer?.eingezahlt   ?? 12500;

  const jab  = computeJab(allReceipts, gründungsjahr, stammkapital, eingezahlt, s.nettomethode, year);
  const { guv, bilanz } = jab;

  function generateBilanzPdf() {
    const eur = (n: number) =>
      n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
    const neg = (n: number) => n < 0 ? `- ${eur(Math.abs(n))}` : eur(n);
    const row = (label: string, val: string, indent = 0, bold = false) => {
      const pad = indent > 0 ? `padding-left:${indent * 12}pt` : "";
      const w = bold ? "font-weight:bold" : "";
      return `<tr><td style="${pad};${w}">${label}</td><td style="text-align:right;${w}">${val}</td></tr>`;
    };
    const totalRow = (label: string, val: string) =>
      `<tr><td colspan="2" style="padding:0;height:1.5pt;background:#000"></td></tr><tr><td style="font-weight:bold;padding-top:5pt">${label}</td><td style="text-align:right;font-weight:bold;padding-top:5pt">${val}</td></tr>`;

    const company = taxpayer?.name ?? "–";
    const logo = localLogo ?? taxpayer?.logo ?? null;
    const logoHtml = logo
      ? `<div style="text-align:center;margin-bottom:10pt"><img src="${logo}" alt="" style="max-height:60pt;max-width:160pt;object-fit:contain" /></div>`
      : "";
    const b = bilanz;
    const ausstehendeRow = !s.nettomethode && b.ausstehendeEinlagenAktiva > 0
      ? row("C. Ausstehende Einlagen auf das gezeichnete Kapital", eur(b.ausstehendeEinlagenAktiva), 0, true) : "";
    const nichtEingRow = s.nettomethode && b.nichtEingefordert > 0
      ? row("./. Nicht eingeforderte ausstehende Einlagen", `- ${eur(b.nichtEingefordert)}`, 2) : "";
    const gwRow = b.gewinnvortrag !== 0
      ? row("IV. Gewinnvortrag / Verlustvortrag", neg(b.gewinnvortrag), 1) : "";
    const stRow = b.steuerpositionen !== 0
      ? row("B. Steuerpositionen / sonstige Passiva", neg(b.steuerpositionen)) : "";

    const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>Bilanz ${year} — ${company}</title>
<style>
@page{size:A4 portrait;margin:20mm 18mm}
*{box-sizing:border-box;margin:0;padding:0}
html{background:#fef3c7}
body{font-family:'Courier New',monospace;font-size:9.5pt;color:#000;
  background:#fff;max-width:174mm;min-height:257mm;margin:16pt auto;padding:20mm 18mm;
  box-shadow:0 2px 16px rgba(0,0,0,.18)}
.header{text-align:center;margin-bottom:18pt;border-bottom:1.5pt solid #000;padding-bottom:10pt}
.header p{font-size:10pt;font-weight:bold}
.header h1{font-size:13pt;font-weight:bold;margin-bottom:3pt}
.subheader{font-size:8pt;color:#555;margin-top:4pt}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:28pt;margin-top:14pt}
.col-header{font-size:8pt;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7pt}
table{width:100%;border-collapse:collapse}
td{padding:3pt 0 4pt 0;vertical-align:top}
td:last-child{text-align:right;white-space:nowrap}
.balance-check{margin-top:18pt;font-size:8pt;padding:6pt 8pt;border:1pt solid #000}
.footnote{margin-top:22pt;font-size:7.5pt;color:#555}
@media print{html{background:none}body{max-width:none;margin:0;padding:0;box-shadow:none}a{color:#000}}
</style></head>
<body>
<div class="header">
  ${logoHtml}
  <p>${company}</p>
  <h1>Bilanz zum 31. Dezember ${year}</h1>
  <p class="subheader">Kleinstkapitalgesellschaft · § 267a HGB · Aufgestellt gemäß §§ 242, 266 HGB</p>
</div>
<div class="two-col">
  <div>
    <div class="col-header">Aktiva</div>
    <table><tbody>
      ${row("A. Anlagevermögen", eur(0))}
      ${row("B. Umlaufvermögen", "")}
      ${row("III. Kassenbestand, Guthaben bei Kreditinstituten", eur(b.kassenbestand), 2, true)}
      ${ausstehendeRow}
      ${totalRow("Bilanzsumme Aktiva", eur(b.summeAktiva))}
    </tbody></table>
  </div>
  <div>
    <div class="col-header">Passiva</div>
    <table><tbody>
      ${row("A. Eigenkapital", "")}
      ${row("I. Gezeichnetes Kapital", eur(b.stammkapital), 1)}
      ${nichtEingRow}
      ${row("III. Jahresergebnis", neg(b.jahresergebnis), 1)}
      ${gwRow}
      <tr><td></td><td style="text-align:right;border-top:.5pt solid #999;padding-top:4pt">${neg(b.summeEigenkapital)}</td></tr>
      ${stRow}
      ${totalRow("Bilanzsumme Passiva", eur(b.summePassiva))}
    </tbody></table>
  </div>
</div>
<div class="balance-check">
  Bilanzsumme Aktiva: <strong>${eur(b.summeAktiva)}</strong> &nbsp;| 
  Bilanzsumme Passiva: <strong>${eur(b.summePassiva)}</strong> &nbsp;| 
  ${b.ausgeglichen ? "✓ ausgeglichen" : `✗ Differenz: ${eur(Math.abs(b.differenz))}`}
</div>
<div style="margin-top:18pt;font-size:8.5pt;font-family:'Courier New',monospace">
  <div style="font-weight:bold;text-transform:uppercase;letter-spacing:.05em;border-bottom:1pt solid #000;padding-bottom:3pt;margin-bottom:8pt">
    Angaben unter der Bilanz (§ 267a Abs. 2 HGB)
  </div>
  <p style="margin-bottom:6pt">
    Als Kleinstkapitalgesellschaft werden folgende Angaben anstelle eines Anhangs gemacht:
  </p>
  <p style="margin-bottom:4pt">
    <strong>1. Haftungsverhältnisse (§§ 251, 268 Abs. 7 HGB):</strong><br/>
    Es bestehen keine Haftungsverhältnisse (Verbindlichkeiten aus Bürgschaften, Wechsel- und Scheckverbindlichkeiten, Gewährleistungsverträge, Bestellobligo), die nicht in der Bilanz erscheinen.
  </p>
  <p style="margin-bottom:4pt">
    <strong>2. Vorschüsse und Kredite an Organmitglieder (§ 285 Nr. 9 Buchst. c HGB):</strong><br/>
    Es wurden keine Vorschüsse oder Kredite an Mitglieder des Geschäftsführungsorgans, eines Aufsichtsrats, eines Beirats oder einer ähnlichen Einrichtung gewährt; es bestehen diesbezüglich keine Haftungsverhältnisse.
  </p>
</div>
<div class="footnote">
  Erstellt mit <strong style="color:#000">finamt</strong> · ${new Date().toLocaleDateString("de-DE")} ·
  Einreichung beim Bundesanzeiger gemäß § 325 Abs. 1 HGB i.V.m. § 326 Abs. 2 HGB.
  Als Kleinstkapitalgesellschaft sind GuV und Anhang von der Offenlegungspflicht befreit.
</div>
<div style="margin-top:12pt;text-align:right;font-size:7.5pt;font-family:'Courier New',monospace;color:#999">
  Seite 1 von 1
</div>
</body></html>`;

    setBilanzHtml(html);
    setBilanzPreviewOpen(true);
  }

  const fE = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  const negFmt = (n: number) => (n < 0 ? `−${fE(Math.abs(n))}` : fE(n));

  const ausstehend = r2(stammkapital - eingezahlt);
  const isGründungsjahr = year === gründungsjahr;

  return (
    <div className="bg-white border-2 border-amber-400 rounded">

      {/* Toggle header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">{t("dashboard.jab_title")}</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            Bilanz + GuV · <LawLink law="§§ 242–256a HGB" href="https://www.gesetze-im-internet.de/hgb/__242.html" /> · Kleinstkapitalgesellschaft (<LawLink law="§ 267a HGB" href="https://www.gesetze-im-internet.de/hgb/__267a.html" />)
          </p>
        </div>
        <IconChevronDown className={`w-4 h-4 text-black shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-amber-200 p-4 flex flex-col gap-5">

          {/* Period badge — shows the year derived from the sidebar */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_year")}</span>
            <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{year}</span>
            {period.mode === "all" && (
              <span className="text-[10px] text-black font-mono">← {t("dashboard.jab_year_hint_all")}</span>
            )}
          </div>

          {/* Settings — company facts (read-only, edit via taxpayer profile) */}
          <div className="flex flex-wrap items-end gap-3">
            {/* Read-only company facts */}
            <div className="flex flex-wrap gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_gründungsjahr")}</span>
                <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{gründungsjahr}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_stammkapital")}</span>
                <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{fE(stammkapital)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_eingezahlt")}</span>
                <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{fE(eingezahlt)}</span>
              </div>
            </div>
            {/* Nettomethode toggle */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_method")}</span>
              <div className="flex gap-2 items-center">
                {([true, false] as const).map((v) => (
                  <button key={String(v)}
                    onClick={() => setS((p) => ({ ...p, nettomethode: v }))}
                    className={`text-[10px] px-2 py-1 rounded border font-bold transition-colors ${
                      s.nettomethode === v
                        ? "bg-black text-amber-400 border-black"
                        : "bg-white text-black border-amber-300 hover:border-black"
                    }`}
                  >
                    {v ? t("dashboard.jab_netto") : t("dashboard.jab_brutto")}
                  </button>
                ))}
              </div>
            </div>
            {/* Edit link */}
            {onEditTaxpayer && (
              <button
                onClick={onEditTaxpayer}
                className="text-[10px] font-bold text-black underline underline-offset-2 hover:text-amber-700 transition-colors pb-0.5"
              >
                {t("sidebar.taxpayer_edit_btn")} →
              </button>
            )}
          </div>

          {/* Gründungsjahr / partially paid-in note */}
          {ausstehend > 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded p-3 text-[11px] font-mono text-black/70 leading-relaxed">
              <strong className="text-black">{t("dashboard.jab_gruendung_title")}</strong>{" "}
              {t("dashboard.jab_gruendung_note", {
                stammkapital: fE(stammkapital),
                eingezahlt:   fE(eingezahlt),
                ausstehend:   fE(ausstehend),
              })}
              {s.nettomethode && (
                <><br />{t("dashboard.jab_nettomethode_note")}</>
              )}
            </div>
          )}
          {!isGründungsjahr && jab.bilanz.gewinnvortrag !== 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] font-mono text-black/70">
              {t("dashboard.jab_vortrag_computed", {
                years: gründungsjahr === year - 1
                  ? `${gründungsjahr}`
                  : `${gründungsjahr}\u2013${year - 1}`,
                amount: negFmt(jab.bilanz.gewinnvortrag),
              })}
            </div>
          )}

          {/* GuV */}
          <div>
            <h4 className="text-xs font-black uppercase tracking-wider text-black mb-2">
              {t("dashboard.jab_guv_title")} · § 275 Abs. 2 HGB (Gesamtkostenverfahren)
            </h4>
            <table className="w-full text-xs font-mono border-collapse">
              <tbody>
                <tr className="border-b border-amber-100">
                  <td className="py-1 pl-2 text-black">{t("dashboard.jab_umsatzerlöse")}</td>
                  <td className="py-1 text-right">{fE(guv.umsatzerlöse)}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1 pl-2 text-black">{t("dashboard.jab_sonstige_erlöse")}</td>
                  <td className="py-1 text-right">{fE(guv.sonstigeBetriebserlöse)}</td>
                </tr>
                <tr className="border-b-2 border-amber-200">
                  <td className="py-1 pl-2 font-bold text-black">= {t("dashboard.jab_gesamtleistung")}</td>
                  <td className="py-1 text-right font-bold text-black">{fE(guv.gesamtleistung)}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1 pl-2 text-black">− {t("dashboard.jab_materialaufwand")}</td>
                  <td className="py-1 text-right text-black">{fE(guv.materialaufwand)}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1 pl-2 text-black">− {t("dashboard.jab_sonstige_aufwendungen")}</td>
                  <td className="py-1 text-right text-black">{fE(guv.sonstigeBetriebsausgaben)}</td>
                </tr>
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 pl-2 font-black text-black">= {t("dashboard.jab_jahresergebnis")}</td>
                  <td className="py-2 text-right font-black text-black">
                    {negFmt(guv.jahresergebnis)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Bilanz — two-column */}
          <div>
            <h4 className="text-xs font-black uppercase tracking-wider text-black mb-3">
              {t("dashboard.jab_bilanz_title")} · § 266 HGB
            </h4>
            <div className="grid grid-cols-2 gap-6">

              {/* AKTIVA */}
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-black mb-1.5">
                  {t("dashboard.jab_aktiva")}
                </p>
                <table className="w-full text-xs font-mono border-collapse">
                  <tbody>
                    <tr className="border-b border-amber-100">
                      <td className="py-1 text-black/70">A. {t("dashboard.jab_anlagevermögen")}</td>
                      <td className="py-1 text-right">0,00 €</td>
                    </tr>
                    <tr className="border-b border-amber-100">
                      <td className="py-1 text-black/70">B. {t("dashboard.jab_umlaufvermögen")}</td>
                      <td />
                    </tr>
                    <tr className="border-b border-amber-100">
                      <td className="py-1 pl-4 text-black/70">III. {t("dashboard.jab_kassenbestand")}</td>
                      <td className="py-1 text-right font-bold">{fE(bilanz.kassenbestand)}</td>
                    </tr>
                    {!s.nettomethode && bilanz.ausstehendeEinlagenAktiva > 0 && (
                      <tr className="border-b border-amber-100">
                        <td className="py-1 text-black/70">C. {t("dashboard.jab_ausstehende_aktiva")}</td>
                        <td className="py-1 text-right font-bold">{fE(bilanz.ausstehendeEinlagenAktiva)}</td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-amber-300">
                      <td className="py-1.5 font-black text-black">{t("dashboard.jab_summe_aktiva")}</td>
                      <td className="py-1.5 text-right font-black text-black">{fE(bilanz.summeAktiva)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* PASSIVA */}
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-black mb-1.5">
                  {t("dashboard.jab_passiva")}
                </p>
                <table className="w-full text-xs font-mono border-collapse">
                  <tbody>
                    <tr className="border-b border-amber-100">
                      <td className="py-1 text-black/70">A. {t("dashboard.jab_eigenkapital")}</td>
                      <td />
                    </tr>
                    <tr className="border-b border-amber-100">
                      <td className="py-1 pl-3 text-black/70">I. {t("dashboard.jab_gezeichnetes_kapital")}</td>
                      <td className="py-1 text-right">{fE(bilanz.stammkapital)}</td>
                    </tr>
                    {s.nettomethode && bilanz.nichtEingefordert > 0 && (
                      <tr className="border-b border-amber-100">
                        <td className="py-1 pl-3 text-black/70 italic">./. {t("dashboard.jab_nicht_eingefordert")}</td>
                        <td className="py-1 text-right text-black">−{fE(bilanz.nichtEingefordert)}</td>
                      </tr>
                    )}
                    <tr className="border-b border-amber-100">
                      <td className="py-1 pl-3 text-black/70">III. {t("dashboard.jab_jahresergebnis_passiva")}</td>
                      <td className="py-1 text-right">
                        {negFmt(bilanz.jahresergebnis)}
                      </td>
                    </tr>
                    {bilanz.gewinnvortrag !== 0 && (
                      <tr className="border-b border-amber-100">
                        <td className="py-1 pl-3 text-black/70">IV. {t("dashboard.jab_gewinnvortrag")}</td>
                        <td className="py-1 text-right">
                          {negFmt(bilanz.gewinnvortrag)}
                        </td>
                      </tr>
                    )}
                    {bilanz.steuerpositionen !== 0 && (
                      <tr className="border-b border-amber-100">
                        <td className="py-1 text-black/70">
                          B. {t("dashboard.jab_steuerpositionen")}
                        </td>
                        <td className="py-1 text-right">
                          {negFmt(bilanz.steuerpositionen)}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-amber-300">
                      <td className="py-1.5 font-black text-black">{t("dashboard.jab_summe_passiva")}</td>
                      <td className="py-1.5 text-right font-black text-black">{fE(bilanz.summePassiva)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Balance check */}
            <div className={`mt-3 px-3 py-2 rounded text-[11px] font-mono font-bold border ${
              bilanz.ausgeglichen
                ? "bg-green-50 border-green-300 text-green-800"
                : "bg-red-50 border-red-300 text-red-800"
            }`}>
              {bilanz.ausgeglichen
                ? <span className="flex items-center gap-1"><IconCheck className="w-3.5 h-3.5 shrink-0" />{t("dashboard.jab_balanced")}</span>
                : <span className="flex items-center gap-1"><IconClose className="w-3.5 h-3.5 shrink-0" />{t("dashboard.jab_unbalanced", { diff: fE(Math.abs(bilanz.differenz)) })}</span>}
            </div>

            <p className="text-[10px] text-black font-mono mt-3 leading-relaxed flex items-start gap-1">
              <IconInfo className="w-3 h-3 shrink-0 mt-px" /> {t("dashboard.jab_disclaimer")}
            </p>
          </div>

          {/* ── Filing Obligations ────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <h4 className="text-xs font-black uppercase tracking-wider text-black">
              {t("dashboard.jab_filing_section")}
            </h4>
            <p className="text-[10px] font-mono text-black/70">{t("dashboard.jab_filing_note")}</p>

            {/* E-Bilanz */}
            <div className="bg-amber-50 border border-amber-400 rounded p-3 flex flex-col gap-3">

              {/* ── Header ─────────────────────────────────────────── */}
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-xs font-black text-black">1 · {t("dashboard.jab_ebilanz_title")}</span>
                <span className="text-[10px] font-mono text-black/60">
                  <LawLink law="§ 5b EStG" href="https://www.gesetze-im-internet.de/estg/__5b.html" />
                </span>
              </div>
              <p className="text-[10px] font-mono text-black/60 italic">{t("dashboard.jab_ebilanz_law")}</p>

              {/* ── Configuration block ─────────────────────────── */}
              <div className="flex flex-col gap-2 bg-white border border-amber-200 rounded p-2.5">

                {/* Steuernummer */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[9px] font-mono text-black/50 shrink-0 w-28">{t("dashboard.jab_ebilanz_steuernummer")}</span>
                  <span className="text-[10px] font-mono font-bold text-black">
                    {taxpayer?.tax_number || <span className="text-black/30 italic">–</span>}
                  </span>
                  {onEditTaxpayer && (
                    <button
                      onClick={onEditTaxpayer}
                      className="text-[9px] font-black px-1.5 py-0.5 rounded border border-black/30 hover:border-black hover:bg-amber-100 transition-colors"
                    >
                      <span className="flex items-center gap-0.5">
                        <Icon icon="mdi:pencil-outline" className="w-3 h-3" />
                        {t("dashboard.jab_ebilanz_edit_taxpayer")}
                      </span>
                    </button>
                  )}
                </div>

                {/* ERiC path */}
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <label className="text-[9px] font-mono text-black/50 w-28 shrink-0">{t("dashboard.jab_ebilanz_eric_home")}</label>
                    {ericHomeSaved && (
                      <>
                        <span className="text-[8px] font-mono text-green-700 flex items-center gap-0.5">
                          <Icon icon="mdi:check-circle" className="w-2.5 h-2.5" />
                          {t("dashboard.jab_ebilanz_eric_saved")}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setEricHomeSaved(false); setTimeout(() => ericHomeInputRef.current?.focus(), 0); }}
                          className="text-[8px] font-mono text-black/40 underline underline-offset-2 hover:text-black transition-colors"
                        >
                          {t("dashboard.jab_ebilanz_eric_edit")}
                        </button>
                      </>
                    )}
                    <ElsterTip
                      lines={t("dashboard.jab_ebilanz_eric_why", { returnObjects: true }) as string[]}
                      link="https://www.elster.de/elsterweb/infoseite/entwickler"
                      linkLabel="www.elster.de → Softwareprodukte → ERiC"
                    />
                  </div>
                  {!ericHomeSaved && (
                    <input
                      ref={ericHomeInputRef}
                      type="text"
                      value={ericHome}
                      onChange={e => { setEricHome(e.target.value); setEricHomeSaved(false); }}
                      onBlur={e => saveEricHome(e.target.value)}
                      placeholder="/path/to/ERiC-.../lib"
                      className="min-w-0 text-[10px] font-mono border border-black/20 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-black placeholder:text-black/20"
                    />
                  )}
                  {ericHomeSaved && (
                    <span className="text-[9px] font-mono text-black/40 truncate">{ericHome}</span>
                  )}
                </div>

                {/* Hersteller-ID */}
                <div className="flex items-center gap-1">
                  <label className="text-[9px] font-mono text-black/50 w-28 shrink-0">{t("dashboard.jab_ebilanz_hersteller_id")}</label>
                  <input
                    type="text"
                    value={herstellerId}
                    onChange={e => { setHerstellerId(e.target.value); }}
                    onBlur={e => { const v = e.target.value.trim(); if (v) saveSetting("hersteller_id", v); }}
                    placeholder="z. B. 12345"
                    className="w-32 text-[10px] font-mono border border-black/20 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-black placeholder:text-black/20"
                  />
                  <ElsterTip
                    lines={t("dashboard.jab_ebilanz_hersteller_why", { returnObjects: true }) as string[]}
                    link="https://www.elster.de/elsterweb/registrierung-entwickler/form"
                    linkLabel="Registrierung als Softwarehersteller"
                  />
                </div>

                {/* Taxonomy */}
                <div className="flex items-center gap-1">
                  <label className="text-[9px] font-mono text-black/50 w-28 shrink-0">{t("dashboard.jab_ebilanz_taxonomy")}</label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowTaxDropdown(o => !o)}
                      className="flex items-center gap-1 text-[10px] font-mono border border-black/20 rounded px-1.5 py-0.5 bg-white hover:border-black transition-colors focus:outline-none"
                    >
                      <span className="flex-1 whitespace-nowrap">{{
                        "de-gaap-ci-2025-04-01": "Taxonomie 6.9 vom 01.04.2025",
                        "de-gaap-ci-2024-04-01": "Taxonomie 6.8 vom 01.04.2024",
                      }[taxonomy] ?? taxonomy}</span>
                      <IconChevronDown className={`w-3 h-3 shrink-0 transition-transform ${showTaxDropdown ? "rotate-180" : ""}`} />
                    </button>
                    {showTaxDropdown && (
                      <ul
                        className="absolute z-30 mt-1 left-0 bg-white border border-amber-300 rounded shadow-lg"
                        onMouseLeave={() => setShowTaxDropdown(false)}
                      >
                        {([
                          { value: "de-gaap-ci-2025-04-01", label: "Taxonomie 6.9 vom 01.04.2025" },
                          { value: "de-gaap-ci-2024-04-01", label: "Taxonomie 6.8 vom 01.04.2024" },
                        ] as { value: string; label: string }[]).map(opt => (
                          <li key={opt.value}>
                            <button
                              type="button"
                              onClick={() => { setTaxonomy(opt.value); setShowTaxDropdown(false); }}
                              className={`w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-amber-50 transition-colors whitespace-nowrap ${
                                opt.value === taxonomy ? "bg-amber-100 font-bold" : ""
                              }`}
                            >
                              {opt.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <ElsterTip
                    lines={[t("dashboard.jab_ebilanz_taxonomy_tip")]}
                    link="https://www.esteuer.de/#finanzantrag"
                    linkLabel="Mehr Informationen zu Taxonomien"
                  />
                </div>

                {/* Cert + PIN */}
                <div className="grid grid-cols-2 gap-x-3 items-center">

                  {/* Certificate .pfx */}
                  <div className="flex items-center gap-1 flex-wrap">
                    <label className="text-[9px] font-mono text-black/50 w-28 shrink-0">{t("dashboard.jab_ebilanz_cert_path")}</label>
                    <div className="flex items-center gap-1">
                      <input
                        ref={certFileRef}
                        type="file"
                        accept=".pfx,.p12"
                        className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0] ?? null;
                          setCertFile(f);
                          if (f) uploadCert(f);
                        }}
                      />
                      {certSaved && !certFile ? (
                        <>
                          <span className="text-[9px] font-mono text-green-700 flex items-center gap-0.5">
                            <Icon icon="mdi:check-circle" className="w-3 h-3" />
                            {t("dashboard.jab_ebilanz_cert_saved")}
                          </span>
                          <button
                            type="button"
                            onClick={() => certFileRef.current?.click()}
                            className="text-[9px] font-mono text-black/40 underline underline-offset-2 hover:text-black transition-colors"
                          >
                            {t("dashboard.jab_ebilanz_cert_replace")}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => certFileRef.current?.click()}
                            disabled={certUploading}
                            className="shrink-0 text-[10px] font-black px-2 py-0.5 rounded border border-black/30 hover:border-black hover:bg-amber-50 disabled:opacity-50 transition-colors"
                          >
                            <span className="flex items-center gap-1">
                              <Icon icon={certUploading ? "mdi:loading" : "mdi:paperclip"} className={`w-3 h-3${certUploading ? " animate-spin" : ""}`} />
                              {t("dashboard.jab_ebilanz_cert_choose")}
                            </span>
                          </button>
                          <span className="text-[9px] font-mono text-black/40 truncate">
                            {certFile?.name ?? "–"}
                          </span>
                        </>
                      )}
                    </div>
                    <ElsterTip lines={t("dashboard.jab_ebilanz_cert_why", { returnObjects: true }) as string[]} />
                  </div>

                  {/* PIN */}
                  <div className="flex items-center gap-1">
                    <label className="text-[9px] font-mono text-black/50 shrink-0">{t("dashboard.jab_ebilanz_cert_password")}</label>
                    <div className="flex items-center flex-1">
                      <input
                        type={showPin ? "text" : "password"}
                        value={certPassword}
                        onChange={e => { setCertPassword(e.target.value); setCertPinSaved(false); }}
                        onBlur={e => { const v = e.target.value; if (v) { setCertPinSaved(true); saveSetting("cert_pin", v); } }}
                        placeholder="PIN"
                        className="min-w-0 flex-1 text-[10px] font-mono border border-black/30 rounded-l px-1.5 py-0.5 bg-white focus:outline-none focus:border-black"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPin(v => !v)}
                        className="shrink-0 border border-l-0 border-black/30 rounded-r px-1.5 py-0.5 hover:bg-amber-50 transition-colors focus:outline-none"
                        tabIndex={-1}
                      >
                        <Icon icon={showPin ? "mdi:eye-off" : "mdi:eye"} className="w-3 h-3 text-black" />
                      </button>
                      {certPinSaved && (
                        <span className="ml-1 text-[8px] font-mono text-green-700 flex items-center gap-0.5">
                          <Icon icon="mdi:check-circle" className="w-2.5 h-2.5" />{t("dashboard.jab_ebilanz_eric_saved")}
                        </span>
                      )}
                    </div>
                  </div>

                </div>{/* /cert+PIN grid */}

              </div>{/* /config block */}

              {/* ── Schritt 1 ───────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <p className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.jab_ebilanz_step1_title")}
                </p>
                <p className="text-[10px] font-mono text-black/70 leading-relaxed">
                  {t("dashboard.jab_ebilanz_step1_desc")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={previewXbrl}
                    className="text-[10px] font-black px-3 py-1.5 rounded border-2 border-black bg-white text-black hover:bg-amber-400 transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon icon="mdi:eye-outline" className="w-3.5 h-3.5" />
                      {t("dashboard.jab_ebilanz_preview")}
                    </span>
                  </button>
                </div>
                {xbrlError && (
                  <p className="text-[10px] font-mono text-red-700 font-bold flex items-start gap-1"><IconClose className="w-3.5 h-3.5 shrink-0 mt-px" /> {xbrlError}</p>
                )}
              </div>

              {/* ── Schritt 2 ───────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <p className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.jab_ebilanz_step2_title")}
                </p>
                <p className="text-[10px] font-mono text-black/70 leading-relaxed">
                  {t("dashboard.jab_ebilanz_step2_desc")}
                </p>

                {/* Testmodus + action buttons */}
                <div className="flex items-center gap-3 flex-wrap mt-0.5">
                  <label
                    className="flex items-center gap-1 text-[10px] font-mono cursor-pointer select-none"
                    title={t("dashboard.jab_ebilanz_use_test_hint")}
                  >
                    <input type="checkbox" checked={useTest} onChange={e => setUseTest(e.target.checked)} className="accent-amber-500" />
                    {t("dashboard.jab_ebilanz_use_test")}
                  </label>
                  <button
                    onClick={() => callEricEndpoint(true)}
                    disabled={validating || submitting}
                    className="text-[10px] font-black px-3 py-1.5 rounded border-2 border-black bg-white text-black hover:bg-amber-400 disabled:opacity-50 transition-colors"
                  >
                    {validating
                      ? "…"
                      : <span className="flex items-center gap-1.5"><Icon icon="mdi:check-circle-outline" className="w-3.5 h-3.5" />{t("dashboard.jab_ebilanz_validate_btn")}</span>}
                  </button>
                  <button
                    onClick={() => callEricEndpoint(false)}
                    disabled={submitting || validating}
                    className="text-[10px] font-black px-3 py-1.5 rounded border-2 border-black bg-black text-white hover:text-amber-400 disabled:opacity-50 transition-colors"
                  >
                    {submitting
                      ? "…"
                      : <span className="flex items-center gap-1.5"><Icon icon="mdi:send" className="w-3.5 h-3.5" />{t("dashboard.jab_ebilanz_submit")}</span>}
                  </button>
                </div>

                {submitError && (
                  <p className="text-[10px] font-mono text-red-700 font-bold flex items-start gap-1"><IconClose className="w-3.5 h-3.5 shrink-0 mt-px" /> {submitError}</p>
                )}
                {validateMsg && (
                  <p className="text-[10px] font-mono text-green-700 font-bold">{validateMsg}</p>
                )}
                {transferticket && (
                  <p className="text-[10px] font-mono text-green-700 font-bold flex items-center gap-1">
                    <IconCheck className="w-3.5 h-3.5 shrink-0" /> {t("dashboard.jab_ebilanz_ticket")}: {transferticket}
                  </p>
                )}
              </div>

            </div>

            {/* Bundesanzeiger */}
            <div className="bg-amber-50 border border-amber-400 rounded p-3 flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-black text-black">2 · {t("dashboard.jab_bundesanzeiger_title")}</span>
                <span className="text-[10px] font-mono text-black/60">
                  <LawLink law="§ 325 HGB" href="https://www.gesetze-im-internet.de/hgb/__325.html" />
                  {" + "}
                  <LawLink law="§ 326 Abs. 2 HGB" href="https://www.gesetze-im-internet.de/hgb/__326.html" />
                </span>
              </div>
              <p className="text-[10px] font-mono text-black/60 italic">{t("dashboard.jab_bundesanzeiger_law")}</p>
              <ol className="list-decimal list-inside flex flex-col gap-1">
                <li className="text-[10px] font-mono text-black leading-relaxed">
                  Aufrufen:{" "}
                  <a href="https://publikations-plattform.de" target="_blank" rel="noopener noreferrer" className="underline underline-offset-1 hover:text-amber-800">publikations-plattform.de</a>
                  {" → Jahresabschluss im Unternehmensregister hinterlegen"}
                </li>
                <li className="text-[10px] font-mono text-black leading-relaxed">
                  {t("dashboard.jab_bundesanzeiger_step2")}
                </li>
              </ol>

              {/* Logo upload — optional, appears on the generated PDF */}
              <div className="flex items-center gap-2 py-1">
                <input
                  ref={logoFileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = ev => {
                      const dataUrl = ev.target?.result as string ?? null;
                      setLocalLogo(dataUrl);
                      if (dataUrl && taxpayer) {
                        const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
                        fetch(`${apiBase}/taxpayer${qs}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ ...taxpayer, logo: dataUrl }),
                        }).catch(() => {});
                      }
                    };
                    reader.readAsDataURL(file);
                  }}
                />
                {(localLogo ?? taxpayer?.logo) ? (
                  <>
                    <img
                      src={localLogo ?? taxpayer?.logo ?? ""}
                      alt="Logo"
                      className="h-8 max-w-[72px] object-contain border border-black/10 rounded p-0.5 bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => logoFileRef.current?.click()}
                      className="text-[10px] font-mono text-black/40 underline underline-offset-2 hover:text-black transition-colors"
                    >
                      {t("sidebar.taxpayer_logo_change")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => logoFileRef.current?.click()}
                    className="text-[10px] font-black px-2 py-1 rounded border border-black/20 hover:border-black hover:bg-amber-50 transition-colors flex items-center gap-1.5"
                  >
                    <Icon icon="mdi:image-plus" className="w-3 h-3" />
                    {t("sidebar.taxpayer_logo_upload")} <span className="font-normal text-black/40">({t("dashboard.jab_optional")})</span>
                  </button>
                )}
              </div>

              {/* PDF + XBRL buttons — sits after logo prompt */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={generateBilanzPdf}
                    className="text-[10px] font-black px-3 py-1.5 rounded border-2 border-black bg-black text-white hover:text-amber-400 transition-colors"
                  >
                    <span className="flex items-center gap-1.5"><Icon icon="fa7-solid:file-pdf" className="w-3.5 h-3.5" />{t("dashboard.jab_bundesanzeiger_pdf")}</span>
                  </button>
                  <button
                    onClick={downloadXbrlFile}
                    className="text-[10px] font-black px-3 py-1.5 rounded border-2 border-black bg-white text-black hover:bg-amber-400 transition-colors"
                    title="Bevorzugtes Anlieferungsformat laut Bundesanzeiger"
                  >
                    <span className="flex items-center gap-1.5"><Icon icon="mdi:xml" className="w-3.5 h-3.5" />XBRL/XML herunterladen</span>
                  </button>
                </div>
                <p className="text-[10px] font-mono text-amber-700 font-bold">↑ XBRL/XML ist das bevorzugte Anlieferungsformat (Format a) auf der Publikations-Plattform</p>
              </div>

              <ol className="list-decimal list-inside flex flex-col gap-1" start={3}>
                <li className="text-[10px] font-mono text-black leading-relaxed font-bold">
                  {t("dashboard.jab_bundesanzeiger_step5", { year, deadline: year + 1 })}
                </li>
              </ol>
              <a
                href="https://www.bundesanzeiger.de"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-bold text-black underline underline-offset-2 hover:text-amber-800 self-start"
              >
                → www.bundesanzeiger.de
              </a>

              {/* Submission tracking */}
              <div className="flex flex-col gap-1.5 pt-2 border-t border-amber-200">
                <div className="flex items-center gap-2 flex-wrap">
                  {submissions.filter(s => s.type === "bundesanzeiger" && s.year === year).length === 0 ? (
                    <button
                      type="button"
                      onClick={markAsSubmitted}
                      disabled={markSubmitting}
                      className="text-[10px] font-black px-2.5 py-1 rounded border-2 border-green-700 text-green-800 hover:bg-green-50 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                    >
                      <Icon icon={markSubmitting ? "mdi:loading" : "mdi:check-circle-outline"} className={`w-3 h-3 ${markSubmitting ? "animate-spin" : ""}`} />
                      {t("dashboard.jab_mark_submitted")}
                    </button>
                  ) : (
                    submissions
                      .filter(s => s.type === "bundesanzeiger" && s.year === year)
                      .slice(-1)
                      .map((s, i) => (
                        <span key={i} className="text-[9px] font-mono flex items-center gap-1 text-green-700">
                          <Icon icon="mdi:check-circle" className="w-3 h-3" />
                          {t("dashboard.jab_submitted_on", { date: new Date(s.submitted_at).toLocaleDateString("de-DE") })}
                          <button
                            type="button"
                            onClick={markAsSubmitted}
                            disabled={markSubmitting}
                            className="ml-1 text-black/30 underline underline-offset-2 hover:text-black transition-colors text-[8px] disabled:opacity-50"
                          >
                            {t("dashboard.jab_mark_submitted_again")}
                          </button>
                        </span>
                      ))
                  )}
                </div>
                {submissions.filter(s => s.type === "bundesanzeiger" && s.year === year).length > 1 && (
                  <details className="text-[8px] font-mono text-black/40">
                    <summary className="cursor-pointer hover:text-black/60">{t("dashboard.jab_submission_history")}</summary>
                    <ul className="mt-1 flex flex-col gap-0.5 pl-2">
                      {submissions
                        .filter(s => s.type === "bundesanzeiger" && s.year === year)
                        .map((s, i) => (
                          <li key={i}>{new Date(s.submitted_at).toLocaleString("de-DE")}</li>
                        ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          </div>

        </div>
      )}

      {/* ── Bilanz Preview Modal ─────────────────────────────────────── */}
      {bilanzPreviewOpen && bilanzHtml && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setBilanzPreviewOpen(false)}
        >
          <div
            className="relative bg-white border-2 border-black rounded flex flex-col"
            style={{ width: "calc(210mm + 4px)", height: "88vh", maxWidth: "98vw" }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b-2 border-black bg-amber-50 shrink-0">
              <span className="text-xs font-black uppercase tracking-wider">
                Bilanz · {year} · {taxpayer?.name ?? "–"}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={downloadBilanzPdf}
                  disabled={pdfGenerating}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black bg-black text-white hover:text-amber-400 disabled:opacity-50 transition-colors"
                >
                  <span className="flex items-center gap-1">
                    {pdfGenerating
                      ? <Icon icon="mdi:loading" className="w-3.5 h-3.5 animate-spin" />
                      : <IconFilePdf className="w-3.5 h-3.5" />}
                    <span>{pdfGenerating ? t("dashboard.jab_bilanz_generating") : t("dashboard.jab_bilanz_save")}</span>
                  </span>
                </button>
                <button
                  onClick={() => setBilanzPreviewOpen(false)}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-black hover:text-white transition-colors"
                >
                  ✕
                </button>
              </div>
            </div>
            {/* A4 iframe body */}
            <iframe
              ref={bilanzIframeRef}
              srcDoc={bilanzHtml}
              title={`Bilanz ${year}`}
              className="flex-1 w-full border-0"
              style={{ background: "#fef3c7" }}
            />
          </div>
        </div>
      )}

      {/* ── XBRL Preview Modal ──────────────────────────────────────── */}
      {xbrlPreviewOpen && xbrlXml && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        >
          <div
            className="relative bg-white border-2 border-black rounded w-[90vw] max-w-4xl h-[80vh] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b-2 border-black bg-amber-50">
              <span className="text-xs font-black uppercase tracking-wider">
                {t("dashboard.jab_xbrl_modal_title", { year })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(xbrlXml).then(() => {
                      setXbrlCopied(true);
                      setTimeout(() => setXbrlCopied(false), 2000);
                    });
                  }}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors flex items-center gap-1"
                >
                  <Icon icon={xbrlCopied ? "mdi:check" : "mdi:content-copy"} className="w-3 h-3" />
                  {xbrlCopied ? t("dashboard.jab_xbrl_copied") : t("dashboard.jab_xbrl_copy")}
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([xbrlXml], { type: "application/xml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `elster_envelope_${year}.xml`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors flex items-center gap-1"
                >
                  <Icon icon="mdi:download" className="w-3 h-3" />
                  {t("dashboard.jab_xbrl_download")}
                </button>
                <button
                  onClick={() => setXbrlPreviewOpen(false)}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-black hover:text-white transition-colors"
                >
                  {t("dashboard.jab_xbrl_close")}
                </button>
              </div>
            </div>
            {/* Body */}
            <pre className="flex-1 overflow-auto p-4 text-[10px] font-mono text-black leading-relaxed whitespace-pre select-all">
              {xbrlXml}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
