import { pgTable, serial, text, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * FX rate snapshots — the provenance record for every converted money
 * figure Wander shows or confirms (international-foundation §2.2/§2.5).
 *
 * A converted display or a confirmation screen records the snapshot id it
 * used, so any number a traveler saw can be reproduced exactly later. The
 * rate is a DISPLAY input only: it never changes what a supplier charges,
 * and supplier amounts are always stored in the currency quoted. Launch
 * source is the ECB daily reference rates (via Frankfurter); `source`
 * names the feed so multiple feeds can coexist.
 *
 * `rate` is numeric and arrives as a string from Drizzle: units of
 * quote_currency per 1 unit of base_currency (e.g. base EUR, quote USD,
 * rate 1.063). High scale (10) because cross rates are derived by division
 * and must not lose precision at storage.
 */
export const fxRateSnapshotsTable = pgTable("fx_rate_snapshots", {
  id: serial("id").primaryKey(),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  rate: numeric("rate", { precision: 18, scale: 10 }).notNull(),
  source: text("source").notNull(),
  asOf: timestamp("as_of").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("fx_rate_snapshots_pair_source_asof_idx").on(t.baseCurrency, t.quoteCurrency, t.source, t.asOf),
  index("fx_rate_snapshots_pair_asof_idx").on(t.baseCurrency, t.quoteCurrency, t.asOf),
]);

export type FxRateSnapshot = typeof fxRateSnapshotsTable.$inferSelect;
