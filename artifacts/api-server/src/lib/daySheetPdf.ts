/**
 * PDF rendering for the daily trip one-pager (day sheet).
 *
 * Designed to echo the hand-built Munich day sheets: a full-bleed photo
 * header with the day number, a navy weather pill, a two-column body (day
 * plan timeline on the left; reservations, highlights and notes cards on the
 * right), and a navy footer strip with base / hard times / day count.
 *
 * Uses pdfkit directly (no HTML). `renderDaySheetPdf` renders a single sheet
 * on one US Letter page; `renderDaySheetsPdf` renders several sheets — one
 * page per sheet. The rendering is defensive by design: any combination of
 * empty items, null weather/stay/notes/photos, oversized strings, or
 * unreachable images must still produce a valid PDF and must never throw.
 */

import PDFDocument from "pdfkit";
import type { DaySheet, DaySheetItem } from "./daySheet.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const NAVY = "#1f3a5f";
const GOLD = "#c9a227";
const BODY = "#1a1a1a";
const GRAY = "#6b7280";
const CARD_BORDER = "#d8e0ea";
const WHITE = "#ffffff";
const ELLIPSIS = "…";

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_OBLIQUE = "Helvetica-Oblique";

const HEADER_H = 200;
const WEATHER_H = 32;
const FOOTER_H = 60;

const LEFT_X = MARGIN;
const LEFT_W = 296;
const COL_GAP = 16;
const RIGHT_X = MARGIN + LEFT_W + COL_GAP;
const RIGHT_W = PAGE_WIDTH - MARGIN - RIGHT_X;

const IMAGE_TIMEOUT_MS = 10_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_URL_CAP = 12;

// ---------------------------------------------------------------------------
// Images: downloaded server-side, every image optional.
// ---------------------------------------------------------------------------

/** Download one image URL. Returns null on any failure — never throws. */
async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    // pdfkit embeds JPEG/PNG; WebP/SVG would throw inside doc.image().
    if (ct.includes("webp") || ct.includes("svg")) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 16) return null;
    // Sniff JPEG/PNG magic when the content type is missing or generic.
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isJpeg && !isPng) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Download every distinct image URL referenced by the sheets (capped). */
async function loadImages(sheets: DaySheet[]): Promise<Map<string, Buffer>> {
  const urls = new Set<string>();
  for (const s of sheets) {
    if (s.heroPhotoUrl) urls.add(s.heroPhotoUrl);
    for (const item of s.items ?? []) {
      if (item.photoUrl) urls.add(item.photoUrl);
    }
    if (urls.size >= IMAGE_URL_CAP) break;
  }
  const map = new Map<string, Buffer>();
  await Promise.all(
    [...urls].slice(0, IMAGE_URL_CAP).map(async url => {
      const buf = await fetchImage(url);
      if (buf) map.set(url, buf);
    }),
  );
  return map;
}

/** Draw a buffer cover-fit into the box. Returns false if it cannot be drawn. */
function drawCover(
  doc: PDFKit.PDFDocument,
  buf: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  try {
    doc.save();
    doc.rect(x, y, w, h).clip();
    try {
      doc.image(buf, x, y, { cover: [w, h] });
    } catch {
      // Older pdfkit builds may not support `cover`; fall back to fit.
      doc.image(buf, x, y, { fit: [w, h], align: "center", valign: "center" });
    }
    doc.restore();
    return true;
  } catch {
    try {
      doc.restore();
    } catch {
      /* ignore */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function truncateToFit(
  doc: PDFKit.PDFDocument,
  text: string,
  font: string,
  size: number,
  width: number,
): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  doc.font(font).fontSize(size);
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

/** "09:00" -> "9:00 AM". Returns the input unchanged when it is not HH:MM. */
function formatTime(t: string | null): string | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  if (Number.isNaN(h) || h > 23) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m[2]} ${ampm}`;
}

interface Chip {
  label: string;
  color: string;
}

/** Status chip derived from item data. Null when nothing meaningful applies. */
function chipFor(item: DaySheetItem): Chip | null {
  if (item.confirmationCode) return { label: "BOOKED", color: "#a8841c" };
  if (item.type === "flight") return { label: "FLIGHT", color: "#2563eb" };
  if (item.type === "accommodation") return { label: "STAY", color: "#16a34a" };
  if (!item.time) return { label: "FLEX", color: GRAY };
  return null;
}

/** "Friday, September 25" -> "FRIDAY". */
function dayName(dateLabel: string): string {
  const first = (dateLabel ?? "").split(",")[0].trim();
  return (first || "DAY").toUpperCase();
}

/** Collapse notes to a single tagline: the first sentence, truncated. */
function taglineFor(dayNotes: string | null): string {
  const clean = (dayNotes ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return firstSentence.length > 110 ? firstSentence.slice(0, 109).trimEnd() + ELLIPSIS : firstSentence;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render a single DaySheet to a one-page PDF buffer. Never throws. */
export async function renderDaySheetPdf(sheet: DaySheet): Promise<Buffer> {
  return renderDaySheetsPdf([sheet]);
}

/** Render several DaySheets — one US Letter page per sheet. Never throws. */
export async function renderDaySheetsPdf(sheets: DaySheet[]): Promise<Buffer> {
  const images = await loadImages(sheets);
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: { Title: `Day Sheet — ${sheets[0]?.tripTitle ?? "Trip"}` },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));

      sheets.forEach((sheet, i) => {
        if (i > 0) {
          doc.addPage({
            size: "LETTER",
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          });
        }
        try {
          renderSheet(doc, sheet, images);
        } catch {
          renderFallback(doc, sheet);
        }
      });

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Page sections
// ---------------------------------------------------------------------------

function renderSheet(doc: PDFKit.PDFDocument, sheet: DaySheet, images: Map<string, Buffer>): void {
  const tripTitle = sheet.tripTitle || "Trip";
  const dateLabel = sheet.dateLabel || "";
  const dayNo = Math.max(0, sheet.dayNumber || 0);
  const dayCount = Math.max(dayNo, sheet.dayCount || 0);

  renderHeader(doc, sheet, images, tripTitle, dateLabel, dayNo, dayCount);

  let bodyTop = HEADER_H + 12;
  if (sheet.weather) {
    renderWeather(doc, sheet.weather, dateLabel);
    bodyTop += WEATHER_H + 12;
  }
  const bodyBottom = PAGE_HEIGHT - FOOTER_H - 12;

  renderDayPlan(doc, sheet, images, bodyTop, bodyBottom);
  renderRightCards(doc, sheet, images, bodyTop, bodyBottom);
  renderFooter(doc, sheet, tripTitle, dayNo, dayCount);
}

/** Minimal fallback page when a sheet fails to render — never throws. */
function renderFallback(doc: PDFKit.PDFDocument, sheet: DaySheet): void {
  try {
    doc.rect(0, 0, PAGE_WIDTH, 120).fill(NAVY);
    doc.font(FONT_BOLD).fontSize(18).fillColor(WHITE);
    doc.text("Day Sheet", MARGIN, 48, { width: PAGE_WIDTH - MARGIN * 2 });
    doc.font(FONT).fontSize(11).fillColor(GRAY);
    doc.text("This day sheet could not be rendered.", MARGIN, 160, {
      width: PAGE_WIDTH - MARGIN * 2,
    });
    void sheet;
  } catch {
    /* absolute last resort: leave the blank page */
  }
}

function renderHeader(
  doc: PDFKit.PDFDocument,
  sheet: DaySheet,
  images: Map<string, Buffer>,
  tripTitle: string,
  dateLabel: string,
  dayNo: number,
  dayCount: number,
): void {
  const hero = sheet.heroPhotoUrl ? images.get(sheet.heroPhotoUrl) : undefined;
  if (hero && drawCover(doc, hero, 0, 0, PAGE_WIDTH, HEADER_H)) {
    const grad = doc.linearGradient(0, 30, 0, HEADER_H);
    grad.stop(0, "#000000", 0).stop(1, "#000000", 0.82);
    doc.rect(0, 0, PAGE_WIDTH, HEADER_H).fill(grad);
  } else {
    doc.rect(0, 0, PAGE_WIDTH, HEADER_H).fill(NAVY);
    doc.rect(0, HEADER_H - 3, PAGE_WIDTH, 3).fill(GOLD);
  }

  // Day badge, top right.
  const badgeW = 104;
  const badgeH = 24;
  const bx = PAGE_WIDTH - MARGIN - badgeW;
  doc.fillOpacity(0.55);
  doc.roundedRect(bx, 22, badgeW, badgeH, 12).fill("#000000");
  doc.fillOpacity(1);
  doc.font(FONT_BOLD).fontSize(10).fillColor(WHITE);
  doc.text(`DAY ${dayNo} OF ${dayCount}`, bx, 29, { width: badgeW, align: "center" });

  const tw = PAGE_WIDTH - MARGIN * 2 - 130;
  doc.font(FONT_BOLD).fontSize(10).fillColor(GOLD);
  doc.text(truncateToFit(doc, tripTitle.toUpperCase(), FONT_BOLD, 10, tw), MARGIN, 92, {
    width: tw,
    characterSpacing: 2,
  });
  doc.font(FONT_BOLD).fontSize(46).fillColor(WHITE);
  doc.text(`DAY ${dayNo}`, MARGIN, 104, { width: tw });
  doc.font(FONT).fontSize(13).fillColor(GOLD);
  doc.text(truncateToFit(doc, dateLabel.toUpperCase(), FONT, 13, tw), MARGIN, 156, {
    width: tw,
    characterSpacing: 1,
  });
  const tagline = taglineFor(sheet.dayNotes);
  if (tagline) {
    doc.font(FONT_OBLIQUE).fontSize(10.5).fillColor(WHITE);
    doc.text(truncateToFit(doc, tagline, FONT_OBLIQUE, 10.5, tw), MARGIN, 176, { width: tw });
  }
}

interface WeatherSnapshotLike {
  highF: number;
  lowF: number;
  condition: string;
  rainChancePct: number;
}

function renderWeather(doc: PDFKit.PDFDocument, w: WeatherSnapshotLike, dateLabel: string): void {
  const y = HEADER_H + 12;
  const wdt = PAGE_WIDTH - MARGIN * 2;
  doc.roundedRect(MARGIN, y, wdt, WEATHER_H, WEATHER_H / 2).fill(NAVY);
  const wx =
    `${dayName(dateLabel)} · ` +
    `${Math.round(w.highF)}°F / ${Math.round(w.lowF)}°F · ` +
    `${(w.condition || "").toUpperCase()} · ` +
    `${Math.round(w.rainChancePct)}% CHANCE OF RAIN`;
  doc.font(FONT).fontSize(11).fillColor(WHITE);
  doc.text(truncateToFit(doc, wx, FONT, 11, wdt - 40), MARGIN + 20, y + 10, {
    width: wdt - 40,
    align: "center",
    characterSpacing: 0.5,
  });
}

// ---------------------------------------------------------------------------
// Left column: day plan
// ---------------------------------------------------------------------------

function renderChip(doc: PDFKit.PDFDocument, chip: Chip, x: number, y: number): number {
  doc.font(FONT_BOLD).fontSize(8);
  const w = Math.min(doc.widthOfString(chip.label) + 18, 120);
  doc.roundedRect(x, y, w, 16, 8).fill(chip.color);
  doc.fillColor(WHITE);
  doc.text(chip.label, x, y + 4.5, { width: w, align: "center" });
  return y + 16;
}

const TITLE_MAX_H = 28; // two lines at 11pt
const DESC_MAX_H = 24; // two lines at 9.5pt
const THUMB = 58;

function cleanTitle(item: DaySheetItem): string {
  return (item.title || "(untitled)").toUpperCase().replace(/\s+/g, " ").trim();
}

function cleanDesc(item: DaySheetItem): string {
  return (item.description ?? "").replace(/\s+/g, " ").trim();
}

/** Height of one timeline item block, measured without drawing. */
function itemBlockHeight(doc: PDFKit.PDFDocument, item: DaySheetItem, images: Map<string, Buffer>): number {
  const thumb = item.photoUrl ? images.get(item.photoUrl) : undefined;
  const textW = LEFT_W - (thumb ? THUMB + 8 : 0);
  let h = 0;
  if (formatTime(item.time) || chipFor(item)) h += 15;
  doc.font(FONT_BOLD).fontSize(11);
  h += Math.min(doc.heightOfString(cleanTitle(item), { width: textW }), TITLE_MAX_H) + 4;
  const desc = cleanDesc(item);
  if (desc) {
    doc.font(FONT).fontSize(9.5);
    h += Math.min(doc.heightOfString(desc, { width: textW }), DESC_MAX_H) + 3;
  }
  return Math.max(h, thumb ? THUMB + 2 : 0);
}

function renderItem(
  doc: PDFKit.PDFDocument,
  item: DaySheetItem,
  images: Map<string, Buffer>,
  y: number,
): number {
  const thumb = item.photoUrl ? images.get(item.photoUrl) : undefined;
  const textW = LEFT_W - (thumb ? THUMB + 8 : 0);
  let cy = y;

  // Time and status chip share one line.
  const t = formatTime(item.time);
  const chip = chipFor(item);
  if (t || chip) {
    let cx = LEFT_X;
    if (t) {
      doc.font(FONT_BOLD).fontSize(11).fillColor(BODY);
      doc.text(t, cx, cy, { width: textW });
      cx += doc.widthOfString(t) + 10;
    }
    if (chip && cx + 64 <= LEFT_X + textW) {
      renderChip(doc, chip, cx, cy - 1);
    }
    cy += 15;
  }

  // Title: up to two lines.
  const title = cleanTitle(item);
  doc.font(FONT_BOLD).fontSize(11).fillColor(BODY);
  const titleH = Math.min(doc.heightOfString(title, { width: textW }), TITLE_MAX_H);
  doc.text(title, LEFT_X, cy, { width: textW, height: TITLE_MAX_H, ellipsis: true });
  cy += titleH + 4;

  // Description: up to two lines.
  const desc = cleanDesc(item);
  if (desc) {
    doc.font(FONT).fontSize(9.5).fillColor(GRAY);
    const descH = Math.min(doc.heightOfString(desc, { width: textW }), DESC_MAX_H);
    doc.text(desc, LEFT_X, cy, { width: textW, height: DESC_MAX_H, ellipsis: true });
    cy += descH + 3;
  }

  if (thumb) {
    drawCover(doc, thumb, LEFT_X + LEFT_W - THUMB, y + 1, THUMB, THUMB);
  }
  return Math.max(cy, y + (thumb ? THUMB + 2 : 0));
}

function renderDayPlan(
  doc: PDFKit.PDFDocument,
  sheet: DaySheet,
  images: Map<string, Buffer>,
  top: number,
  bottom: number,
): void {
  let y = top;
  doc.rect(LEFT_X, y, LEFT_W, 24).fill(NAVY);
  doc.font(FONT_BOLD).fontSize(11).fillColor(WHITE);
  doc.text("DAY PLAN", LEFT_X + 12, y + 7, { width: LEFT_W - 24, characterSpacing: 1.5 });
  y += 24 + 10;

  const items = Array.isArray(sheet.items) ? sheet.items : [];
  if (items.length === 0) {
    doc.font(FONT_OBLIQUE).fontSize(11).fillColor(GRAY);
    doc.text("No plans scheduled — enjoy the day.", LEFT_X, y, { width: LEFT_W, align: "center" });
    return;
  }

  let shown = 0;
  for (const item of items) {
    const h = itemBlockHeight(doc, item, images);
    if (y + h > bottom) break;
    y = renderItem(doc, item, images, y) + 8;
    shown++;
  }
  if (shown < items.length && y + 18 <= bottom) {
    doc.font(FONT).fontSize(11).fillColor(GRAY);
    doc.text(ELLIPSIS, LEFT_X, y, { width: LEFT_W, align: "center" });
  }
}

// ---------------------------------------------------------------------------
// Right column: cards
// ---------------------------------------------------------------------------

/** Draw a navy card header; returns the y where card content starts. */
function cardHeader(doc: PDFKit.PDFDocument, title: string, y: number): number {
  doc.rect(RIGHT_X, y, RIGHT_W, 24).fill(NAVY);
  doc.font(FONT_BOLD).fontSize(10).fillColor(WHITE);
  doc.text(title, RIGHT_X + 10, y + 8, { width: RIGHT_W - 20, characterSpacing: 1 });
  return y + 24 + 8;
}

function renderReservationsCard(
  doc: PDFKit.PDFDocument,
  booked: DaySheetItem[],
  y: number,
  bottom: number,
): number {
  y = cardHeader(doc, "RESERVATIONS & ANCHORS", y);
  for (const item of booked) {
    const title = cleanTitle(item);
    doc.font(FONT_BOLD).fontSize(10).fillColor(BODY);
    const titleH = Math.min(doc.heightOfString(title, { width: RIGHT_W - 4 }), 26);
    const rowH = titleH + 14 + (item.location ? 12 : 0) + 8;
    if (y + rowH > bottom) break;
    doc.text(title, RIGHT_X + 2, y, { width: RIGHT_W - 4, height: 26, ellipsis: true });
    const detailBits: string[] = [];
    const t = formatTime(item.time);
    if (t) detailBits.push(t);
    if (item.confirmationCode) detailBits.push(`Conf ${item.confirmationCode}`);
    doc.font(FONT).fontSize(9).fillColor(GRAY);
    doc.text(detailBits.join(" · "), RIGHT_X + 2, y + titleH + 2, { width: RIGHT_W - 4 });
    if (item.location) {
      doc.font(FONT_OBLIQUE).fontSize(8.5).fillColor(GRAY);
      doc.text(truncateToFit(doc, item.location, FONT_OBLIQUE, 8.5, RIGHT_W - 4), RIGHT_X + 2, y + titleH + 14, {
        width: RIGHT_W - 4,
      });
    }
    y += rowH;
  }
  return y + 8;
}

function renderHighlightsCard(
  doc: PDFKit.PDFDocument,
  items: DaySheetItem[],
  images: Map<string, Buffer>,
  y: number,
  bottom: number,
): number {
  y = cardHeader(doc, "HIGHLIGHTS OF THE DAY", y);
  const cellW = (RIGHT_W - 10) / 2;
  const photoH = 62;
  const rowH = photoH + 16;
  for (let r = 0; r * 2 < items.length; r++) {
    if (y + rowH > bottom) break;
    for (let c = 0; c < 2; c++) {
      const item = items[r * 2 + c];
      if (!item) continue;
      const x = RIGHT_X + c * (cellW + 10);
      const buf = item.photoUrl ? images.get(item.photoUrl) : undefined;
      if (buf) {
        drawCover(doc, buf, x, y, cellW, photoH);
      } else {
        doc.rect(x, y, cellW, photoH).fill(CARD_BORDER);
      }
      doc.font(FONT).fontSize(8.5).fillColor(GRAY);
      doc.text(truncateToFit(doc, item.title || "", FONT, 8.5, cellW), x, y + photoH + 3, {
        width: cellW,
      });
    }
    y += rowH + 6;
  }
  return y + 8;
}

function renderNotesCard(doc: PDFKit.PDFDocument, y: number, bottom: number): number {
  y = cardHeader(doc, "NOTES", y);
  const lineGap = 22;
  const maxLines = Math.max(0, Math.floor((bottom - y - 6) / lineGap));
  const lines = Math.min(6, maxLines);
  doc.strokeColor(CARD_BORDER).lineWidth(1);
  for (let i = 0; i < lines; i++) {
    const ly = y + 8 + i * lineGap;
    doc
      .moveTo(RIGHT_X + 4, ly)
      .lineTo(RIGHT_X + RIGHT_W - 4, ly)
      .stroke();
  }
  return y + lines * lineGap + 8;
}

function renderRightCards(
  doc: PDFKit.PDFDocument,
  sheet: DaySheet,
  images: Map<string, Buffer>,
  top: number,
  bottom: number,
): void {
  let y = top;
  const items = Array.isArray(sheet.items) ? sheet.items : [];

  const booked = items.filter(i => i.confirmationCode);
  if (booked.length > 0 && y + 70 < bottom) {
    y = renderReservationsCard(doc, booked, y, bottom);
  }

  const withPhotos = items.filter(i => i.photoUrl && images.get(i.photoUrl)).slice(0, 4);
  if (withPhotos.length > 0 && y + 110 < bottom) {
    y = renderHighlightsCard(doc, withPhotos, images, y, bottom);
  }

  if (y + 60 < bottom) {
    renderNotesCard(doc, y, bottom);
  }
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function hardTimes(sheet: DaySheet): string {
  const items = sheet.items ?? [];
  // Booked anchors first, then other timed items; cap at three like the
  // hand-built sheets ("Dachau 9:00 AM · Paulaner-Zelt 5:15 PM").
  const booked = items.filter(i => i.time && i.confirmationCode);
  const others = items.filter(i => i.time && !i.confirmationCode);
  const parts = [...booked, ...others].slice(0, 3).map(i => {
    const title = (i.title ?? "").replace(/\s+/g, " ").trim();
    const short = title.length > 20 ? title.slice(0, 19).trimEnd() + ELLIPSIS : title;
    return `${short} ${formatTime(i.time)}`;
  });
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function renderFooter(
  doc: PDFKit.PDFDocument,
  sheet: DaySheet,
  tripTitle: string,
  dayNo: number,
  dayCount: number,
): void {
  const y = PAGE_HEIGHT - FOOTER_H;
  doc.rect(0, y, PAGE_WIDTH, FOOTER_H).fill(NAVY);
  doc.rect(0, y, PAGE_WIDTH, 2).fill(GOLD);

  const cells = [
    { label: "BASE", value: sheet.stayTonight?.name || "—" },
    { label: "HARD TIMES", value: hardTimes(sheet) },
    { label: `DAY ${dayNo} OF ${dayCount}`, value: tripTitle },
  ];
  const cw = PAGE_WIDTH / 3;
  cells.forEach((cell, i) => {
    const x = i * cw + 24;
    const w = cw - 48;
    doc.font(FONT_BOLD).fontSize(8).fillColor(GOLD);
    doc.text(truncateToFit(doc, cell.label, FONT_BOLD, 8, w), x, y + 12, {
      width: w,
      characterSpacing: 1,
    });
    doc.font(FONT).fontSize(10).fillColor(WHITE);
    const val = cell.value || "—";
    doc.text(val, x, y + 26, { width: w, height: 26, ellipsis: true });
  });
}
