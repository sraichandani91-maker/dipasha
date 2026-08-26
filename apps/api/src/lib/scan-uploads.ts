import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/**
 * Section 6.3, Stage 1 capture — "Web: file upload — PDF, JPG, PNG."
 * Same local-disk pattern as write-off photos (`lib/uploads.ts`), one
 * step wider on allowed types. "Store the original image or PDF
 * permanently, linked to the purchase record — this is your audit
 * evidence," so nothing here ever deletes a page file, even once its
 * scan is committed or abandoned.
 */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const EXT_BY_MIME: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
export const CONTENT_TYPE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

export class ScanUploadError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function saveScanPage(part: { mimetype: string; toBuffer: () => Promise<Buffer> }): Promise<{ filename: string; mimeType: string; buffer: Buffer }> {
  if (!ALLOWED_MIME.has(part.mimetype)) throw new ScanUploadError("unsupported_file_type");
  const buffer = await part.toBuffer();
  const ext = EXT_BY_MIME[part.mimetype];
  const filename = `${randomUUID()}.${ext}`;
  await mkdir(config.uploadDir, { recursive: true });
  await writeFile(path.join(config.uploadDir, filename), buffer);
  return { filename, mimeType: part.mimetype, buffer };
}

export function resolveScanPagePath(filename: string): string | null {
  // Server-generated filenames only: uuid.ext — same no-path-traversal
  // reasoning as lib/uploads.ts.
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/i.test(filename)) return null;
  return path.join(config.uploadDir, filename);
}
