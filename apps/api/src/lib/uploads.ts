import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT_BY_MIME: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export class UploadError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/**
 * Section 9's write-off photo evidence. Local disk, not object storage —
 * see config.ts / DECISIONS.md for why. Filenames are always server-
 * generated (never derived from the uploaded name), so there's no path-
 * traversal surface on either write or the read-back route.
 */
export async function saveUploadedPhoto(part: { mimetype: string; toBuffer: () => Promise<Buffer> }): Promise<string> {
  if (!ALLOWED_MIME.has(part.mimetype)) throw new UploadError("unsupported_file_type");
  const buffer = await part.toBuffer();
  const ext = EXT_BY_MIME[part.mimetype];
  const filename = `${randomUUID()}.${ext}`;
  await mkdir(config.uploadDir, { recursive: true });
  await writeFile(path.join(config.uploadDir, filename), buffer);
  return filename;
}

export function resolveUploadPath(filename: string): string | null {
  // Server-generated filenames only: uuid.ext — reject anything else
  // outright rather than trying to sanitize a path.
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(filename)) return null;
  return path.join(config.uploadDir, filename);
}
