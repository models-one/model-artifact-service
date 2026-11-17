import { parse, walk } from "css-tree";
import { SaxesParser } from "saxes";
import { ServiceError } from "./errors";

const forbiddenElements = new Set([
  "script",
  "foreignobject",
  "image",
  "feimage",
  "iframe",
  "object",
  "embed",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "audio",
  "video",
]);
const cssAttributes = new Set([
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "cursor",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

function validateCss(
  source: string,
  context: "stylesheet" | "declarationList" | "value",
) {
  const ast = parse(source, {
    context,
    onParseError(error) {
      throw error;
    },
  });
  walk(ast, (node) => {
    if (
      node.type === "Atrule" ||
      node.type === "Raw" ||
      (node.type === "Url" && !/^#[\w:.-]+$/.test(node.value))
    ) {
      throw new Error(
        "CSS imports, external resources and unparsed CSS are not allowed",
      );
    }
  });
}

export function extractSvg(text: string): string {
  const start = text.search(/<svg(?=[\s>])/i);
  const endMatch = [...text.matchAll(/<\/svg\s*>/gi)].at(-1);
  if (start < 0 || !endMatch || endMatch.index < start) {
    throw new ServiceError(
      "svg_not_found",
      "Expected one complete <svg>...</svg> document in generated text",
      "extraction",
      422,
    );
  }
  const svg = text.slice(start, endMatch.index + endMatch[0].length);
  if (Buffer.byteLength(svg) > 256 * 1024) {
    throw new ServiceError(
      "svg_too_large",
      "SVG exceeds 256 KiB",
      "extraction",
      422,
    );
  }
  let depth = 0;
  let elements = 0;
  let styleDepth = 0;
  let css = "";
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new Error("DOCTYPE and external entities are not allowed");
  });
  parser.on("processinginstruction", () => {
    throw new Error("Processing instructions are not allowed");
  });
  parser.on("opentag", (tag) => {
    depth++;
    elements++;
    if (depth > 64 || elements > 10000)
      throw new Error("SVG exceeds element/depth limits");
    if (depth === 1 && tag.local !== "svg") throw new Error("Root must be svg");
    if (tag.uri && tag.uri !== "http://www.w3.org/2000/svg")
      throw new Error(`Unsupported namespace on ${tag.name}`);
    if (forbiddenElements.has(tag.local.toLowerCase()))
      throw new Error(`Unsupported SVG element: ${tag.name}`);
    if (tag.local === "style") {
      styleDepth = depth;
      css = "";
    }
    for (const attribute of Object.values(tag.attributes)) {
      const name = attribute.local.toLowerCase();
      if (name.startsWith("on") || attribute.name === "xml:base")
        throw new Error(`Unsafe SVG attribute: ${attribute.name}`);
      if (name === "href" && !/^#[\w:.-]+$/.test(attribute.value.trim()))
        throw new Error("Only document-local href references are allowed");
      if (name === "style") validateCss(attribute.value, "declarationList");
      else if (cssAttributes.has(name)) validateCss(attribute.value, "value");
    }
  });
  parser.on("text", (text) => {
    if (styleDepth) css += text;
  });
  parser.on("cdata", (text) => {
    if (styleDepth) css += text;
  });
  parser.on("closetag", () => {
    if (depth === styleDepth) {
      validateCss(css, "stylesheet");
      styleDepth = 0;
    }
    depth--;
  });
  try {
    parser.write(svg).close();
  } catch (cause) {
    throw new ServiceError(
      "svg_rejected",
      "SVG is invalid or contains unsupported active/external content",
      "extraction",
      422,
      { line: parser.line, column: parser.column },
      cause,
    );
  }
  return svg;
}

export interface ArtifactRenderer {
  render(svg: string, width: number, signal: AbortSignal): Promise<Uint8Array>;
}

export class SvgRenderer implements ArtifactRenderer {
  async render(
    svg: string,
    width: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const extension = import.meta.path.endsWith(".ts") ? "ts" : "js";
    const worker = new URL(`./render-worker.${extension}`, import.meta.url)
      .pathname;
    const child = Bun.spawn([process.execPath, "--no-env-file", worker], {
      stdin: new Blob([JSON.stringify({ svg, width })]),
      stdout: "pipe",
      stderr: "pipe",
      // The WASM renderer gets bytes, not a filesystem/network resource resolver.
      // Never inherit service credentials into the rendering process.
      env: { TZ: "UTC" },
    });
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const [exitCode, output, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ]);
      if (signal.aborted || exitCode !== 0) {
        throw new ServiceError(
          signal.aborted ? "render_timeout" : "render_failed",
          signal.aborted
            ? "SVG rendering exceeded its time limit"
            : "SVG renderer failed",
          "rendering",
          422,
          {
            exit_code: exitCode,
            signal: child.signalCode,
            stderr: stderr.slice(0, 16000),
          },
        );
      }
      const png = new Uint8Array(output);
      if (
        png.length < 8 ||
        png.length > 20 * 1024 * 1024 ||
        Buffer.from(png.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
      ) {
        throw new ServiceError(
          "invalid_preview",
          "Renderer did not return a bounded PNG image",
          "rendering",
          500,
        );
      }
      return png;
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  }
}
