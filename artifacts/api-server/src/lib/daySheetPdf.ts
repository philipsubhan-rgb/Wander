/**
 * PDF rendering for the daily trip one-pager (day sheet).
 *
 * Uses pdfkit directly (no HTML) and renders everything on a single US Letter
 * page. The function is defensive by design: any combination of empty items,
 * null weather/stay/notes, or oversized strings must still produce a valid
 * one-page PDF and must never throw.
 */

import PDFDocument from "pdfkit";
import type { DaySheet } from "./daySheet.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = 700; // stop adding body content below this y
const NAVY = "#1f3a5f";
const LIGHT_BLUE_GRAY = "#eaf0f6";
const BODY = "#1a1a1a";
const GRAY = "#6b7280";
const ELLIPSIS = "…";

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_OBLIQUE = "Helvetica-Oblique";

/** Render a single DaySheet to a one-page PDF buffer. Never throws. */
export async function renderDaySheetPdf(sheet: DaySheet): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: { Title: `Day Sheet — ${sheet.tripTitle ?? "Trip"}` },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));

      render(doc, sheet);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Tracked writer: every draw goes through `y()` and stops once the body
 * overflows the bottom limit, so we always stay on one page.
 */
function createLayout(doc: PDFKit.PDFDocument) {
  let y = 0;
  const hasRoom = (needed: number) => y + needed <= BOTTOM_LIMIT;
  return {
    y: () => y,
    setY: (v: number) => {
      y = v;
    },
    hasRoom,
    spacer(h: number) {
      y += h;
    },
    /** Draw wrapped text, truncated with an ellipsis if it would overflow. */
    text(
      text: string,
      opts: { font?: string; size?: number; color?: string; width?: number; align?: "left" | "center" | "right" } = {},
    ): boolean {
      const { font = FONT, size = 11, color = BODY, width = CONTENT_WIDTH, align = "left" } = opts;
      doc.font(font).fontSize(size).fillColor(color);
      const h = doc.heightOfString(text, { width, align });
      if (!hasRoom(h)) {
        // Try to fit a truncated single line instead.
        if (hasRoom(size * 1.4)) {
          const oneLine = truncateToFit(doc, text, size, width);
          doc.text(oneLine, MARGIN, y, { width, align });
          y += size * 1.4;
        }
        return false;
      }
      doc.text(text, MARGIN, y, { width, align });
      y += h + 4;
      return true;
    },
    /** Draw a filled band spanning the page width. */
    band(height: number, color: string) {
      doc.rect(0, y, PAGE_WIDTH, height).fill(color);
      return { top: y, height };
    },
    sectionTitle(title: string): boolean {
      if (!hasRoom(30)) return false;
      this.spacer(14);
      return this.text(title.toUpperCase(), { font: FONT_BOLD, size: 10, color: NAVY });
    },
  };
}

function truncateToFit(doc: PDFKit.PDFDocument, text: string, size: number, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (doc.widthOfString(clean) <= width) return clean;
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (doc.widthOfString(clean.slice(0, mid) + ELLIPSIS) <= width) lo = mid + 1;
    else hi = mid;
  }
  return clean.slice(0, Math.max(0, lo - 1)) + ELLIPSIS;
}

function formatItemRow(doc: PDFKit.PDFDocument, item: DaySheet["items"][number]): string {
  const time = item.time ? `${item.time} — ` : "";
  const title = item.title || "(untitled)";
  const parts = [time + title];
  if (item.location) parts.push(item.location);
  let row = parts.join(" — ");
  if (item.confirmationCode) row += ` [Conf ${item.confirmationCode}]`;
  // Keep rows short enough to fit; long rows are truncated in renderItem.
  void doc;
  return row;
}

function render(doc: PDFKit.PDFDocument, sheet: DaySheet): void {
  const layout = createLayout(doc);
  const tripTitle = sheet.tripTitle || "Trip";
  const dateLabel = sheet.dateLabel || "";
  const destination = sheet.destination || "";

  // ── Header band ──────────────────────────────────────────────
  const headerHeight = 118;
  const band = layout.band(headerHeight, NAVY);
  doc.font(FONT_BOLD).fontSize(20).fillColor("#ffffff");
  doc.text(truncateToFit(doc, tripTitle, 20, CONTENT_WIDTH), MARGIN, band.top + 22, {
    width: CONTENT_WIDTH,
  });
  doc.font(FONT).fontSize(11).fillColor("#ffffff");
  doc.text(
    truncateToFit(doc, `Day ${sheet.dayNumber} of ${sheet.dayCount} · ${dateLabel}`, 11, CONTENT_WIDTH),
    MARGIN,
    band.top + 52,
    { width: CONTENT_WIDTH },
  );
  doc.text(truncateToFit(doc, destination, 11, CONTENT_WIDTH), MARGIN, band.top + 70, {
    width: CONTENT_WIDTH,
  });
  layout.setY(band.top + headerHeight + 18);

  // ── Weather strip ────────────────────────────────────────────
  if (sheet.weather) {
    const w = sheet.weather;
    const stripHeight = 44;
    if (layout.hasRoom(stripHeight + 14)) {
      layout.band(stripHeight, LIGHT_BLUE_GRAY);
      doc.font(FONT).fontSize(11).fillColor(BODY);
      const wx = `Hi ${Math.round(w.highF)}°F / Lo ${Math.round(w.lowF)}°F · ${w.condition} · Rain ${Math.round(
        w.rainChancePct,
      )}%`;
      doc.text(truncateToFit(doc, wx, 11, CONTENT_WIDTH - 24), MARGIN + 12, layout.y() + 14, {
        width: CONTENT_WIDTH - 24,
      });
      layout.setY(layout.y() + stripHeight);
    }
    layout.spacer(14);
  }

  // ── Today's plan ─────────────────────────────────────────────
  layout.sectionTitle("Today's plan");
  const items = Array.isArray(sheet.items) ? sheet.items : [];
  if (items.length === 0) {
    layout.text("No plans scheduled — enjoy the day.", {
      font: FONT_OBLIQUE,
      size: 11,
      color: GRAY,
      align: "center",
    });
  } else {
    let truncated = false;
    for (const item of items) {
      const row = formatItemRow(doc, item);
      doc.font(FONT).fontSize(11);
      const needed = Math.min(doc.heightOfString(row, { width: CONTENT_WIDTH }), 44) + 8;
      if (!layout.hasRoom(needed)) {
        truncated = true;
        break;
      }
      layout.text(row, { size: 11 });
    }
    if (truncated && layout.hasRoom(16)) {
      layout.text(ELLIPSIS, { size: 11, color: GRAY, align: "center" });
    }
  }

  // ── Tonight ──────────────────────────────────────────────────
  if (sheet.stayTonight) {
    if (layout.sectionTitle("Tonight")) {
      layout.text(sheet.stayTonight.name || "Stay", { font: FONT_BOLD, size: 12 });
      if (sheet.stayTonight.address) {
        layout.text(sheet.stayTonight.address, { size: 10, color: GRAY });
      }
    }
  }

  // ── Notes ────────────────────────────────────────────────────
  if (sheet.dayNotes && sheet.dayNotes.trim()) {
    if (layout.sectionTitle("Notes")) {
      layout.text(sheet.dayNotes, { size: 11 });
    }
  }

  // ── Footer ───────────────────────────────────────────────────
  doc.font(FONT).fontSize(8).fillColor(GRAY);
  doc.text("Generated by Wander", 0, PAGE_HEIGHT - 36, {
    width: PAGE_WIDTH,
    align: "center",
  });
}
