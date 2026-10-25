// SPDX-License-Identifier: GPL-3.0-only
// Ported from hongguo-drama src/native/download-quality.js
export const DOWNLOAD_QUALITIES = ['auto', '1080p', '720p'] as const;
export type DownloadQuality = (typeof DOWNLOAD_QUALITIES)[number];

export function normalizeDownloadQuality(value: string | undefined = 'auto'): DownloadQuality {
  if (!DOWNLOAD_QUALITIES.includes((value ?? 'auto') as DownloadQuality)) {
    throw new Error('下载清晰度无效，请选择自动、1080p 或 720p');
  }
  return (value ?? 'auto') as DownloadQuality;
}

export function meetsDownloadQuality(dim: { width?: number; height?: number } | undefined, quality = 'auto') {
  quality = normalizeDownloadQuality(quality);
  if (quality === 'auto') return true;
  const dimensions = [Number(dim?.width), Number(dim?.height)];
  return dimensions.every((value) => Number.isFinite(value) && value > 0)
    && Math.min(...dimensions) >= Number.parseInt(quality, 10);
}
