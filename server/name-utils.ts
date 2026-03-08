/**
 * Shared name normalization for cross-source speaker/author matching.
 * Used by torahanytime.ts, alldaf.ts, and kolhalashon.ts.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "'")
    // English titles
    .replace(/\b(rabbi|rav|r\.|r'|rebbetzin|harav|hagaon|moreinu|dr\.?|mrs?\.?)\b/gi, "")
    // Hebrew titles
    .replace(/\b(הרב|הגאון|מורנו|הרבנית|ר')\b/g, "")
    // Content/topic words
    .replace(/\b(shiurim|shiur|lectures?|podcast|audio|video|series|classes?|torah|daf yomi|daf|gemara|mishnah?|parsha|parasha)\b/gi, "")
    // Middle initials like "J."
    .replace(/\b[a-z]\.\s*/gi, "")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
