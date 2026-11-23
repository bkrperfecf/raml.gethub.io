import JSZip from 'jszip';
import type { Result } from './modularize';

/** Package every generated file inside a single named root folder. 100% in-browser. */
export async function buildZip(result: Result, onProgress?: (percent: number) => void): Promise<Blob> {
  const zip = new JSZip();
  const root = zip.folder(result.rootName)!;
  for (const f of result.files) root.file(f.path, f.content, { createFolders: true });
  return zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' },
    (m) => onProgress?.(m.percent),
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
