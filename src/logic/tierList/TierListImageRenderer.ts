import sharp from "sharp";
import { TierListTier, TIER_ORDER } from "./types";

export type TierListImagePlayer = {
  displayName: string;
  headIdentifier?: string;
};

export type TierListImageRows = Record<TierListTier, TierListImagePlayer[]>;

export type TierListImageOptions = {
  width?: number;
  labelColumnWidth?: number;
  baseRowHeight?: number;
  cellSize?: number;
  gap?: number;
  padding?: number;
  fontSize?: number;
  maxImageHeight?: number;
  maxFileBytes?: number;
  headUrlTemplate?: string;
};

export type TierListImageLayout = {
  pages: TierListImagePageLayout[];
  columns: number;
};

export type TierListImagePageLayout = {
  width: number;
  height: number;
  rows: TierListImageRowLayout[];
};

export type TierListImageRowLayout = {
  tier: TierListTier;
  y: number;
  height: number;
  players: TierListImageCellLayout[];
};

export type TierListImageCellLayout = {
  displayName: string;
  headIdentifier: string;
  text: string;
  x: number;
  y: number;
};

export type HeadLoader = (
  identifier: string,
  size: number
) => Promise<Buffer | null>;

type ResolvedOptions = Required<TierListImageOptions>;
type RowSegment = { tier: TierListTier; players: TierListImagePlayer[] };

const DEFAULT_OPTIONS: ResolvedOptions = {
  width: 1816,
  labelColumnWidth: 223,
  baseRowHeight: 180,
  cellSize: 108,
  gap: 18,
  padding: 24,
  fontSize: 24,
  maxImageHeight: 4096,
  maxFileBytes: 8_000_000,
  headUrlTemplate: "https://mc-heads.net/avatar/{identifier}/{size}.png",
};

const TIER_COLORS: Record<TierListTier, string> = {
  S: "#ff7f7f",
  A: "#ffc46b",
  B: "#fff173",
  C: "#79df72",
  D: "#70b7ff",
  E: "#c184ff",
};

const BACKGROUND = "#202020";
const SEPARATOR = "#000000";
const TEXT = "#f4f4f4";
const LABEL_TEXT = "#111111";

export class TierListHeadCache {
  private readonly cache = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly headUrlTemplate: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  load(identifier: string, size: number) {
    const safeIdentifier = identifier.trim() || "Steve";
    const key = `${safeIdentifier}:${size}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const loaded = this.fetchHead(safeIdentifier, size);
    this.cache.set(key, loaded);
    return loaded;
  }

  private async fetchHead(identifier: string, size: number) {
    try {
      const url = this.headUrlTemplate
        .replace("{identifier}", encodeURIComponent(identifier))
        .replace("{size}", String(size));
      const response = await this.fetcher(url);
      if (!response.ok) return placeholderHead(size, identifier);
      const arrayBuffer = await response.arrayBuffer();
      return await sharp(Buffer.from(arrayBuffer))
        .resize(size, size, { fit: "cover" })
        .png()
        .toBuffer();
    } catch (error) {
      void error;
      return placeholderHead(size, identifier);
    }
  }
}

export function resolveTierListImageOptions(
  options: TierListImageOptions = {}
): ResolvedOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined)
    ),
  };
}

export function calculateTierListImageLayout(
  rows: TierListImageRows,
  options: TierListImageOptions = {}
): TierListImageLayout {
  const resolved = resolveTierListImageOptions(options);
  const contentWidth = resolved.width - resolved.labelColumnWidth;
  const columns = Math.max(
    1,
    Math.floor(
      (contentWidth - resolved.padding * 2 + resolved.gap) /
        (resolved.cellSize + resolved.gap)
    )
  );
  const pageRows: TierListImageRowLayout[] = [];
  const pages: TierListImagePageLayout[] = [];
  let y = 0;

  for (const segment of splitRowsForPageHeight(rows, columns, resolved)) {
    const height = rowHeight(segment.players.length, columns, resolved);
    if (
      pageRows.length &&
      y + height > resolved.maxImageHeight &&
      y >= resolved.baseRowHeight
    ) {
      pages.push({ width: resolved.width, height: y, rows: [...pageRows] });
      pageRows.length = 0;
      y = 0;
    }

    pageRows.push({
      tier: segment.tier,
      y,
      height,
      players: segment.players.map((player, index) =>
        cellLayout(player, index, y, columns, resolved)
      ),
    });
    y += height;
  }

  if (pageRows.length) {
    pages.push({ width: resolved.width, height: y, rows: [...pageRows] });
  }

  return { pages, columns };
}

export async function renderTierListSnapshot(
  rows: TierListImageRows,
  options: TierListImageOptions = {},
  headLoader?: HeadLoader
) {
  const resolved = resolveTierListImageOptions(options);
  const layout = calculateTierListImageLayout(rows, resolved);
  const defaultHeadCache = new TierListHeadCache(resolved.headUrlTemplate);
  const loader = headLoader ?? defaultHeadCache.load.bind(defaultHeadCache);
  const rendered: Buffer[] = [];

  for (const page of layout.pages) {
    const pageBuffer = await renderPage(page, resolved, loader);
    if (pageBuffer.length > resolved.maxFileBytes && page.rows.length > 1) {
      for (const row of page.rows) {
        rendered.push(
          await renderPage(
            {
              width: page.width,
              height: row.height,
              rows: [
                {
                  ...row,
                  y: 0,
                  players: row.players.map((player) => ({
                    ...player,
                    y: player.y - row.y,
                  })),
                },
              ],
            },
            resolved,
            loader
          )
        );
      }
    } else {
      rendered.push(pageBuffer);
    }
  }

  return rendered;
}

export function emptyTierListImageRows(): TierListImageRows {
  return { S: [], A: [], B: [], C: [], D: [], E: [] };
}

export function truncateTierListName(
  name: string,
  maxWidth: number,
  fontSize: number
) {
  const clean = name.trim() || "?";
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * 0.56)));
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 1) return "…";
  return `${clean.slice(0, maxChars - 1)}…`;
}

function splitRowsForPageHeight(
  rows: TierListImageRows,
  columns: number,
  options: ResolvedOptions
) {
  const maxRowsPerSegment = Math.max(
    1,
    Math.floor(
      (options.maxImageHeight - options.padding * 2 + options.gap) /
        (cellLineHeight(options) + options.gap)
    )
  );
  const maxPlayersPerSegment = columns * maxRowsPerSegment;
  const segments: RowSegment[] = [];

  for (const tier of TIER_ORDER) {
    const players = rows[tier];
    if (!players.length) {
      segments.push({ tier, players: [] });
      continue;
    }
    for (let i = 0; i < players.length; i += maxPlayersPerSegment) {
      segments.push({
        tier,
        players: players.slice(i, i + maxPlayersPerSegment),
      });
    }
  }

  return segments;
}

function rowHeight(
  playerCount: number,
  columns: number,
  options: ResolvedOptions
) {
  if (playerCount === 0) return options.baseRowHeight;
  const lines = Math.max(1, Math.ceil(playerCount / columns));
  return Math.max(
    options.baseRowHeight,
    options.padding * 2 +
      lines * cellLineHeight(options) +
      (lines - 1) * options.gap
  );
}

function cellLayout(
  player: TierListImagePlayer,
  index: number,
  rowY: number,
  columns: number,
  options: ResolvedOptions
): TierListImageCellLayout {
  const column = index % columns;
  const line = Math.floor(index / columns);
  const x =
    options.labelColumnWidth +
    options.padding +
    column * (options.cellSize + options.gap);
  const y =
    rowY + options.padding + line * (cellLineHeight(options) + options.gap);

  return {
    displayName: player.displayName,
    headIdentifier: player.headIdentifier || player.displayName,
    text: truncateTierListName(
      player.displayName,
      options.cellSize,
      options.fontSize
    ),
    x,
    y,
  };
}

async function renderPage(
  page: TierListImagePageLayout,
  options: ResolvedOptions,
  headLoader: HeadLoader
) {
  const composites = await Promise.all(
    page.rows.flatMap((row) =>
      row.players.map(async (player) => ({
        input:
          (await headLoader(player.headIdentifier, options.cellSize)) ??
          (await placeholderHead(options.cellSize, player.headIdentifier)),
        left: player.x,
        top: player.y,
      }))
    )
  );

  return sharp(Buffer.from(pageSvg(page, options)))
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function pageSvg(page: TierListImagePageLayout, options: ResolvedOptions) {
  const rows = page.rows
    .map((row) => {
      const players = row.players
        .map(
          (player) => `
            <text x="${player.x + options.cellSize / 2}" y="${
              player.y + options.cellSize + options.fontSize + 8
            }" text-anchor="middle" font-size="${options.fontSize}" fill="${TEXT}" font-family="Arial, Helvetica, sans-serif">${escapeSvg(player.text)}</text>`
        )
        .join("");
      return `
        <rect x="0" y="${row.y}" width="${options.labelColumnWidth}" height="${row.height}" fill="${TIER_COLORS[row.tier]}"/>
        <rect x="${options.labelColumnWidth}" y="${row.y}" width="${
          page.width - options.labelColumnWidth
        }" height="${row.height}" fill="${BACKGROUND}"/>
        <text x="${options.labelColumnWidth / 2}" y="${
          row.y + row.height / 2 + options.baseRowHeight * 0.17
        }" text-anchor="middle" font-size="${Math.floor(
          options.baseRowHeight * 0.62
        )}" font-weight="700" fill="${LABEL_TEXT}" font-family="Arial Black, Arial, Helvetica, sans-serif">${row.tier}</text>
        ${players}
        <rect x="0" y="${row.y + row.height - 6}" width="${page.width}" height="6" fill="${SEPARATOR}"/>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">
    <rect width="${page.width}" height="${page.height}" fill="${SEPARATOR}"/>
    ${rows}
  </svg>`;
}

async function placeholderHead(size: number, identifier: string) {
  const initials = (identifier.trim()[0] ?? "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="#4b5563"/>
    <rect x="${size * 0.08}" y="${size * 0.08}" width="${size * 0.84}" height="${
      size * 0.84
    }" fill="#64748b"/>
    <text x="${size / 2}" y="${size * 0.64}" text-anchor="middle" font-size="${
      size * 0.52
    }" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#f8fafc">${escapeSvg(initials)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function cellLineHeight(options: ResolvedOptions) {
  return options.cellSize + options.fontSize + 14;
}

function escapeSvg(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
