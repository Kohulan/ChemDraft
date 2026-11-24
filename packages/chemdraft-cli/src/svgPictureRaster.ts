import { Resvg } from "@resvg/resvg-js";
import type { SvgPictureRasterRequest } from "@chemdraft/export-engine/pdf";

/**
 * The headless `rasterizeSvgPicture` hook for PDF export: the same stretched-to-frame drawing the canvas
 * does, rendered by resvg. The picture is untrusted, and resvg would read an `href` that names a file on
 * this machine, so anything that is not inline data is refused before it is rendered.
 */

const MAX_NESTING = 4;
const MAX_RENDER_SIDE = 8192;
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;

export function rasterizeSvgPictureWithResvg(request: SvgPictureRasterRequest): Promise<Uint8Array> {
  // Run inside the promise so a refusal rejects, as the hook contract says, rather than throwing synchronously.
  return new Promise((resolve) => {
    assertInlineOnly(request.svg, 0);
    const { pixelWidth, pixelHeight } = request;
    // resvg-js does not draw an image nested inside an SVG that is itself nested as an image, so render the
    // picture directly, at its own aspect and large enough to cover the frame on both axes...
    const intrinsic = new Resvg(request.svg);
    const scale = Math.min(Math.max(pixelWidth / intrinsic.width, pixelHeight / intrinsic.height),
      MAX_RENDER_SIDE / Math.max(intrinsic.width, intrinsic.height));
    const rendered = new Resvg(request.svg, { fitTo: { mode: "width", value: Math.max(1, Math.round(intrinsic.width * scale)) } })
      .render().asPng();
    // ...then stretch that to the frame (preserveAspectRatio="none"), as the canvas does.
    const href = `data:image/png;base64,${Buffer.from(rendered).toString("base64")}`;
    const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${pixelWidth} ${pixelHeight}">` +
      `<image x="0" y="0" width="${pixelWidth}" height="${pixelHeight}" preserveAspectRatio="none" href="${href}"/></svg>`;
    resolve(new Uint8Array(new Resvg(wrapper).render().asPng()));
  });
}

/** Every reference must be a fragment or inline image data; inline SVG data is checked the same way. */
function assertInlineOnly(svg: string, depth: number): void {
  if (depth > MAX_NESTING) throw new Error("the SVG nests pictures too deeply");
  for (const match of svg.matchAll(/(?:^|[\s"'])(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (value.startsWith("#")) continue;
    if (!INLINE_IMAGE.test(value)) throw new Error("the SVG refers to a file or address outside the picture");
    if (/^data:image\/svg\+xml/i.test(value)) assertInlineOnly(decodeDataSvg(value), depth + 1);
  }
  if (/@import\b/i.test(svg) || /url\s*\(\s*(?!["']?\s*#)/i.test(svg)) {
    throw new Error("the SVG refers to a file or address outside the picture");
  }
}

function decodeDataSvg(value: string): string {
  const comma = value.indexOf(",");
  const body = value.slice(comma + 1);
  try {
    return /;base64/i.test(value.slice(0, comma)) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  } catch {
    throw new Error("the SVG has inline picture data that can't be read");
  }
}
