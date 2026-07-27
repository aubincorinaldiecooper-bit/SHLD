import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredArtifact {
  storageLocation: string;
  contentHash: string;
  sizeBytes: number;
}

/**
 * Content-addressed local filesystem storage for raw engine output and
 * other restricted artifacts. Identical content (e.g. a re-run producing
 * the same DeepSec output) naturally dedupes to the same file.
 */
export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async store(content: string | Buffer, subdir = "misc"): Promise<StoredArtifact> {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const dir = path.join(this.rootDir, subdir);
    await mkdir(dir, { recursive: true });
    const storageLocation = path.join(dir, `${contentHash}.bin`);
    await writeFile(storageLocation, buffer);
    await chmod(storageLocation, 0o444).catch(() => undefined);
    return { storageLocation, contentHash, sizeBytes: buffer.length };
  }

  async read(storageLocation: string): Promise<Buffer> {
    return readFile(storageLocation);
  }
}
