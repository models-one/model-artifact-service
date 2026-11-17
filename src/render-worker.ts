import { initWasm, Resvg } from "@resvg/resvg-wasm";

// Untrusted SVG never runs as JavaScript. This WASM module has no WASI resource
// access, and we deliberately do not implement imagesToResolve/resolveImage.
try {
  const { svg, width } = JSON.parse(await Bun.stdin.text()) as {
    svg: string;
    width: number;
  };
  await initWasm(
    await Bun.file(
      new URL(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm")),
    ).arrayBuffer(),
  );
  const fontPath = new URL("../assets/NotoSans-Regular.ttf", import.meta.url);
  const font = new Uint8Array(await Bun.file(fontPath).arrayBuffer());
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontBuffers: [font], defaultFontFamily: "Noto Sans" },
  });
  try {
    // Resvg.width/height describe the source viewport, not fitTo's output.
    // Ceil is a conservative upper bound on the renderer's pixel rounding.
    const outputWidth = width;
    const outputHeight = Math.max(
      1,
      Math.ceil(renderer.height * (width / renderer.width)),
    );
    if (
      !Number.isFinite(renderer.width) ||
      !Number.isFinite(renderer.height) ||
      renderer.width <= 0 ||
      renderer.height <= 0 ||
      !Number.isInteger(outputWidth) ||
      !Number.isFinite(outputHeight) ||
      outputWidth <= 0 ||
      outputWidth > 4096 ||
      outputHeight > 4096 ||
      outputWidth * outputHeight > 4_194_304
    ) {
      throw new Error(
        `Preview dimensions exceed limits: ${outputWidth} × ${outputHeight} (source ${renderer.width} × ${renderer.height})`,
      );
    }
    const image = renderer.render();
    try {
      if (image.width !== outputWidth || image.height > outputHeight) {
        throw new Error(
          `Renderer returned unexpected dimensions: ${image.width} × ${image.height}`,
        );
      }
      await Bun.write(Bun.stdout, image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
} catch (error) {
  console.error(
    JSON.stringify({
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exitCode = 1;
}
