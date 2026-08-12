import fs from 'fs';
import path from 'path';

function defaultBasePath(): string {
  if (process.env.STORAGE_BASE_PATH) return process.env.STORAGE_BASE_PATH;
  // Vercel filesystem is ephemeral; keep uploads/exports under /tmp.
  if (process.env.VERCEL === '1' || process.env.VERCEL === 'true') return '/tmp/storage';
  return './storage';
}

const BASE_PATH = defaultBasePath();

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const StorageService = {
  /**
   * Save a buffer/stream to local storage.
   * Returns the relative file path stored in DB.
   */
  save(subdir: string, filename: string, data: Buffer | string): string {
    const dir = path.join(BASE_PATH, subdir);
    ensureDir(dir);
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, data);
    return path.join(subdir, filename);
  },

  /**
   * Upload an already-existing temp file (from multer) to storage.
   * Returns the relative file path stored in DB.
   */
  upload(subdir: string, filename: string, sourcePath: string): string {
    const dir = path.join(BASE_PATH, subdir);
    ensureDir(dir);
    const destPath = path.join(dir, filename);
    fs.copyFileSync(sourcePath, destPath);
    // Clean up temp file
    try { fs.unlinkSync(sourcePath); } catch { /* ignore */ }
    return path.join(subdir, filename);
  },

  /**
   * Returns the absolute path for a stored file.
   */
  getAbsolutePath(relativePath: string): string {
    return path.resolve(path.join(BASE_PATH, relativePath));
  },

  /**
   * Read a stored file as a Buffer.
   */
  read(relativePath: string): Buffer {
    const absPath = path.resolve(path.join(BASE_PATH, relativePath));
    return fs.readFileSync(absPath);
  },

  /**
   * Check if a file exists in storage.
   */
  exists(relativePath: string): boolean {
    const absPath = path.resolve(path.join(BASE_PATH, relativePath));
    return fs.existsSync(absPath);
  },

  /**
   * Delete a file from storage.
   */
  delete(relativePath: string): void {
    const absPath = path.resolve(path.join(BASE_PATH, relativePath));
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  },
};
