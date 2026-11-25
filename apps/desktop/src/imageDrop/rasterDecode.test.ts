import { describe, expect, it } from "vitest";
import { encodeWithDownscale } from "./rasterDecode";

describe("encodeWithDownscale", () => {
  it("keeps full size when the PNG fits", async () => {
    const sizes: Array<[number, number]> = [];
    const result = await encodeWithDownscale({ width: 400, height: 300 }, 1000, async (width, height) => {
      sizes.push([width, height]);
      return new Uint8Array(10);
    });
    expect(sizes).toEqual([[400, 300]]);
    expect(result).toMatchObject({ width: 400, height: 300, sourceWidth: 400, sourceHeight: 300, downscaled: false });
  });

  it("steps down until the PNG fits, treating a refused canvas as too large", async () => {
    const sizes: Array<[number, number]> = [];
    const result = await encodeWithDownscale({ width: 4000, height: 3000 }, 1_000_000, async (width, height) => {
      sizes.push([width, height]);
      if (width > 3000) return undefined;
      return new Uint8Array(width * height / 4);
    });
    expect(sizes).toEqual([[4000, 3000], [3000, 2250], [2250, 1687]]);
    expect(result).toMatchObject({ width: 2250, height: 1687, sourceWidth: 4000, sourceHeight: 3000, downscaled: true });
  });

  it("gives up rather than shrinking to nothing", async () => {
    await expect(encodeWithDownscale({ width: 64, height: 64 }, 0, async () => new Uint8Array(1)))
      .rejects.toThrow("it is still too large as PNG after scaling it down.");
  });
});
