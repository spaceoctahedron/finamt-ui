import { useState } from "react";
import { Icon } from "@iconify/react";
import { IconChevronDown } from "../constants/icons";
import { useTranslation } from "react-i18next";
import type { Receipt, PeriodFilter, TaxpayerProfile, ElsterSettings } from "./Sidebar";
import { CATEGORY_META, CASHFLOW_ONLY_CATS, fmt, displayName, EMPTY_ELSTER } from "./Sidebar";
import type { CategoryMeta } from "./Sidebar";
import { UStVAPanel } from "./returns/UStVAPanel";
import { UStPanel } from "./returns/UStPanel";
import { GewStPanel } from "./returns/GewStPanel";
import { KStPanel } from "./returns/KStPanel";
import { JahresabschlussPanel } from "./returns/JahresabschlussPanel";
import { ReturnsOverview } from "./returns/ReturnsOverview";
import { KycKysPanel } from "./KycKysPanel";

type Props = { receipts: Receipt[]; allReceipts: Receipt[]; period: PeriodFilter; taxpayer?: TaxpayerProfile | null; elsterSettings?: ElsterSettings; onEditTaxpayer?: () => void; onUpdateTaxpayer?: (patch: Partial<TaxpayerProfile>) => void; apiBase?: string; dbPath?: string | null; };

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
function StatCard({ label, value, sub, variant = "white" }: {
  label: string; value: string; sub?: string;
  variant?: "black" | "amber" | "white";
}) {
  const styles = {
    black: "bg-black text-amber-400 border-black",
    amber: "bg-amber-400 text-black border-amber-400",
    white: "bg-white text-black border-amber-400",
  };
  return (
    <div className={`border-2 rounded p-4 flex flex-col gap-1 ${styles[variant]}`}>
      <span className="text-xs uppercase tracking-wider font-bold opacity-70">{label}</span>
      <span className="text-2xl font-black font-mono">{value}</span>
      {sub && <span className="text-xs opacity-60">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category bar chart (with per-supplier drill-down)
// ---------------------------------------------------------------------------
function CategoryChart({ title, totals, receipts }: {
  title: string;
  totals: Record<string, number>;
  receipts: Receipt[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const max    = Math.max(...Object.values(totals), 1);
  const sorted = Object.entries(totals).sort(([, a], [, b]) => b - a);

  const toggle = (cat: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });

  return (
    <div className="bg-white border-2 border-amber-400 rounded p-4">
      <h3 className="text-black text-sm font-black uppercase tracking-wider mb-4">{title}</h3>
      {sorted.length === 0 ? (
        <p className="text-black/70 text-sm text-center py-8 font-mono">{t("dashboard.no_data")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {sorted.map(([cat, total]) => {
            const pct  = Math.round((total / max) * 100);
            const meta = CATEGORY_META[cat] as CategoryMeta | undefined;
            const isOpen = expanded.has(cat);

            // aggregate by supplier within this category
            const supplierTotals = receipts
              .filter((r) => (r.category in CATEGORY_META ? r.category : "other") === cat)
              .reduce<Record<string, number>>((acc, r) => {
                const name = displayName(r);
                acc[name] = (acc[name] ?? 0) + (r.total_amount ?? 0);
                return acc;
              }, {});
            const supplierEntries = Object.entries(supplierTotals).sort(([, a], [, b]) => b - a);
            return (
              <div key={cat}>
                {/* Category row */}
                <div
                  className="flex items-center gap-3 py-2 rounded cursor-pointer hover:bg-amber-50"
                  onClick={() => toggle(cat)}
                >
                  <span className="text-xs text-black/70 font-bold w-36 capitalize shrink-0 flex items-center gap-1.5 truncate">
                    {meta?.icon && <Icon icon={meta.icon} className="w-3.5 h-3.5 shrink-0" />}
                    <span className="truncate">
                      {t(`sidebar.categories.${cat}`, { defaultValue: meta?.label ?? cat })}
                    </span>
                  </span>
                  <div className="flex-1 bg-amber-100 border border-amber-200 rounded h-3 overflow-hidden">
                    <div className="bg-black h-3 rounded transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-black font-black font-mono w-24 text-right shrink-0">
                    {fmt(total)}
                  </span>
                  <IconChevronDown
                    className={`w-3.5 h-3.5 text-black shrink-0 transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </div>

                {/* Supplier breakdown */}
                {isOpen && (
                  <div className="ml-[9.5rem] mb-2 flex flex-col gap-1 border-l-2 border-amber-200 pl-3">
                    {supplierEntries.map(([name, amt]) => (
                      <div key={name} className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-black/70 font-mono truncate">{name}</span>
                        <span className="text-[11px] text-black font-mono font-bold shrink-0">{fmt(amt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Dashboard({ receipts, allReceipts, period, taxpayer, elsterSettings = EMPTY_ELSTER, onEditTaxpayer, onUpdateTaxpayer, apiBase = "", dbPath }: Props) {
  const { t } = useTranslation();
  const [submissionTick, setSubmissionTick] = useState(0);

  // ── Period label ────────────────────────────────────────────────────────
  const monthNames = t("sidebar.months", { returnObjects: true }) as string[];
  const periodLabel = period.mode === "all"
    ? t("dashboard.period_all")
    : period.mode === "year"
    ? t("dashboard.period_year", { year: period.year })
    : period.mode === "quarter"
    ? t("dashboard.period_quarter", { quarter: period.quarter, year: period.year })
    : t("dashboard.period_month", { month: monthNames[period.month - 1], year: period.year });

  // All purchases/sales for VAT (includes cashflow-only — VAT is transaction-level)
  const allPurchases = receipts.filter((r) => r.receipt_type === "purchase");
  const allSales     = receipts.filter((r) => r.receipt_type === "sale");
  // P&L-only (cashflow categories excluded from Revenue/Expense stat cards + charts)
  const purchases = allPurchases.filter((r) => !CASHFLOW_ONLY_CATS.has(r.category));
  const sales     = allSales.filter((r) => !CASHFLOW_ONLY_CATS.has(r.category));

  const totalExpenses = purchases.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const totalRevenue  = sales.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const inputVat      = allPurchases.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const outputVat     = allSales.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const netLiability  = outputVat - inputVat;

  const revenueTotals = sales.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + (r.total_amount ?? 0);
    return acc;
  }, {});

  const expenseTotals = purchases.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + (r.total_amount ?? 0);
    return acc;
  }, {});

  return (
    <main className="flex-1 overflow-y-auto bg-amber-50 p-6 flex flex-col gap-6">

      {/* Header */}
      <div className="border-b-2 border-amber-400 pb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-black text-xl font-black uppercase tracking-tight">{t("dashboard.title")}</h2>
          <p className="text-black text-xs font-mono mt-0.5">{periodLabel}</p>
        </div>
        {taxpayer?.name && (
          <div className="text-right shrink-0">
            <p className="text-black text-xs font-bold font-mono">
              {taxpayer.name}
              {(taxpayer.vat_id || taxpayer.tax_number) && (
                <span className="text-black font-normal ml-1.5">
                  ({[taxpayer.vat_id, taxpayer.tax_number].filter(Boolean).join(" • ")})
                </span>
              )}
            </p>
            <div className="flex items-baseline justify-end gap-2 mt-0.5">
              {(taxpayer.street || taxpayer.address_supplement || taxpayer.city) && (
                <p className="text-black text-[11px] font-mono">
                  {[taxpayer.street, taxpayer.address_supplement, [taxpayer.postcode, taxpayer.city].filter(Boolean).join(" "), taxpayer.state, taxpayer.country].filter(Boolean).join(", ")}
                </p>
              )}
              {onEditTaxpayer && (
                <button
                  onClick={onEditTaxpayer}
                  className="cursor-pointer text-[10px] text-black hover:text-amber-700 font-bold underline underline-offset-2 shrink-0"
                >
                  {t("sidebar.taxpayer_edit_btn")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <StatCard variant="black" label={t("dashboard.stat_revenue")}
          value={fmt(totalRevenue)}
          sub={sales.length === 1 ? t("dashboard.count_invoices", { n: sales.length }) : t("dashboard.count_invoices_plural", { n: sales.length })} />
        <StatCard variant="amber" label={t("dashboard.stat_expenses")}
          value={fmt(totalExpenses)}
          sub={purchases.length === 1 ? t("dashboard.count_receipts", { n: purchases.length }) : t("dashboard.count_receipts_plural", { n: purchases.length })} />
        <StatCard variant="black" label={t("dashboard.stat_output_vat")}
          value={fmt(outputVat)} sub={t("dashboard.stat_payable")} />
        <StatCard variant="amber" label={t("dashboard.stat_input_vat")}
          value={fmt(inputVat)} sub={t("dashboard.stat_reclaimable")} />
        <StatCard variant="white"
          label={netLiability === 0 ? t("dashboard.stat_vat_balance") : netLiability > 0 ? t("dashboard.stat_vat_payable") : t("dashboard.stat_vat_refund")}
          value={fmt(Math.abs(netLiability))}
          sub={t("dashboard.stat_output_minus_input")} />
      </div>

      {/* Category charts */}
      <div className={`grid gap-4 ${
        Object.keys(revenueTotals).length > 0 && Object.keys(expenseTotals).length > 0
          ? "grid-cols-2" : "grid-cols-1"
      }`}>
        {Object.keys(revenueTotals).length > 0 && (
          <CategoryChart title={t("dashboard.chart_revenue")} totals={revenueTotals} receipts={sales} />
        )}
        {Object.keys(expenseTotals).length > 0 && (
          <CategoryChart title={t("dashboard.chart_expenses")} totals={expenseTotals} receipts={purchases} />
        )}
        {receipts.length === 0 && (
          <div className="bg-white border-2 border-amber-400 rounded p-8 text-center col-span-2">
            <p className="text-black/70 text-sm font-mono">
              {t("dashboard.no_data_hint")}
            </p>
          </div>
        )}
      </div>

      {/* KYC / KYS */}
      <KycKysPanel receipts={allReceipts} apiBase={apiBase} dbPath={dbPath} />

      {/* STEUERERKLÄRUNGEN — ÜBERSICHT */}
      <ReturnsOverview
        taxpayer={taxpayer}
        onUpdateTaxpayer={onUpdateTaxpayer}
        apiBase={apiBase}
        dbPath={dbPath}
        refreshKey={submissionTick}
      />

      {/* UMSATZSTEUER-VORANMELDUNG */}
      <UStVAPanel receipts={receipts} period={period} apiBase={apiBase} dbPath={dbPath} taxpayer={taxpayer} elsterSettings={elsterSettings} onSubmissionChange={() => setSubmissionTick(n => n + 1)} />

      {/* UMSATZSTEUERERKLÄRUNG */}
      <UStPanel allReceipts={allReceipts} period={period} apiBase={apiBase} dbPath={dbPath} taxpayer={taxpayer} elsterSettings={elsterSettings} onSubmissionChange={() => setSubmissionTick(n => n + 1)} />

      {/* GEWERBESTEUERERKLÄRUNG */}
      <GewStPanel allReceipts={allReceipts} period={period} taxpayer={taxpayer} onEditTaxpayer={onEditTaxpayer} />

      {/* KÖRPERSCHAFTSTEUERERKLÄRUNG */}
      <KStPanel allReceipts={allReceipts} period={period} taxpayer={taxpayer} onEditTaxpayer={onEditTaxpayer} />

      {/* Jahresabschluss */}
      <JahresabschlussPanel allReceipts={allReceipts} period={period} taxpayer={taxpayer} onEditTaxpayer={onEditTaxpayer} apiBase={apiBase} dbPath={dbPath} elsterSettings={elsterSettings} />

      {/* Tax return tiles */}
      <div className="grid grid-cols-2 gap-3">
        {([
          { key: "eur", icon: "mdi:calculator-variant-outline" },
          { key: "est", icon: "mdi:account-cash-outline" },
        ]).map(({ key, icon }) => (
          <div key={key}
            className="bg-white border-2 border-amber-400 border-dashed rounded p-6 flex flex-col items-center justify-center gap-2 text-center">
            <Icon icon={icon} className="w-7 h-7 text-black/70" />
            <span className="text-black/70 text-sm font-black uppercase tracking-wider">{t(`dashboard.tile_${key}_title`)}</span>
            <span className="text-black text-[10px] font-mono">{t(`dashboard.tile_${key}_sub`)}</span>
            <span className="text-black text-xs font-mono">{t("dashboard.coming_soon")}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
