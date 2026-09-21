// PDF 本地文本提取：使用 unpdf（纯 JS pdf.js 封装）逐页取文本并写入 Markdown 文件。
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

export interface PDFExtractResult {
  title: string;
  content: string;
  pages: number;
  chars: number;
  outputPath: string;
}

export interface PDFExtractOptions {
  maxPages?: number;
  outputDir?: string;
  filename?: string;
}

const DEFAULT_OUTPUT_DIR = join(tmpdir(), "taropi-web-pdf");

function extractTitleFromURL(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = basename(pathname, ".pdf").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return filename || "document";
  } catch {
    return "document";
  }
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 100).replace(/^-|-$/g, "") || "document";
}

/** isPDF 根据 URL 或 Content-Type 判断是否为 PDF */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/** extractPDFToMarkdown 逐页提取 PDF 文本并写入唯一命名的 Markdown 文件，返回正文供后续问答/分页读取 */
export async function extractPDFToMarkdown(buffer: ArrayBuffer, url: string, options: PDFExtractOptions = {}): Promise<PDFExtractResult> {
  const { maxPages = 100, outputDir = DEFAULT_OUTPUT_DIR, filename } = options;
  const { getDocumentProxy } = await import("unpdf");
  const pdfjs = await import("unpdf/pdfjs");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: pdfjs.VerbosityLevel.ERRORS });

  const metadata = await pdf.getMetadata();
  const info = metadata.info && typeof metadata.info === "object" ? (metadata.info as Record<string, unknown>) : null;
  const metaTitle = typeof info?.Title === "string" ? info.Title.trim() : "";
  const title = metaTitle || extractTitleFromURL(url);

  const pagesToExtract = Math.min(pdf.numPages, Math.max(1, Math.floor(maxPages)));
  const truncated = pdf.numPages > pagesToExtract;
  const pageTexts: string[] = [];
  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: unknown) => (item as { str?: string }).str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pageTexts.push(i > 1 ? `\n<!-- Page ${i} -->\n${text}` : text);
  }

  const lines = [`# ${title}`, "", `> Source: ${url}`, `> Pages: ${pdf.numPages}${truncated ? ` (extracted first ${pagesToExtract})` : ""}`, "", "---", "", pageTexts.join("\n")];
  if (truncated) lines.push("", "---", "", `*[Truncated: Only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);
  const content = lines.join("\n");

  const outputFilename = filename || `${sanitizeFilename(title)}.md`;
  const outputPath = join(outputDir, outputFilename);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, content, "utf-8");

  return { title, content, pages: pdf.numPages, chars: content.length, outputPath };
}
