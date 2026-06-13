import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { Icon } from "@iconify/react";
import { CATEGORY_META, CASHFLOW_ONLY_CATS, CATEGORY_SUBCATEGORIES } from "../constants";
import type { CategoryMeta } from "../constants";
import { IconChevronDown, IconDelete, IconSpinner, IconCheck, IconEye, IconEyeOff } from "../constants/icons";
import { bundeslandKzFromState, finanzamtNrFromSteuernummer, toFederal13, is13Digit } from "../utils/steuernummer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Address = {
  street_and_number:  string | null;
  address_supplement: string | null;
  postcode:           string | null;
  city:               string | null;
  state:              string | null;
  country:            string | null;
};

export type Counterparty = {
  id:         string;
  name:       string | null;
  address:    Address | null;
  tax_number: string | null;
  vat_id:     string | null;
};

export type TaxpayerProfile = {
  name:               string;
  vat_id:             string;
  tax_number:         string;
  street:             string;
  address_supplement: string;
  postcode:           string;
  city:               string;
  state:              string;
  country:            string;
  // GmbH company facts — optional, persisted in DB
  gründungsjahr?: number | null;
  stammkapital?:  number | null;
  eingezahlt?:    number | null;
  hebesatz?:      number | null; // Gewerbesteuer Hebesatz (%)
  gegenstand?:    string | null;  // Gegenstand des Unternehmens (GewSt 1A Zeile 4)
  rechtsform?:    string | null;  // Rechtsform (GewSt 1A Zeile 14)
  // Betriebsstätte flags — GewSt 1A Zeilen 26/27/28
  betriebsstaette_mehrere?:  boolean | null; // Z. 26 — Betriebsstätten in mehreren Gemeinden
  betriebsstaette_erstreckt?: boolean | null; // Z. 27 — erstreckt sich über mehrere Gemeinden
  betriebsstaette_verlegt?:  boolean | null; // Z. 28 — einzige Betriebsstätte verlegt
  // Company logo — stored as base64 data URL
  logo?: string | null;
  // Returns tracking
  ustva_frequency?: "monthly" | "quarterly" | null;
  starting_year?:   number | null;
};

/** ELSTER / ERiC credentials shared across all tax return panels. */
export type ElsterSettings = {
  hersteller_id: string;
  cert_pin:      string;
  cert_saved:    boolean;
  elster_id:     string;
  eric_home:     string;
};

export const EMPTY_ELSTER: ElsterSettings = {
  hersteller_id: "",
  cert_pin:      "",
  cert_saved:    false,
  elster_id:     "",
  eric_home:     "",
};

export type ReceiptItem = {
  position:    number | null;
  description: string;
  quantity:    number | null;
  unit_price:  number | null;
  total_price: number | null;
  vat_rate:    number | null;
  vat_amount:  number | null;
  category:    string;
};

export { CATEGORY_META, CASHFLOW_ONLY_CATS } from "../constants";
export type { CategoryMeta } from "../constants";

export type Receipt = {
  id:             string;
  receipt_type:   "purchase" | "sale";
  vendor:         string | null;
  counterparty:   Counterparty | null;
  receipt_number: string | null;
  receipt_date:   string | null;
  total_amount:      number | null;
  vat_percentage:    number | null;
  vat_amount:        number | null;
  net_amount:        number | null;
  private_use_share: number;          // 0–1; default 0
  business_net:      number | null;
  business_vat:      number | null;
  einfuhr_vat:       number | null;   // Einfuhrumsatzsteuer § 15 Abs. 1 Nr. 2 UStG
  currency:          string;
  category:       string;
  subcategory:    string | null;
  items:          ReceiptItem[];
  pdf_url:        string | null;
  duplicate?:     boolean;
  message?:       string;
  validation_warnings?: string[];
  description:    string | null;
  created_at:     string | null;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function fmt(amount: number | null | undefined, currency = "EUR"): string {
  if (amount == null) return "—";
  const locale = i18n.language === "en" ? "en-US" : "de-DE";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

export function displayName(r: Receipt): string {
  return r.vendor ?? r.counterparty?.name ?? r.id.slice(0, 8);
}


export function formatAddress(addr: Address | null | undefined): string | null {
  if (!addr) return null;
  return [addr.street_and_number, addr.address_supplement, addr.postcode && addr.city ? `${addr.postcode} ${addr.city}` : addr.postcode || addr.city, addr.state, addr.country].filter(Boolean).join(", ") || null;
}

// ---------------------------------------------------------------------------
// Period filter
// ---------------------------------------------------------------------------

export type PeriodMode = "all" | "year" | "quarter" | "month";

export type PeriodFilter = {
  mode:    PeriodMode;
  year:    number;
  quarter: number;  // 1–4
  month:   number;  // 1–12
};

export const DEFAULT_PERIOD: PeriodFilter = {
  mode:    "all",
  year:    new Date().getFullYear(),
  quarter: Math.ceil((new Date().getMonth() + 1) / 3),
  month:   new Date().getMonth() + 1,
};

export function filterByPeriod(receipts: Receipt[], period: PeriodFilter): Receipt[] {
  if (period.mode === "all") return receipts;
  return receipts.filter((r) => {
    if (!r.receipt_date) return false;
    const d = new Date(r.receipt_date);
    if (isNaN(d.getTime())) return false;
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const q = Math.ceil(m / 3);
    if (period.mode === "year")    return y === period.year;
    if (period.mode === "quarter") return y === period.year && q === period.quarter;
    if (period.mode === "month")   return y === period.year && m === period.month;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Recent-upload filter
// ---------------------------------------------------------------------------

export type RecentWindow = "1h" | "8h" | "today" | "3d";

function getRecentCutoff(w: RecentWindow): number {
  if (w === "today") return new Date().setHours(0, 0, 0, 0);
  const msMap: Record<string, number> = { "1h": 3_600_000, "8h": 28_800_000, "3d": 259_200_000 };
  return Date.now() - msMap[w];
}

function matchesRecent(r: Receipt, w: RecentWindow): boolean {
  if (!r.created_at) return false;
  const ts = new Date(r.created_at).getTime();
  return !isNaN(ts) && ts >= getRecentCutoff(w);
}

// ---------------------------------------------------------------------------
// Taxpayer data modal
// ---------------------------------------------------------------------------

export function TaxpayerModal({ initial, onSave, onClear, onClose, apiBase = "", dbPath }: {
  initial:   TaxpayerProfile | null;
  onSave:    (tp: TaxpayerProfile) => void;
  onClear:   () => void;
  onClose:   () => void;
  apiBase?:  string;
  dbPath?:   string | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<TaxpayerProfile>({
    name:               initial?.name               ?? "",
    vat_id:             initial?.vat_id             ?? "",
    tax_number:         initial?.tax_number         ?? "",
    street:             initial?.street             ?? "",
    address_supplement: initial?.address_supplement ?? "",
    postcode:           initial?.postcode           ?? "",
    city:               initial?.city               ?? "",
    state:              initial?.state              ?? "",
    country:            initial?.country            ?? "",
    gegenstand:         initial?.gegenstand         ?? "",
    rechtsform:         initial?.rechtsform         ?? "",
    betriebsstaette_mehrere:   initial?.betriebsstaette_mehrere   ?? false,
    betriebsstaette_erstreckt: initial?.betriebsstaette_erstreckt ?? false,
    betriebsstaette_verlegt:   initial?.betriebsstaette_verlegt   ?? false,
    ustva_frequency: initial?.ustva_frequency ?? null,
  });
  // String inputs for numeric fields (empty string ⇒ null)
  const [numForm, setNumForm] = useState({
    gründungsjahr: initial?.gründungsjahr != null ? String(initial.gründungsjahr) : "",
    stammkapital:  initial?.stammkapital  != null ? String(initial.stammkapital)  : "",
    eingezahlt:    initial?.eingezahlt    != null ? String(initial.eingezahlt)    : "",
    hebesatz:      initial?.hebesatz      != null ? String(initial.hebesatz)      : "",
    starting_year: initial?.starting_year != null ? String(initial.starting_year) : "",
  });
  const [companyOpen, setCompanyOpen] = useState(false);
  const [elsterOpen, setElsterOpen]   = useState(false);
  const [logo, setLogo] = useState<string | null>(initial?.logo ?? null);

  // ELSTER settings — loaded from API, saved independently of the taxpayer profile
  const [herstellerId,   setHerstellerId]   = useState("");
  const [certSaved,      setCertSaved]      = useState(false);
  const [certUploading,  setCertUploading]  = useState(false);
  const [certPassword,   setCertPassword]   = useState("");
  const [certPinSaved,   setCertPinSaved]   = useState(false);
  const [showPin,        setShowPin]        = useState(false);
  const certFileRef = useRef<HTMLInputElement>(null);

  // Computed ELSTER fields — derived from form.tax_number + form.state
  const derivedKz  = bundeslandKzFromState(form.state);
  const derivedFa  = finanzamtNrFromSteuernummer(form.tax_number, form.state);

  // Load ELSTER settings on mount / project change
  useEffect(() => {
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
      .then(d => { if (d?.stored) setCertSaved(true); })
      .catch(() => {});
  }, [apiBase, dbPath]);

  async function saveElsterSetting(key: string, value: string) {
    if (!apiBase) return;
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    await fetch(`${apiBase}/tax/ebilanz/settings${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {});
  }

  async function uploadCertFile(file: File) {
    if (!apiBase) return;
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
    } catch { /* ignore */ } finally { setCertUploading(false); }
  }
  const logoInputRef = useRef<HTMLInputElement>(null);

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setLogo(ev.target?.result as string ?? null);
    reader.readAsDataURL(file);
  }

  const set = (key: keyof TaxpayerProfile) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setNum = (key: keyof typeof numForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setNumForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = () => {
    const parse = (s: string): number | null => {
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };
    onSave({
      ...form,
      gründungsjahr:   parse(numForm.gründungsjahr),
      stammkapital:    parse(numForm.stammkapital),
      eingezahlt:      parse(numForm.eingezahlt),
      hebesatz:        parse(numForm.hebesatz),
      starting_year:   parse(numForm.starting_year),
      gegenstand:      form.gegenstand || null,
      rechtsform:      form.rechtsform || null,
      betriebsstaette_mehrere:   form.betriebsstaette_mehrere   ?? false,
      betriebsstaette_erstreckt: form.betriebsstaette_erstreckt ?? false,
      betriebsstaette_verlegt:   form.betriebsstaette_verlegt   ?? false,
      ustva_frequency: form.ustva_frequency ?? null,
      logo: logo ?? null,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white border-2 border-black shadow-[4px_4px_0_#000] rounded p-5 w-80 flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="text-black text-sm font-black uppercase tracking-wider">
          {t("sidebar.taxpayer_modal_title")}
        </h4>

        {/* Name, VAT ID, Tax Number */}
        {(["name", "vat_id", "tax_number"] as (keyof TaxpayerProfile)[]).map((key) => (
          <div key={key} className="flex flex-col gap-1">
            <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
              {t(`sidebar.taxpayer_${key}`)}
            </label>
            <input
              type="text"
              value={form[key] as string}
              onChange={set(key)}
              className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
              placeholder={t(`sidebar.taxpayer_${key}`)}
            />
          </div>
        ))}

        {/* Address section */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-black/5">
          <span className="text-[10px] text-black/40 font-bold uppercase tracking-wider">
            {t("sidebar.taxpayer_address")}
          </span>
          <input
            type="text"
            value={form.street}
            onChange={set("street")}
            className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
            placeholder={t("sidebar.taxpayer_street")}
          />
          <input
            type="text"
            value={form.address_supplement}
            onChange={set("address_supplement")}
            className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
            placeholder={t("sidebar.taxpayer_address_supplement")}
          />
          <div className="flex gap-1.5">
            <input
              type="text"
              value={form.postcode}
              onChange={set("postcode")}
              className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 w-24"
              placeholder={t("sidebar.taxpayer_postcode")}
            />
            <input
              type="text"
              value={form.city}
              onChange={set("city")}
              className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 flex-1"
              placeholder={t("sidebar.taxpayer_city")}
            />
          </div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={form.state}
              onChange={set("state")}
              className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 flex-1 min-w-0"
              placeholder={t("sidebar.taxpayer_state")}
            />
            <input
              type="text"
              value={form.country}
              onChange={set("country")}
              className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 flex-1 min-w-0"
              placeholder={t("sidebar.taxpayer_country")}
            />
          </div>
        </div>

        {/* GmbH / Company facts — collapsible */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-black/5">
          <button
            type="button"
            onClick={() => setCompanyOpen((o) => !o)}
            className="flex items-center justify-between w-full text-left group"
          >
            <span className="text-[10px] text-black/40 font-bold uppercase tracking-wider group-hover:text-black/60 transition-colors">
              {t("sidebar.taxpayer_company_section")}
            </span>
            <IconChevronDown
              className={`text-black/30 transition-transform ${companyOpen ? "rotate-180" : ""}`}
              style={{ width: 14, height: 14 }}
            />
          </button>
          {companyOpen && <>
            {/* Company logo */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_logo")}
              </label>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleLogoChange}
              />
              {logo ? (
                <div className="flex items-center gap-2">
                  <img src={logo} alt="Logo" className="h-10 max-w-[80px] object-contain border border-black/10 rounded p-0.5 bg-white" />
                  <button type="button" onClick={() => logoInputRef.current?.click()} className="text-[10px] font-mono text-black/40 underline underline-offset-2 hover:text-black transition-colors">
                    {t("sidebar.taxpayer_logo_change")}
                  </button>
                  <button type="button" onClick={() => setLogo(null)} className="text-[10px] font-mono text-red-400 underline underline-offset-2 hover:text-red-600 transition-colors">
                    {t("sidebar.taxpayer_logo_remove")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className="text-xs font-black px-2 py-1 rounded border border-black/20 hover:border-black hover:bg-amber-50 transition-colors text-left flex items-center gap-1.5 w-fit"
                >
                  <Icon icon="mdi:image-plus" className="w-3.5 h-3.5" />
                  {t("sidebar.taxpayer_logo_upload")}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_gegenstand")}
              </label>
              <input
                type="text"
                value={form.gegenstand ?? ""}
                onChange={set("gegenstand")}
                className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                placeholder={t("sidebar.taxpayer_gegenstand")}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_rechtsform")}
              </label>
              <input
                type="text"
                value={form.rechtsform ?? ""}
                onChange={set("rechtsform")}
                className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                placeholder="GmbH"
              />
            </div>
            {/* Betriebsstätte flags Z.26/27/28 */}
            <div className="flex flex-col gap-1.5 pt-1 border-t border-black/5">
              <span className="text-[10px] text-black/40 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_betriebsstaette_section")}
              </span>
              {(
                [
                  ["betriebsstaette_mehrere",   "sidebar.taxpayer_bs_mehrere"],
                  ["betriebsstaette_erstreckt", "sidebar.taxpayer_bs_erstreckt"],
                  ["betriebsstaette_verlegt",   "sidebar.taxpayer_bs_verlegt"],
                ] as [keyof TaxpayerProfile, string][]
              ).map(([key, labelKey]) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider flex-1 leading-tight">
                    {t(labelKey)}
                  </label>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, [key]: !prev[key] }))}
                    className={`text-xs font-black px-3 py-0.5 rounded border-2 transition-colors shrink-0 ${
                      form[key]
                        ? "bg-amber-400 border-amber-500 text-black"
                        : "bg-white border-black/20 text-black/50"
                    }`}
                  >
                    {form[key] ? "Ja" : "Nein"}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_gruendungsjahr")}
              </label>
              <input
                type="number"
                value={numForm.gründungsjahr}
                onChange={setNum("gründungsjahr")}
                className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                placeholder={String(new Date().getFullYear())}
                min={1900}
                max={2100}
              />
            </div>

            {/* Returns tracking */}
            <div className="flex flex-col gap-2 pt-1 border-t border-black/5">
              <span className="text-[10px] text-black/40 font-bold uppercase tracking-wider">Steuererklärungen</span>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                  Erstes Jahr (falls kein Gründungsjahr)
                </label>
                <input
                  type="number"
                  value={numForm.starting_year}
                  onChange={setNum("starting_year")}
                  className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                  placeholder="2022"
                  min={1990}
                  max={2100}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">UStVA-Rhythmus</label>
                <div className="flex gap-2">
                  {(["monthly", "quarterly"] as const).map(f => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setForm(prev => ({ ...prev, ustva_frequency: prev.ustva_frequency === f ? null : f }))}
                      className={`text-xs font-black px-3 py-0.5 rounded border-2 transition-colors ${
                        form.ustva_frequency === f
                          ? "bg-amber-400 border-amber-500 text-black"
                          : "bg-white border-black/20 text-black/50"
                      }`}
                    >
                      {f === "monthly" ? "Monatlich" : "Vierteljährlich"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_stammkapital_field")}
              </label>
              <input
                type="number"
                value={numForm.stammkapital}
                onChange={setNum("stammkapital")}
                className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                placeholder="25000"
                min={0}
                step={0.01}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_eingezahlt_field")}
              </label>
              <input
                type="number"
                value={numForm.eingezahlt}
                onChange={setNum("eingezahlt")}
                className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                placeholder="12500"
                min={0}
                step={0.01}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
                {t("sidebar.taxpayer_hebesatz_field")}
              </label>
              <input
                type="number"
                value={numForm.hebesatz}
                onChange={setNum("hebesatz")}
                className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                placeholder="400"
                min={200}
                max={900}
                step={50}
              />
            </div>
          </>}
        </div>

        {/* ELSTER-DATEN */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-black/5">
          <button
            type="button"
            onClick={() => setElsterOpen((o) => !o)}
            className="flex items-center justify-between w-full text-left group"
          >
            <span className="text-[10px] text-black/40 font-bold uppercase tracking-wider group-hover:text-black/60 transition-colors">
              ELSTER-DATEN
            </span>
            <IconChevronDown
              className={`text-black/30 transition-transform ${elsterOpen ? "rotate-180" : ""}`}
              style={{ width: 14, height: 14 }}
            />
          </button>

          {elsterOpen && (
            <div className="flex flex-col gap-1.5">

              {/* 13-stellige Steuernummer (computed, read-only) */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">13-stellige Steuernummer</label>
                {(() => {
                  if (!form.tax_number) return (
                    <p className="text-xs font-mono text-black/40 italic px-2 py-1 bg-amber-50 border border-amber-200 rounded">nicht gesetzt</p>
                  );
                  if (is13Digit(form.tax_number)) return (
                    <p className="text-xs font-mono text-black px-2 py-1 bg-amber-50 border border-amber-200 rounded">{form.tax_number}</p>
                  );
                  const f13 = toFederal13(form.tax_number, form.state);
                  if (f13) return (
                    <p className="text-xs font-mono text-black font-bold px-2 py-1 bg-amber-50 border border-amber-200 rounded">{f13}</p>
                  );
                  return (
                    <p className="text-xs font-mono text-black/40 italic px-2 py-1 bg-amber-50 border border-amber-200 rounded">Bundesland erforderlich</p>
                  );
                })()}
              </div>

              {/* Derived fields: Finanzamtsnr. + Länder-Kz. */}
              <div className="flex gap-2">
                <div className="flex flex-col gap-0.5 flex-1">
                  <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">Finanzamtsnr. (4-stlg.)</label>
                  <p className="text-xs font-mono text-black px-2 py-1 bg-amber-50 border border-amber-200 rounded">
                    {derivedFa || <span className="text-black/40 italic">—</span>}
                  </p>
                </div>
                <div className="flex flex-col gap-0.5 w-20">
                  <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">Länder-Kz.</label>
                  <p className="text-xs font-mono text-black px-2 py-1 bg-amber-50 border border-amber-200 rounded">
                    {derivedKz || <span className="text-black/40 italic">—</span>}
                  </p>
                </div>
              </div>
              {(!derivedKz || !derivedFa) && (
                <p className="text-[10px] text-black/50 font-mono">
                  Bundesland + Steuernummer in den Stammdaten oben eintragen, dann werden Finanzamtsnr. und Länder-Kz. automatisch berechnet.
                </p>
              )}

              {/* Hersteller-ID */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">Hersteller-ID</label>
                <input
                  type="text"
                  value={herstellerId}
                  onChange={e => setHerstellerId(e.target.value)}
                  onBlur={e => saveElsterSetting("hersteller_id", e.target.value)}
                  className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400"
                  placeholder="z.B. 40024"
                />
              </div>

              {/* Certificate */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider flex items-center gap-1">
                  ELSTER-Zertifikat (.pfx)
                  {certSaved && <span className="flex items-center gap-0.5 font-normal normal-case text-black"><IconCheck className="w-3 h-3" /> gespeichert</span>}
                </label>
                <input
                  type="file"
                  accept=".pfx,.p12"
                  ref={certFileRef}
                  className="hidden"
                  onChange={async e => {
                    const f = e.target.files?.[0];
                    if (f) await uploadCertFile(f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => certFileRef.current?.click()}
                  disabled={certUploading}
                  className="text-xs font-black px-2 py-1 rounded border border-black/20 hover:border-black hover:bg-amber-50 transition-colors text-left w-fit"
                >
                  {certUploading ? "Wird hochgeladen…" : "Zertifikat wählen…"}
                </button>
              </div>

              {/* Certificate PIN */}
              <div className="flex flex-col gap-0.5">
                <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider flex items-center gap-1">
                  Zertifikat-PIN
                  {certPinSaved && <span className="flex items-center gap-0.5 font-normal normal-case text-black"><IconCheck className="w-3 h-3" /> gespeichert</span>}
                </label>
                <div className="flex gap-1 items-center">
                  <input
                    type={showPin ? "text" : "password"}
                    value={certPassword}
                    onChange={e => setCertPassword(e.target.value)}
                    onBlur={async e => {
                      if (!e.target.value) return;
                      await saveElsterSetting("cert_pin", e.target.value);
                      setCertPinSaved(true);
                    }}
                    className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 flex-1"
                    autoComplete="current-password"
                    placeholder="Zertifikat-PIN"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(v => !v)}
                    className="px-1.5 py-1 border border-black/20 rounded bg-white hover:bg-amber-50"
                  >
                    {showPin ? <IconEyeOff className="w-3.5 h-3.5" /> : <IconEye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

            </div>
          )}
        </div>

        <div className="flex gap-2 mt-1">
          <button
            onClick={handleSave}
            className="flex-1 bg-black text-amber-400 text-xs font-bold py-1.5 rounded hover:bg-black/80 transition-colors"
          >
            {t("sidebar.taxpayer_save")}
          </button>
          {initial && (
            <button
              onClick={onClear}
              className="bg-red-500 text-white hover:bg-red-600 text-xs font-bold py-1.5 px-3 rounded transition-colors"
            >
              {t("sidebar.taxpayer_clear")}
            </button>
          )}
          <button
            onClick={onClose}
            className="bg-amber-50 hover:bg-amber-100 text-black text-xs font-bold py-1.5 px-3 rounded transition-colors"
          >
            {t("sidebar.taxpayer_close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual entry modal
// ---------------------------------------------------------------------------

type VerifiedCpEntry = { id: string; name: string | null; vat_id: string | null; tax_number: string | null };

export type ManualEntryForm = {
  date:            string;
  vendor:          string;
  vendor_verified: boolean;
  receipt_type:    "purchase" | "sale";
  category:        string;
  subcategory:     string;
  net_amount:      string;   // string for controlled input, parsed on save
  vat_percentage:  string;   // string for controlled input
  description:     string;
  currency:        string;
};

export function ManualEntryModal({ onSave, onClose, apiBase, dbPath, initialType }: {
  onSave:      (data: ManualEntryForm) => void;
  onClose:     () => void;
  apiBase:     string;
  dbPath?:     string | null;
  initialType: "purchase" | "sale";
}) {
  const { t } = useTranslation();
  const initialForm = useRef<ManualEntryForm>({
    date:            new Date().toISOString().slice(0, 10),
    vendor:          "",
    vendor_verified: false,
    receipt_type:    initialType,
    category:        "other",
    subcategory:     "",
    net_amount:      "",
    vat_percentage:  "0",
    description:     "",
    currency:        "EUR",
  });
  const [form, setForm] = useState<ManualEntryForm>(initialForm.current);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const isDirty = (Object.keys(form) as (keyof ManualEntryForm)[])
    .some((k) => form[k] !== initialForm.current[k]);

  const handleCloseRequest = () => {
    if (isDirty) setShowCloseConfirm(true);
    else onClose();
  };

  const set = (key: keyof ManualEntryForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  // Category dropdown
  const [showCatDropdown,    setShowCatDropdown]    = useState(false);
  const [showSubcatDropdown, setShowSubcatDropdown] = useState(false);
  const [showVatDropdown,    setShowVatDropdown]    = useState(false);

  // Verified counterparty picker
  const [showCpPicker, setShowCpPicker] = useState(false);
  const [cpList,       setCpList]       = useState<VerifiedCpEntry[]>([]);
  const [cpLoading,    setCpLoading]    = useState(false);
  const [cpQuery,      setCpQuery]      = useState("");

  useEffect(() => {
    if (!showCpPicker) return;
    setCpLoading(true);
    const dbQs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/counterparties/verified${dbQs}`)
      .then((r) => r.json())
      .then((d) => {
        const raw = (d.counterparties ?? []) as VerifiedCpEntry[];
        raw.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }));
        setCpList(raw);
      })
      .catch(() => {})
      .finally(() => setCpLoading(false));
  }, [showCpPicker, apiBase, dbPath]);

  const filteredCps = cpQuery.trim()
    ? cpList.filter((cp) => {
        const q = cpQuery.toLowerCase();
        return (cp.name ?? "").toLowerCase().includes(q)
          || (cp.vat_id ?? "").toLowerCase().includes(q)
          || (cp.tax_number ?? "").toLowerCase().includes(q);
      })
    : cpList;

  const inputCls = "border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 w-full";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div
        className="bg-white border-2 border-amber-400 rounded p-5 w-80 flex flex-col gap-3 shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <h4 className="text-black text-sm font-black uppercase tracking-wider">
          {t("sidebar.manual_entry_title")}
        </h4>

        {/* Type toggle */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
            {t("sidebar.manual_entry_type")}
          </label>
          <div className="flex rounded border border-black/10 overflow-hidden text-xs font-bold">
            {(["purchase", "sale"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setForm((p) => ({ ...p, receipt_type: type }))}
                className={`flex-1 py-1 transition-colors ${
                  form.receipt_type === type
                    ? "bg-black text-white"
                    : "bg-white text-black/40 hover:bg-amber-50"
                }`}
              >
                {type === "purchase" ? t("sidebar.expense") : t("sidebar.revenue")}
              </button>
            ))}
          </div>
        </div>

        {/* Date */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
            {t("sidebar.manual_entry_date")}
          </label>
          <input type="date" value={form.date} onChange={set("date")} className={inputCls} />
        </div>

        {/* Vendor */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
            {t("sidebar.manual_entry_vendor")}
          </label>
          <input type="text" value={form.vendor} onChange={set("vendor")} className={inputCls}
            placeholder="z. B. Finanzamt Berlin" />
          {/* Verified checkbox */}
          <label className="flex items-center gap-2 mt-0.5 cursor-pointer select-none">
            <span className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${
              form.vendor_verified ? "bg-amber-400 border-amber-500" : "bg-white border-black/30"
            }`}>
              {form.vendor_verified && <Icon icon="mdi:check" className="w-2.5 h-2.5 text-black" />}
            </span>
            <input
              type="checkbox"
              className="sr-only"
              checked={form.vendor_verified}
              onChange={(e) => setForm((p) => ({ ...p, vendor_verified: e.target.checked }))}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider text-black/40">
              {t("preview.cp_field_verified", { defaultValue: "Verified" })}
            </span>
          </label>
          {/* Verified counterparty picker */}
          <div>
            <button
              type="button"
              onClick={() => { setShowCpPicker((o) => !o); setCpQuery(""); }}
              className="flex items-center gap-1 text-[10px] font-bold text-black/40 hover:text-black uppercase tracking-wider transition-colors mt-0.5"
            >
              <Icon icon="mdi:account-check-outline" className="w-3.5 h-3.5" />
              {t("sidebar.manual_entry_select_verified", { defaultValue: "Aus verifizierten wählen" })}
              <Icon icon={showCpPicker ? "mdi:chevron-up" : "mdi:chevron-down"} className="w-3 h-3" />
            </button>
            {showCpPicker && (
              <div className="mt-1 border border-black/10 rounded overflow-hidden">
                <div className="px-2 py-1.5 border-b border-black/10">
                  <input
                    autoFocus
                    value={cpQuery}
                    onChange={(e) => setCpQuery(e.target.value)}
                    placeholder={t("preview.search_counterparty", { defaultValue: "Suchen…" })}
                    className="w-full text-xs font-mono bg-white border border-black/15 rounded px-2 py-1 outline-none focus:border-amber-400 placeholder:text-black/25"
                  />
                </div>
                {cpLoading ? (
                  <div className="px-3 py-2 text-xs text-black/30 font-mono">{t("sidebar.processing")}</div>
                ) : filteredCps.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-black/30 font-mono">
                    {cpList.length === 0
                      ? t("preview.no_verified_counterparties")
                      : t("preview.no_results", { defaultValue: "Keine Treffer" })}
                  </div>
                ) : filteredCps.map((cp) => (
                  <button
                    key={cp.id}
                    type="button"
                    onClick={() => {
                      setForm((p) => ({ ...p, vendor: cp.name ?? "" }));
                      setShowCpPicker(false);
                      setCpQuery("");
                      // Prefill category/subcategory from most-common DB values
                      if (cp.id) {
                        const dbQs = dbPath ? `&db=${encodeURIComponent(dbPath)}` : "";
                        fetch(`${apiBase}/counterparties/${encodeURIComponent(cp.id)}/defaults?${dbQs}`)
                          .then((r) => r.json())
                          .then((d: { category?: string; subcategory?: string }) => {
                            if (d.category) {
                              setForm((p) => ({
                                ...p,
                                category:    d.category!,
                                subcategory: d.subcategory ?? "",
                              }));
                            }
                          })
                          .catch(() => {});
                      }
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-amber-50 border-b border-black/5 last:border-0 transition-colors"
                  >
                    <div className="text-xs font-bold text-black">{cp.name ?? "—"}</div>
                    <div className="text-[10px] text-black/40 font-mono">{cp.vat_id ?? cp.tax_number ?? ""}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Category — custom dropdown with cashflow divider */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
            {t("sidebar.manual_entry_category")}
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowCatDropdown((o) => !o)}
              className={`${inputCls} flex items-center gap-1.5 text-left cursor-pointer`}
            >
              {CATEGORY_META[form.category] && (
                <Icon icon={CATEGORY_META[form.category].icon} className="shrink-0 text-base" />
              )}
              <span className="flex-1 truncate">
                {t(`sidebar.categories.${form.category}`, { defaultValue: form.category })}
              </span>
              <IconChevronDown className={`shrink-0 text-sm transition-transform ${showCatDropdown ? "rotate-180" : ""}`} />
            </button>
            {showCatDropdown && (
              <ul
                className="absolute z-30 mt-1 w-full bg-white border border-amber-300 rounded shadow-lg max-h-56 overflow-y-auto"
                onMouseLeave={() => setShowCatDropdown(false)}
              >
                {(Object.entries(CATEGORY_META) as [string, CategoryMeta][]).flatMap(([k, v], idx, arr) => {
                  const prevKey = idx > 0 ? arr[idx - 1][0] : null;
                  const needsDivider = CASHFLOW_ONLY_CATS.has(k) && !CASHFLOW_ONLY_CATS.has(prevKey ?? "");
                  const items = [];
                  if (needsDivider) {
                    items.push(
                      <li key={`${k}-divider`} className="px-2 pt-1.5 pb-0.5 border-t border-amber-200">
                        <span className="text-[9px] font-black uppercase tracking-wider text-black/40">
                          {t("sidebar.cashflow_only_label", { defaultValue: "Nur Cashflow" })}
                        </span>
                      </li>
                    );
                  }
                  items.push(
                    <li key={k}>
                      <button
                        type="button"
                        onClick={() => { setForm((p) => ({ ...p, category: k, subcategory: "" })); setShowCatDropdown(false); }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs font-mono text-left hover:bg-amber-50 transition-colors ${k === form.category ? "bg-amber-100 font-bold" : ""}`}
                      >
                        <Icon icon={v.icon} className="shrink-0 text-base" />
                        <span>{t(`sidebar.categories.${k}`, { defaultValue: v.label })}</span>
                      </button>
                    </li>
                  );
                  return items;
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Subcategory */}
        {(CATEGORY_SUBCATEGORIES[form.category] ?? []).length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
              {t("preview.field_subcategory", { defaultValue: "Subcategory" })}
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowSubcatDropdown((o) => !o); setShowVatDropdown(false); setShowCatDropdown(false); }}
                className={`${inputCls} flex items-center gap-1.5 text-left cursor-pointer`}
              >
                <span className="flex-1 truncate">
                  {form.subcategory
                    ? t(`sidebar.subcategories.${form.subcategory}`, { defaultValue: form.subcategory })
                    : "—"}
                </span>
                <IconChevronDown className={`shrink-0 text-sm transition-transform ${showSubcatDropdown ? "rotate-180" : ""}`} />
              </button>
              {showSubcatDropdown && (
                <ul
                  className="absolute z-30 mt-1 w-full bg-white border border-amber-300 rounded shadow-lg max-h-48 overflow-y-auto"
                  onMouseLeave={() => setShowSubcatDropdown(false)}
                >
                  <li>
                    <button
                      type="button"
                      onClick={() => { setForm((p) => ({ ...p, subcategory: "" })); setShowSubcatDropdown(false); }}
                      className={`w-full text-left px-2 py-1.5 text-xs font-mono hover:bg-amber-50 transition-colors ${form.subcategory === "" ? "bg-amber-100 font-bold" : "text-black/40"}`}
                    >—</button>
                  </li>
                  {(CATEGORY_SUBCATEGORIES[form.category] ?? []).map((k) => (
                    <li key={k}>
                      <button
                        type="button"
                        onClick={() => { setForm((p) => ({ ...p, subcategory: k })); setShowSubcatDropdown(false); }}
                        className={`w-full text-left px-2 py-1.5 text-xs font-mono hover:bg-amber-50 transition-colors truncate ${k === form.subcategory ? "bg-amber-100 font-bold" : ""}`}
                      >
                        {t(`sidebar.subcategories.${k}`, { defaultValue: k })}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Net amount + VAT */}
        <div className="flex gap-2">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
              {t("sidebar.manual_entry_net")}
            </label>
            <input type="text" inputMode="decimal" value={form.net_amount} onChange={set("net_amount")}
              className={inputCls} placeholder="0,00" />
          </div>
          <div className="flex flex-col gap-1 w-24">
            <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
              {t("sidebar.manual_entry_vat")}
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowVatDropdown((o) => !o); setShowSubcatDropdown(false); setShowCatDropdown(false); }}
                className={`${inputCls} flex items-center gap-1 text-left cursor-pointer`}
              >
                <span className="flex-1">{form.vat_percentage} %</span>
                <IconChevronDown className={`shrink-0 text-sm transition-transform ${showVatDropdown ? "rotate-180" : ""}`} />
              </button>
              {showVatDropdown && (
                <ul
                  className="absolute z-30 mt-1 w-full bg-white border border-amber-300 rounded shadow-lg overflow-hidden"
                  onMouseLeave={() => setShowVatDropdown(false)}
                >
                  {["0", "7", "19"].map((r) => (
                    <li key={r}>
                      <button
                        type="button"
                        onClick={() => { setForm((p) => ({ ...p, vat_percentage: r })); setShowVatDropdown(false); }}
                        className={`w-full text-left px-2 py-1.5 text-xs font-mono hover:bg-amber-50 transition-colors ${r === form.vat_percentage ? "bg-amber-100 font-bold" : ""}`}
                      >
                        {r} %
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-black/50 font-bold uppercase tracking-wider">
            {t("sidebar.manual_entry_description")}
          </label>
          <textarea value={form.description} onChange={set("description")}
            rows={2}
            className="border border-black/20 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-amber-400 w-full resize-none"
            placeholder={t("sidebar.manual_entry_notes_placeholder", { defaultValue: "z. B. USt-Erstattung Q1 2024" })} />
        </div>

        {/* Close confirmation strip */}
        {showCloseConfirm && (
          <div className="flex flex-col gap-2 bg-red-50 border border-red-200 rounded px-3 py-2">
            <p className="text-xs font-bold text-black leading-snug">
              {t("sidebar.manual_entry_discard_confirm", { defaultValue: "Nicht gespeicherte Daten verwerfen und schließen?" })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1 rounded transition-colors"
              >
                {t("sidebar.manual_entry_discard", { defaultValue: "Verwerfen & Schließen" })}
              </button>
              <button
                onClick={() => setShowCloseConfirm(false)}
                className="flex-1 bg-white border border-black/15 hover:bg-amber-50 text-black text-xs font-bold py-1 rounded transition-colors"
              >
                {t("sidebar.manual_entry_keep_editing", { defaultValue: "Weiter bearbeiten" })}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-1">
          <button
            onClick={() => onSave(form)}
            className="flex-1 bg-black text-amber-400 text-xs font-bold py-1.5 rounded hover:bg-black/80 transition-colors"
          >
            {t("sidebar.manual_entry_save")}
          </button>
          <button
            onClick={handleCloseRequest}
            className="bg-amber-50 hover:bg-amber-100 text-black text-xs font-bold py-1.5 px-3 rounded transition-colors"
          >
            {t("sidebar.taxpayer_close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation popover
// ---------------------------------------------------------------------------

function DeleteConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute right-0 top-6 z-20 bg-white border-1 border-black rounded shadow-lg p-3 flex flex-col gap-2 w-55"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs font-bold text-black leading-snug">
        {t("sidebar.delete_confirm.title")}
      </p>
      <p className="text-[10px] text-black/50 font-mono leading-relaxed">
        {t("sidebar.delete_confirm.hint")}
      </p>
      <div className="flex gap-1.5 mt-1">
        <button
          onClick={onConfirm}
          className="flex-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1 rounded transition-colors"
        >
          {t("sidebar.delete_confirm.confirm")}
        </button>
        <button
          onClick={onCancel}
          className="flex-1 bg-black/5 hover:bg-black/10 text-black text-xs font-bold py-1 rounded transition-colors"
        >
          {t("sidebar.delete_confirm.cancel")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  receipts:         Receipt[];
  allReceipts:      Receipt[];
  selectedId:       string | null;
  onSelect:         (receipt: Receipt) => void;
  onUpload:         (files: File[], type: "purchase" | "sale") => void;
  onManualEntry:    (data: ManualEntryForm) => void;
  onDelete:         (id: string) => void;
  uploading:        boolean;
  progressStep?:    string | null;
  onCancelUpload?:  () => void;
  error?:           string | null;
  period:           PeriodFilter;
  onPeriodChange:   (p: PeriodFilter) => void;
  taxpayer:         TaxpayerProfile | null;
  onEditTaxpayer:   () => void;
  apiBase:          string;
  dbPath?:          string | null;
};

// ---------------------------------------------------------------------------
// Category group — shared between revenue and expense sections
// ---------------------------------------------------------------------------

function CategoryGroup({
  cat: _cat, meta, items, isOpen, selectedId, confirmingId,
  onToggle, onSelect, onDeleteClick, onDeleteConfirm, onDeleteCancel,
}: {
  cat:             string;
  meta:            { label: string; icon: string };
  items:           Receipt[];
  isOpen:          boolean;
  selectedId:      string | null;
  confirmingId:    string | null;
  onToggle:        () => void;
  onSelect:        (r: Receipt) => void;
  onDeleteClick:   (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel:  () => void;
}) {
  const { t } = useTranslation();
  const catTotal = items.reduce((s, r) => s + (r.total_amount ?? 0), 0);

  // Group receipts by supplier name
  const supplierMap = items.reduce<Record<string, Receipt[]>>((acc, r) => {
    const key = displayName(r);
    (acc[key] ??= []).push(r);
    return acc;
  }, {});
  const supplierEntries = Object.entries(supplierMap).sort(([a], [b]) => a.localeCompare(b));

  // Track which supplier sub-groups are expanded (all closed by default)
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(new Set());
  const toggleSupplier = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSuppliers((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-red-50 transition-colors border-b border-black/5"
      >
        <span className="flex items-center gap-1.5 text-black text-xs font-bold uppercase tracking-wider min-w-0">
          <Icon icon={meta.icon} className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate" title={t(`sidebar.categories.${meta.label}`, meta.label)}>{t(`sidebar.categories.${meta.label}`, meta.label)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-black text-xs font-mono font-black">{fmt(catTotal)}</span>
          <IconChevronDown
            className={`w-3.5 h-3.5 text-black/30 transition-transform ${isOpen ? "" : "-rotate-90"}`}
          />
        </span>
      </button>

      {isOpen && supplierEntries.map(([supplierName, supplierItems]) => {
        const supplierTotal = supplierItems.reduce((s, r) => s + (r.total_amount ?? 0), 0);
        const isSupplierOpen = expandedSuppliers.has(supplierName);
        const hasSelectedItem = supplierItems.some((r) => r.id === selectedId);

        return (
          <div key={supplierName}>
            {/* Supplier sub-header — compact row, total intentionally larger than per-receipt amounts */}
            <button
              onClick={(e) => toggleSupplier(supplierName, e)}
              className={`w-full flex items-center justify-between pl-3 pr-3 py-1 text-left transition-colors border-b border-black/5 ${
                hasSelectedItem ? "bg-red-50/60" : "hover:bg-red-50/40"
              }`}
            >
              <span className="flex items-center gap-1 min-w-0">
                <span className="text-[11px] font-black text-black/30 font-mono tabular-nums w-4 text-right shrink-0">
                  {supplierItems.length}
                </span>
                <span className="text-[10px] font-bold text-black/70 truncate">{supplierName}</span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <span className="text-xs font-bold font-mono text-black">{fmt(supplierTotal)}</span>
                <IconChevronDown
                  className={`w-3 h-3 text-black/30 transition-transform ${isSupplierOpen ? "rotate-180" : ""}`}
                />
              </span>
            </button>

            {/* Individual receipts under this supplier — single line: date · number · amount */}
            {isSupplierOpen && supplierItems.map((r) => (
              <div
                key={r.id}
                onClick={() => onSelect(r)}
                className={`relative flex items-center justify-between pl-7 pr-3 py-1 border-l-4 cursor-pointer group transition-colors ${
                  selectedId === r.id
                    ? "border-red-500 bg-red-50"
                    : "border-transparent hover:bg-red-50/50 hover:border-red-200"
                }`}
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-[11px] text-black/50 font-mono shrink-0">
                    {r.receipt_date ?? t("sidebar.no_date")}
                  </span>
                  <span className="text-[11px] text-black/30 font-mono truncate min-w-0">
                    {r.receipt_number ?? ""}
                  </span>
                </div>
                <span className="text-[11px] text-black/60 font-mono font-bold shrink-0 ml-2">
                  {fmt(r.total_amount)}
                </span>

                {/* Delete button + confirmation popover */}
                <div className="relative ml-2 shrink-0 mt-0.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeleteClick(r.id); }}
                    className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-all"
                    title="Delete"
                  >
                    <IconDelete className="w-3.5 h-3.5" />
                  </button>

                  {confirmingId === r.id && (
                    <DeleteConfirm
                      onConfirm={() => onDeleteConfirm(r.id)}
                      onCancel={onDeleteCancel}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section divider
// ---------------------------------------------------------------------------

function SectionDivider({ label, count, total, isRevenue, isOpen, onToggle }: { label: string; count: number; total: number; isRevenue: boolean; isOpen: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-black/5 transition-colors"
    >
      <span className="flex items-center gap-1.5">
        <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${isRevenue ? "bg-black text-amber-400" : "bg-amber-400 text-black"}`}>
          {label}
        </span>
        <span className="bg-black text-white text-xs rounded-full px-1.5 py-0.5 font-mono font-bold leading-none">
          {count}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-xs font-mono font-black">{fmt(total)}</span>
        <IconChevronDown
          className={`w-3.5 h-3.5 text-black/30 transition-transform ${isOpen ? "" : "-rotate-90"}`}
        />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// MONTHS rendered via t("sidebar.months") array

export default function Sidebar({
  receipts, allReceipts, selectedId, onSelect, onUpload, onManualEntry, onDelete, uploading, progressStep, onCancelUpload, error,
  period, onPeriodChange, taxpayer, onEditTaxpayer, apiBase, dbPath,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [collapsed,       setCollapsed]       = useState<Set<string>>(new Set());
  const [revenueOpen,     setRevenueOpen]     = useState(true);
  const [expensesOpen,    setExpensesOpen]    = useState(true);
  const [cashflowOpen,    setCashflowOpen]    = useState(true);
  const { t } = useTranslation();
  const [uploadType,      setUploadType]      = useState<"purchase" | "sale">("purchase");
  const [confirmingId,    setConfirmingId]    = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [recentWindow,    setRecentWindow]    = useState<RecentWindow | null>(null);
  const [nameQuery,       setNameQuery]       = useState("");

  const nameQ = nameQuery.trim().toLowerCase();

  // Name search scans all receipts (ignores period & recent filters).
  // Recent filter overrides the period filter when active (but not name search).
  const displayedReceipts = nameQ
    ? allReceipts.filter((r) => {
        const name = (r.vendor ?? r.counterparty?.name ?? "").toLowerCase();
        return name.includes(nameQ);
      })
    : recentWindow !== null
      ? allReceipts.filter((r) => matchesRecent(r, recentWindow))
      : receipts;

  const grouped = displayedReceipts.reduce<Record<string, Receipt[]>>((acc, r) => {
    // Normalize any category not in CATEGORY_META to "other" so it always renders
    const cat = r.category in CATEGORY_META ? r.category : "other";
    (acc[cat] ??= []).push(r);
    return acc;
  }, {});

  const toggle = (cat: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onUpload(files, uploadType);
    e.target.value = "";
  };

  const handleDeleteClick  = (id: string) => setConfirmingId(id);
  const handleDeleteCancel = () => setConfirmingId(null);
  const handleDeleteConfirm = (id: string) => {
    setConfirmingId(null);
    onDelete(id);
  };

  // Counts + totals for section headers
  // Cashflow-only categories (tax settlements, capital movements) are shown
  // in a separate section and excluded from Revenue/Expense P&L totals.
  const purchases = displayedReceipts.filter((r) => r.receipt_type === "purchase" && !CASHFLOW_ONLY_CATS.has(r.category));
  const sales      = displayedReceipts.filter((r) => r.receipt_type === "sale"     && !CASHFLOW_ONLY_CATS.has(r.category));
  const purchaseTotal = purchases.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const saleTotal     = sales.reduce((s, r) => s + (r.total_amount ?? 0), 0);

  const cashflowReceipts = displayedReceipts.filter((r) => CASHFLOW_ONLY_CATS.has(r.category));
  const cashflowTotal    = cashflowReceipts.reduce((s, r) => {
    const signed = r.receipt_type === "sale" ? (r.total_amount ?? 0) : -(r.total_amount ?? 0);
    return s + signed;
  }, 0);

  // Category lists for the three sections
  const plCats       = Object.entries(CATEGORY_META).filter(([cat]) => !CASHFLOW_ONLY_CATS.has(cat));
  const cashflowCats = Object.entries(CATEGORY_META).filter(([cat]) =>  CASHFLOW_ONLY_CATS.has(cat));

  // Category entries preserving CATEGORY_META order (P&L categories only)
  const allCats = plCats;

  const renderGroup = (cat: string, meta: { label: string; icon: string }, type: "purchase" | "sale") => {
    const items = (grouped[cat] ?? [])
      .filter((r) => r.receipt_type === type)
      .sort((a, b) => {
        const nameA = displayName(a).toLowerCase();
        const nameB = displayName(b).toLowerCase();
        if (nameA !== nameB) return nameA < nameB ? -1 : 1;
        // Same name → latest date first
        const dA = a.receipt_date ?? "";
        const dB = b.receipt_date ?? "";
        return dB.localeCompare(dA);
      });
    if (!items.length) return null;
    return (
      <CategoryGroup
        key={`${type}-${cat}`}
        cat={cat}
        meta={meta}
        items={items}
        isOpen={!collapsed.has(`${type}-${cat}`)}
        selectedId={selectedId}
        confirmingId={confirmingId}
        onToggle={() => toggle(`${type}-${cat}`)}
        onSelect={onSelect}
        onDeleteClick={handleDeleteClick}
        onDeleteConfirm={handleDeleteConfirm}
        onDeleteCancel={handleDeleteCancel}
      />
    );
  };

  return (
    <aside className="w-70 shrink-0 bg-white border-r-2 border-red-500 flex flex-col overflow-hidden">

      {/* Upload */}
      <div className="p-3 border-b border-black/10 flex flex-col gap-2">
        <div className="flex rounded border border-black/10 overflow-hidden text-xs font-bold">
          {(["purchase", "sale"] as const).map((type) => (
            <button
              key={type}
              onClick={() => setUploadType(type)}
              className={`flex-1 py-1 transition-colors ${
                uploadType === type
                  ? "bg-black text-white"
                  : "bg-white text-black/40 hover:bg-red-50"
              }`}
            >
              {type === "purchase" ? t("sidebar.expense") : t("sidebar.revenue")}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex-1 flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm py-2 px-3 rounded border border-red-700 transition-colors"
          >
            {uploading ? (
              <>
                <IconSpinner className="w-4 h-4" />
                {progressStep ?? "..."}
              </>
            ) : (
              <>
                <Icon icon="mdi:upload" className="w-4 h-4" />
                {uploadType === "sale" ? t("sidebar.upload_invoice") : t("sidebar.upload_receipt")}
              </>
            )}
          </button>
          {uploading && (
            <button
              onClick={onCancelUpload}
              title={t("sidebar.cancel_upload")}
              className="flex items-center justify-center px-2 py-2 rounded border border-black/20 bg-white hover:bg-red-50 text-black/50 hover:text-red-600 transition-colors"
            >
              <Icon icon="mdi:close" className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Manual entry button */}
        <button
          onClick={() => setShowManualEntry(true)}
          disabled={uploading}
          className="flex items-center justify-center gap-2 border border-amber-400 hover:border-black bg-amber-50 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed text-black font-bold text-xs py-1.5 px-3 rounded transition-colors"
        >
          <Icon icon="mdi:pencil-plus-outline" className="w-4 h-4" />
          {t("sidebar.manual_entry_btn")}
        </button>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf"
          className="hidden"
          onChange={handleChange}
        />

        {/* Taxpayer data */}
        {!taxpayer?.name && (
          <div className="pt-1 border-t border-black/5">
            <p className="text-[10px] text-black/40 font-mono leading-relaxed mb-1">
              {t("sidebar.taxpayer_hint")}
            </p>
            <button
              onClick={onEditTaxpayer}
              className="text-[10px] text-black/50 hover:text-black font-bold underline underline-offset-2"
            >
              {t("sidebar.taxpayer_btn")}
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-pink-600 font-mono leading-relaxed">
          {error}
        </div>
      )}

      {/* Period filter */}
      <div className="px-3 py-2 border-b border-black/10 bg-white flex flex-col gap-1.5">
        {/* Period controls — dimmed when recent-upload filter or name search is active */}
        <div className={recentWindow !== null || !!nameQ ? "opacity-30 pointer-events-none select-none" : ""}>
          {/* Mode tabs */}
          <div className="flex rounded border border-black/10 overflow-hidden text-[10px] font-bold">
            {(["all", "year", "quarter", "month"] as PeriodMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onPeriodChange({ ...period, mode: m })}
                className={`flex-1 py-1 capitalize transition-colors ${
                  period.mode === m
                    ? "bg-black text-white"
                    : "bg-white text-black/40 hover:bg-red-50"
                }`}
              >
                {t(`sidebar.period.${m}`, m)}
              </button>
            ))}
          </div>

          {/* Year selector — shown for all modes except "all" */}
          {period.mode !== "all" && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <button
                onClick={() => onPeriodChange({ ...period, year: period.year - 1 })}
                className="text-black/40 hover:text-black transition-colors"
              >
                <Icon icon="mdi:chevron-left" className="w-4 h-4" />
              </button>
              <span className="flex-1 text-center text-xs font-black font-mono">{period.year}</span>
              <button
                onClick={() => onPeriodChange({ ...period, year: period.year + 1 })}
                className="text-black/40 hover:text-black transition-colors"
              >
                <Icon icon="mdi:chevron-right" className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Quarter picker */}
          {period.mode === "quarter" && (
            <div className="flex gap-1 mt-1.5">
              {[1,2,3,4].map((q) => (
                <button
                  key={q}
                  onClick={() => onPeriodChange({ ...period, quarter: q })}
                  className={`flex-1 py-0.5 text-[10px] font-black rounded transition-colors ${
                    period.quarter === q
                      ? "bg-red-500 text-white"
                      : "bg-black/5 text-black/50 hover:bg-black/10"
                  }`}
                >
                  Q{q}
                </button>
              ))}
            </div>
          )}

          {/* Month picker */}
          {period.mode === "month" && (
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {(t("sidebar.months", { returnObjects: true }) as string[]).map((name: string, i: number) => (
                <button
                  key={i}
                  onClick={() => onPeriodChange({ ...period, month: i + 1 })}
                  className={`py-0.5 text-[10px] font-black rounded transition-colors ${
                    period.month === i + 1
                      ? "bg-red-500 text-white"
                      : "bg-black/5 text-black/50 hover:bg-black/10"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Recent uploads filter */}
        <div className={`flex items-center gap-1.5 pt-0.5 border-t border-black/5 ${nameQ ? "opacity-30 pointer-events-none select-none" : ""}`}>
          <Icon icon="mdi:clock-fast" className="w-3.5 h-3.5 text-black/30 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-wider text-black/30 shrink-0">
            {t("sidebar.recent_filter.btn")}
          </span>
          <div className="flex gap-0.5 ml-auto">
            {(["1h", "8h", "today", "3d"] as RecentWindow[]).map((w) => (
              <button
                key={w}
                onClick={() => setRecentWindow(recentWindow === w ? null : w)}
                className={`px-1.5 py-0.5 text-[10px] font-black rounded transition-colors ${
                  recentWindow === w
                    ? "bg-amber-400 text-black"
                    : "bg-black/5 text-black/40 hover:bg-black/10"
                }`}
              >
                {t(`sidebar.recent_filter.${w}` as any)}
              </button>
            ))}
          </div>
        </div>

        {/* Name search */}
        <div className="flex items-center gap-1.5 pt-0.5 border-t border-black/5">
          <Icon icon="mdi:magnify" className="w-3.5 h-3.5 text-black/30 shrink-0" />
          <input
            type="text"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder={t("sidebar.search_placeholder")}
            className="flex-1 min-w-0 bg-transparent text-[10px] font-mono text-black placeholder:text-black/25 outline-none"
          />
          {nameQuery && (
            <button
              onClick={() => setNameQuery("")}
              className="text-black/30 hover:text-black transition-colors shrink-0"
            >
              <Icon icon="mdi:close" className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Lists */}
      <div className="flex-1 overflow-y-auto">

        {/* Revenue section */}
        {sales.length > 0 && (
          <>
            <SectionDivider label={t("sidebar.revenue")} count={sales.length} total={saleTotal} isRevenue={true} isOpen={revenueOpen} onToggle={() => setRevenueOpen((v) => !v)} />
            {revenueOpen && allCats.map(([cat, meta]) => renderGroup(cat, meta, "sale"))}
          </>
        )}

        {/* Expense section */}
        {purchases.length > 0 && (
          <>
            <SectionDivider label={t("sidebar.expenses")} count={purchases.length} total={purchaseTotal} isRevenue={false} isOpen={expensesOpen} onToggle={() => setExpensesOpen((v) => !v)} />
            {expensesOpen && allCats.map(([cat, meta]) => renderGroup(cat, meta, "purchase"))}
          </>
        )}

        {/* Cashflow-only section (tax settlements + capital movements) */}
        {cashflowReceipts.length > 0 && (
          <>
            <SectionDivider
              label={t("sidebar.cashflow_section", { defaultValue: "Cashflow" })}
              count={cashflowReceipts.length}
              total={cashflowTotal}
              isRevenue={false}
              isOpen={cashflowOpen}
              onToggle={() => setCashflowOpen((v) => !v)}
            />
            {cashflowOpen && cashflowCats.map(([cat, meta]) => (
              <div key={cat}>
                {renderGroup(cat, meta, "sale")}
                {renderGroup(cat, meta, "purchase")}
              </div>
            ))}
          </>
        )}

        {displayedReceipts.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <Icon icon={nameQ ? "mdi:magnify" : recentWindow !== null ? "mdi:clock-outline" : "mdi:receipt-text-outline"} className="w-10 h-10 text-black/20" />
            <p className="text-black/40 text-xs leading-relaxed">
              {nameQ
                ? t("sidebar.search_no_results", { q: nameQuery.trim() })
                : recentWindow !== null
                  ? t("sidebar.recent_filter.empty")
                  : <>{t("sidebar.no_receipts")}<br />{t("sidebar.no_receipts_hint")}</>}
            </p>
          </div>
        )}
      </div>

      {/* Manual entry modal */}
      {showManualEntry && (
        <ManualEntryModal
          onSave={(data) => {
            onManualEntry(data);
            setShowManualEntry(false);
          }}
          onClose={() => setShowManualEntry(false)}
          apiBase={apiBase}
          dbPath={dbPath}
          initialType={uploadType}
        />
      )}
    </aside>
  );
}