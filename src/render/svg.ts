/**
 * Key images are rendered as SVG data URIs. Stream Deck rasterises them itself, so we can composite album art,
 * glyphs and text without any native image library.
 */

export const GREEN = "#1DB954";
export const BG = "#121212";
export const FG = "#ffffff";
export const MUTED = "#b3b3b3";

export const glyphs = {
  play: "M38 30 L38 114 L110 72 Z",
  pause: "M40 32 h22 v80 h-22 z M82 32 h22 v80 h-22 z",
  next: "M34 34 L34 110 L86 72 Z M92 34 h16 v76 h-16 z",
  previous: "M110 34 L110 110 L58 72 Z M36 34 h16 v76 h-16 z",
  heart:
    "M72 122 C72 122 20 90 20 54 C20 36 34 24 50 24 C60 24 68 30 72 38 C76 30 84 24 94 24 C110 24 124 36 124 54 C124 90 72 122 72 122 Z",
  shuffle:
    "M30 44 h20 c8 0 14 4 18 10 l10 14 M30 100 h20 c8 0 14 -4 18 -10 l10 -14 M78 68 l10 -14 c4 -6 10 -10 18 -10 h8 M78 76 l10 14 c4 6 10 10 18 10 h8 M104 34 l14 10 -14 10 M104 90 l14 10 -14 10",
  repeat: "M40 60 v-10 a12 12 0 0 1 12 -12 h44 M96 30 l10 8 -10 8 M104 84 v10 a12 12 0 0 1 -12 12 h-44 M48 114 l-10 -8 10 -8",
  volume: "M30 56 h18 l22 -18 v68 l-22 -18 h-18 z",
  volumeWaves: "M84 52 a26 26 0 0 1 0 40 M96 40 a42 42 0 0 1 0 64",
  mute: "M30 56 h18 l22 -18 v68 l-22 -18 h-18 z M86 58 l26 28 M112 58 l-26 28",
  seekFwd: "M72 24 a48 48 0 1 1 -34 14 M38 20 v22 h22",
  seekBack: "M72 24 a48 48 0 1 0 34 14 M106 20 v22 h-22",
  device: "M28 40 h88 v56 h-88 z M52 110 h40 M72 96 v14",
  playlist: "M30 40 h60 M30 64 h60 M30 88 h36 M96 80 v36 M80 98 h32",
  plus: "M72 36 v72 M36 72 h72",
  link: "M28 40 h88 v64 h-88 z",
  spotify: "M72 20 a52 52 0 1 0 0 104 a52 52 0 1 0 0 -104 z",
  check: "M34 74 l24 24 l52 -52",
  alert: "M72 28 L120 112 H24 Z M72 56 v28 M72 94 v6",
} as const;

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Rough truncation for a 144px-wide key; SVG has no text wrapping. */
export function fit(text: string, maxChars: number): string {
  text = text.trim();
  return text.length > maxChars ? text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…" : text;
}

export function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export type KeyOptions = {
  /** Album art data URI to draw full-bleed behind everything. */
  art?: string | null;
  /** Dim the art so overlaid glyphs/text read well. 0 = no dim. */
  dim?: number;
  /** Glyph path to draw in the centre. */
  glyph?: string;
  glyphStroke?: boolean;
  glyphColor?: string;
  glyphScale?: number;
  glyphY?: number;
  /** Small glyph badge in the top-right (e.g. heart / repeat-one). */
  badge?: string;
  badgeColor?: string;
  badgeStroke?: boolean;
  /** Small text badge in the top-right (e.g. "1" for repeat-one). */
  badgeText?: string;
  /** Up to two lines of text at the bottom. */
  title?: string;
  subtitle?: string;
  titleColor?: string;
  titleSize?: number;
  /** Big centred label instead of glyph (e.g. "57%"). */
  label?: string;
  labelColor?: string;
  labelSize?: number;
  /** Progress 0..1 drawn as a thin bar at the bottom. */
  progress?: number | null;
  progressColor?: string;
  /** Solid background colour (ignored when art is set). */
  background?: string;
  /** Subtle coloured ring around the key (e.g. active state). */
  ring?: string;
  /** Whole-key opacity, for "disabled / not connected" looks. */
  opacity?: number;
};

const FONT = `font-family="Segoe UI, Helvetica Neue, Arial, sans-serif"`;

export function keySvg(o: KeyOptions): string {
  const parts: string[] = [];
  parts.push(`<rect width="144" height="144" rx="14" fill="${o.background ?? BG}"/>`);
  if (o.art) {
    parts.push(`<image href="${o.art}" x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice"/>`);
    const dim = o.dim ?? 0.35;
    if (dim > 0) parts.push(`<rect width="144" height="144" fill="#000" opacity="${dim}"/>`);
    if (o.title || o.subtitle) {
      parts.push(
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></linearGradient></defs>`,
        `<rect x="0" y="72" width="144" height="72" fill="url(#g)"/>`,
      );
    }
  }
  if (o.ring) parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="${o.ring}" stroke-width="6"/>`);

  if (o.glyph) {
    const s = o.glyphScale ?? 1;
    const y = o.glyphY ?? 0;
    const color = o.glyphColor ?? FG;
    const fill = o.glyphStroke ? "none" : color;
    const stroke = o.glyphStroke ? `stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"` : "";
    parts.push(`<g transform="translate(${72 - 72 * s} ${72 - 72 * s + y}) scale(${s})"><path d="${o.glyph}" fill="${fill}" ${stroke}/></g>`);
  }
  if (o.label) {
    const size = o.labelSize ?? 44;
    parts.push(
      `<text x="72" y="${72 + size * 0.35}" text-anchor="middle" font-size="${size}" font-weight="700" fill="${o.labelColor ?? FG}" ${FONT}>${escapeXml(o.label)}</text>`,
    );
  }
  if (o.badge) {
    const color = o.badgeColor ?? GREEN;
    const fill = o.badgeStroke ? "none" : color;
    const stroke = o.badgeStroke ? `stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"` : "";
    parts.push(`<g transform="translate(98 8) scale(0.28)"><path d="${o.badge}" fill="${fill}" ${stroke}/></g>`);
  }
  if (o.badgeText) {
    parts.push(
      `<circle cx="118" cy="26" r="16" fill="${o.badgeColor ?? GREEN}"/>`,
      `<text x="118" y="33" text-anchor="middle" font-size="20" font-weight="700" fill="#000" ${FONT}>${escapeXml(o.badgeText)}</text>`,
    );
  }
  if (o.title) {
    const size = o.titleSize ?? 18;
    const y = o.subtitle ? 112 : 126;
    parts.push(
      `<text x="72" y="${y}" text-anchor="middle" font-size="${size}" font-weight="600" fill="${o.titleColor ?? FG}" ${FONT}>${escapeXml(fit(o.title, Math.floor(260 / size)))}</text>`,
    );
  }
  if (o.subtitle) {
    parts.push(`<text x="72" y="130" text-anchor="middle" font-size="14" fill="${MUTED}" ${FONT}>${escapeXml(fit(o.subtitle, 18))}</text>`);
  }
  if (o.progress !== undefined && o.progress !== null) {
    const w = Math.round(128 * Math.max(0, Math.min(1, o.progress)));
    parts.push(
      `<rect x="8" y="136" width="128" height="4" rx="2" fill="#ffffff" opacity="0.25"/>`,
      `<rect x="8" y="136" width="${w}" height="4" rx="2" fill="${o.progressColor ?? GREEN}"/>`,
    );
  }
  const body = parts.join("");
  const wrapped = o.opacity !== undefined && o.opacity < 1 ? `<g opacity="${o.opacity}">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${wrapped}</svg>`;
}

export function keyImage(o: KeyOptions): string {
  return toDataUri(keySvg(o));
}

/** A tiny "not connected" key: dimmed glyph plus a hint. */
export function notConnectedImage(glyph: string, stroke = false): string {
  return keyImage({ glyph, glyphStroke: stroke, glyphColor: "#666", glyphScale: 0.55, glyphY: -14, title: "Connect", subtitle: "in settings", titleColor: GREEN });
}

/** Small monochrome icon for touch-strip layouts / $B1 icon slot. */
export function iconSvg(glyph: string, color = FG, stroke = false): string {
  const fill = stroke ? "none" : color;
  const strokeAttr = stroke ? `stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"` : "";
  return toDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><path d="${glyph}" fill="${fill}" ${strokeAttr}/></svg>`);
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
