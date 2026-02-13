/**
 * Recursively extracts text from Minecraft chat packet JSON structure.
 * Handles both simple strings and complex nested chat objects.
 * @param jsonLike - Chat packet data (string or object)
 * @returns Extracted text content
 */
export function extractTextFromChat(jsonLike: any): string {
  const clean = (text: string) => text.replace(/\u00A7[0-9A-FK-OR]/gi, "").replace(/\s+/g, " ").trim();

  try {
    if (typeof jsonLike === "string") {
      const s = jsonLike.trim();
      if (s.startsWith("{") || s.startsWith("[")) {
        return extractTextFromChat(JSON.parse(s));
      }
      const cleaned = clean(s);
      if (!cleaned || cleaned === '""' || cleaned === "''") return "";
      return cleaned;
    }
    if (typeof jsonLike === "number" || typeof jsonLike === "boolean") return String(jsonLike);
    if (!jsonLike) return "";
    if (Array.isArray(jsonLike)) return jsonLike.map(extractTextFromChat).filter(Boolean).join("");
    let out = "";
    if (typeof jsonLike.text === "string") out += jsonLike.text;
    if (typeof jsonLike.translate === "string") out += ` ${jsonLike.translate}`;
    if (typeof jsonLike.selector === "string") out += ` ${jsonLike.selector}`;
    if (typeof jsonLike.keybind === "string") out += ` ${jsonLike.keybind}`;
    if (typeof jsonLike.insertion === "string") out += ` ${jsonLike.insertion}`;
    if (typeof jsonLike.score?.value === "string" || typeof jsonLike.score?.value === "number") out += ` ${jsonLike.score.value}`;
    if (Array.isArray(jsonLike.with)) out += jsonLike.with.map(extractTextFromChat).join(" ");
    if (Array.isArray(jsonLike.extra)) out += jsonLike.extra.map(extractTextFromChat).join("");
    const normalized = clean(out);
    if (!normalized || normalized === '""' || normalized === "''") return "";
    return normalized;
  } catch {
    if (typeof jsonLike === "string") {
      const s = clean(jsonLike);
      return s === '""' || s === "''" ? "" : s;
    }
    return JSON.stringify(jsonLike);
  }
}
