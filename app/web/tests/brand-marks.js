// For the tests of the brand marks (src/ui/ModelBrand.jsx).

/**
 * Whether an image's `src` is the bundled colour file of `brand`: its path on this site, or — a small file, which the
 * bundler inlines — a data: URL of its text (the brand's title, no currentColor). Never an address on another site.
 */
export function isBundledColourMark(src, brand) {
  if (/^https?:|^\/\//i.test(src)) return false;
  if (src.startsWith("data:image/svg+xml")) {
    const body = src.slice(src.indexOf(",") + 1);
    const text = src.includes(";base64,") ? atob(body) : decodeURIComponent(body);
    return new RegExp(`<title>${brand}</title>`, "i").test(text) && !text.includes("currentColor");
  }
  return new RegExp(`/model-brands/${brand}-color\\.svg$`).test(src);
}
