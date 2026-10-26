// SPDX-License-Identifier: GPL-3.0-only
// 封面 URL 归一化：App 签名接口（fqnovelpic）返回的封面是 HEIC 图，
// Chromium 不内置解码，直接展示会全部裂图。同一 novel-pic 路径在官网
// byteimg 模板（~tplv-shrink:640:0.image）下是无签名 JPEG，可换源展示。
const FQNOVELPIC_COVER = /^https?:\/\/[^/]*fqnovelpic\.com\/(novel-pic\/[^?~]+)/;

export function normalizeCoverUrl(value: unknown): string {
  const raw = String(value ?? '')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
  const match = FQNOVELPIC_COVER.exec(raw);
  return match ? `https://p6-novel.byteimg.com/${match[1]}~tplv-shrink:640:0.image` : raw;
}
