/**
 * SVG picture safety, shared by the desktop drop path and the headless renderer: the sanitiser, the
 * CSS tokenizer it reads with, and the bitmap header readers. Pure: no DOM is touched but the
 * injected parser's own documents, and nothing here loads jsPDF.
 */
export {
  MAX_SVG_ATTRIBUTES, MAX_SVG_CSS_CHARS, MAX_SVG_DEPTH, MAX_SVG_ELEMENTS, MAX_SVG_EMBEDDED_DECODED_BYTES, MAX_SVG_NODES,
  MAX_SVG_SOURCE_CHARS, SVG_PICTURE_FORMAT_LABEL, hasUnsafeCssReference, sanitizeSvgPicture, sanitizeSvgStylesheet,
  sanitizeStyleAttribute, type EmbeddedSvgBitmap, type SanitizedSvg, type SvgSafetyOptions, type SvgSanitizeResult,
  type SvgSanitizeState
} from "./svgSanitizer";
export { CssTokenBudgetError, MAX_CSS_TOKENS, matchCssBlocks, tokenizeCss, type CssToken, type CssTokenType } from "./cssTokens";
export {
  readGifHeaderSize, readJpegHeaderSize, readPngHeaderSize, readRasterHeaderSize, readWebpHeaderSize, sniffBinaryImageFormat,
  type HeaderPixelSize, type RasterHeaderFormat, type SniffedImageFormat
} from "./imageSniff";
export { pictureSizeLimitError } from "./pixelLimits";
