/**
 * Tolerant RSS/XML parsing for deal feeds.
 *
 * Feeds regularly contain bare "&" or control characters that make the whole
 * document invalid XML. A single broken item must not discard the healthy ones,
 * so the document is sanitised first and, if it still fails, parsed item by item.
 */

export function sanitizeXml(xml) {
  return String(xml || "")
    .replace(/[--]/g, "")
    // Escape ampersands that are not already a valid entity.
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;");
}

function looksLikeFeed(xml) {
  return /<(rss|rdf:RDF|feed)[\s>]/i.test(xml);
}

function extractItemBlocks(xml) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
}

function safeParse(parser, doc) {
  // rss-parser can surface the same failure twice (callback + rejection);
  // the extra handler keeps Node from treating it as an unhandled rejection.
  try {
    const promise = parser.parseString(doc);
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
    return promise;
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * @returns {Promise<{items: object[], skipped: number, recovered: boolean}>}
 * `recovered` is true when the document failed as a whole and items were parsed
 * individually; `skipped` counts items that could not be parsed.
 */
export function normalizeFeedXml(xml) {
  // rss-parser refuses <rss> without a version attribute.
  return xml.replace(/<rss(?![^>]*version=)([^>]*)>/i, '<rss version="2.0"$1>');
}

export async function parseFeedXml(parser, rawXml) {
  const xml = normalizeFeedXml(sanitizeXml(rawXml));
  // rss-parser throws asynchronously for non-RSS documents, so reject early.
  if (!looksLikeFeed(xml)) throw new Error("Dokumen bukan RSS/Atom");

  try {
    const parsed = await safeParse(parser, xml);
    return { items: parsed.items || [], skipped: 0, recovered: false };
  } catch (error) {
    const blocks = extractItemBlocks(xml);
    if (!blocks.length) throw new Error("Bukan RSS/XML sah (kemungkinan HTML atau had kadar HTTP 429)");

    const items = [];
    let skipped = 0;
    for (const block of blocks) {
      try {
        const parsed = await safeParse(
          parser,
          normalizeFeedXml(`<rss><channel>${sanitizeXml(block)}</channel></rss>`)
        );
        if (parsed.items && parsed.items.length) items.push(...parsed.items);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (!items.length) throw new Error("Bukan RSS/XML sah (kemungkinan HTML atau had kadar HTTP 429)");
    return { items, skipped, recovered: true };
  }
}
