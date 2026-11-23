"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select, type DateRange } from "@whyte/design-system";
import { DateRangePicker } from "@whyte/design-system/client";

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The date range and segment for the analytics page, kept in the address so views can be shared. */
export function AnalyticsFilter({ from, to, segment }: { from: string; to: string; segment?: string }) {
  const router = useRouter();
  const path = usePathname();
  const [, start] = useTransition();
  const today = new Date();
  const ago = (n: number) => day(new Date(today.getTime() - n * 86_400_000));
  const presets = [
    { id: "30d", label: "Last 30 days", range: { start: ago(29), end: day(today) } },
    { id: "90d", label: "Last 90 days", range: { start: ago(89), end: day(today) } },
    { id: "12m", label: "Last 12 months", range: { start: ago(364), end: day(today) } },
    { id: "all", label: "Since 2015", range: { start: "2015-01-01", end: day(today) } },
  ];
  const go = (next: { from?: string; to?: string; segment?: string }) => {
    const q = new URLSearchParams({ from, to, ...(segment ? { segment } : {}), ...next });
    if (!q.get("segment")) q.delete("segment");
    start(() => router.push(`${path}?${q.toString()}`));
  };
  return (
    <div className="ds-inline">
      <DateRangePicker label="Dates" value={{ start: from, end: to }} presets={presets} max={day(today)} onChange={(r: DateRange) => go({ from: r.start, to: r.end })} />
      <Select label="Customers" size="small" value={segment ?? ""} onChange={(e) => go({ segment: e.target.value })}>
        <option value="">Riders and dealers</option>
        <option value="b2c">Riders (B2C)</option>
        <option value="b2b">Dealers (B2B)</option>
      </Select>
    </div>
  );
}
