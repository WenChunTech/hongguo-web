// SPDX-License-Identifier: GPL-3.0-only
// 官网/媒体地址公网校验。Ported from hongguo-drama src/native/web-media-guard.js。
// Web 版（Bun fetch）无法逐 socket 挂 lookup 钩子，这里保留主机名/字面量级别的
// 校验 + 请求前 DNS 解析预检；逐跳重定向校验由调用方在跟随重定向时执行。
import { isIP } from 'node:net';
import dns from 'node:dns';

const blockedV4: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]];

function ipToLong(address: string) {
  return address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isPrivateV4(address: string) {
  const value = ipToLong(address);
  return blockedV4.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (ipToLong(base) & mask);
  });
}

function isPrivateV6(address: string) {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^2001:db8:/i.test(lower) || /^2001:0?0?0?0?:/i.test(lower) && /^2001::/i.test(lower)) return true;
  if (/^2002:/i.test(lower)) return true; // 6to4 可能内嵌私网地址，按桌面端策略整体排除
  // ::ffff:x.y.z.w 映射地址
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !isPrivateV4(address);
  if (family === 6) return !isPrivateV6(address);
  return false;
}

export function isPublicMediaUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (isIP(host)) return isPublicAddress(host);
    return host.includes('.') && !/(^|\.)(localhost|local|internal|lan|home)$/.test(host);
  } catch {
    return false;
  }
}

export function blockedAddress() {
  return Object.assign(new Error('官网片源及其跳转、解析结果必须指向公网'), { code: 'ERR_WEB_MEDIA_ADDRESS', mediaRetryable: true });
}

/** 请求前预检：主机名解析出的地址必须全部为公网（Fake-IP 198.18/19 视为 VPN 特征放行给 DoH 上层处理）。 */
export async function assertPublicHost(href: string) {
  const url = new URL(href);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw blockedAddress();
    return;
  }
  try {
    const addresses = await dns.promises.lookup(host, { all: true });
    if (!addresses.length) throw blockedAddress();
    const fakeOnly = addresses.every((item) => item.family === 4 && /^198\.(18|19)\./.test(item.address));
    if (!fakeOnly && addresses.some((item) => !isPublicAddress(item.address))) throw blockedAddress();
  } catch (error: any) {
    if (error?.code === 'ERR_WEB_MEDIA_ADDRESS') throw error;
    // 解析失败交给后续 fetch 报网络错误
  }
}
