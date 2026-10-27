// SPDX-License-Identifier: GPL-3.0-only
// 匿名播放设备注册：视频接口（multi_video_model）上游已改为要求注册设备身份，
// 随机合成 device_id 一律 200+0 字节拒答，稳定未注册 ID 返回 code=110001。
// 注册流程（ttEncrypt KDF/载荷）移植自 jackotom/hongguo-drama
// src/native/playback-device.js（GPL-3.0-only），其上游为
// tsukiyo-zero/hongguoTV DeviceRegister.kt。身份仅存进程内，失败不重试以免刷设备。
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';

const REGISTER_URL = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const REGISTER_UA = 'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)';
const KDF_SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');

export interface PlaybackIdentity { device_id: string; iid: string; cdid: string }

type RequestJson = (url: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | null }, deadline: number, signal: AbortSignal) => Promise<any>;

function responseId(response: any, name: string): string {
  const preferred = response?.[`${name}_str`];
  const value = preferred === undefined || preferred === null || preferred === '' ? response?.[name] : preferred;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : '';
}

let registration: Promise<PlaybackIdentity> | null = null;

export function getPlaybackDevice(requestJson: RequestJson): Promise<PlaybackIdentity> {
  // 失败的 Promise 同样缓存：预取与重试不得反复创建匿名设备
  registration ||= Promise.resolve().then(async () => {
    try {
      const now = Date.now();
      const cdid = crypto.randomUUID();
      const header = {
        display_name: '红果免费短剧', update_version_code: 73932, manifest_version_code: 73932,
        app_version_minor: '7.3.9.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
        app_version: '7.3.9.32', version_code: 73932, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
        sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: '16', os_api: 36,
        device_model: '25053RT47C', device_brand: 'Redmi', device_manufacturer: 'Redmi',
        cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: 520, display_density: 'mdpi',
        resolution: '1280x2772', language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
        carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
        rom_version: 'W528JS release-keys', cdid,
        sig_hash: '56a962410c494bbaf0b58dba20cae56f', openudid: crypto.randomBytes(8).toString('hex'),
        clientudid: crypto.randomUUID(), ipv6_list: [] as string[], region: 'CN', tz_name: 'Asia/Shanghai',
        tz_offset: 28800, sim_region: 'cn', sim_serial_number: [] as string[], oaid_may_support: false,
        req_id: crypto.randomUUID(), device_platform: 'android',
        custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' }, pre_installed_channel: '',
        apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
      };
      const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
      const random = crypto.randomBytes(32);
      const derived = crypto.createHash('sha512').update(Buffer.concat([
        crypto.createHash('sha512').update(random).digest(), KDF_SALT,
      ])).digest();
      const cipher = crypto.createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
      const plaintext = Buffer.concat([crypto.createHash('sha512').update(compressed).digest(), compressed]);
      const data = Buffer.concat([Buffer.from('746305100000', 'hex'), random, cipher.update(plaintext), cipher.final()]);
      const response = await requestJson(REGISTER_URL, {
        method: 'POST',
        headers: {
          'User-Agent': REGISTER_UA,
          Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
          'log-encode-type': 'gzip', 'x-ss-dp': '8662', 'x-ss-req-ticket': String(now),
          'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
          'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
          'x-ss-stub': crypto.createHash('md5').update(data).digest('hex').toUpperCase(),
        },
        body: data,
      }, Date.now() + 8000, AbortSignal.timeout(8000));
      const device_id = responseId(response, 'device_id');
      const iid = responseId(response, 'install_id');
      if (!device_id || !iid || Number(response?.code ?? response?.Code ?? 0) !== 0) throw new Error('Invalid registration');
      return Object.freeze({ device_id, iid, cdid });
    } catch (_) {
      throw Object.assign(new Error('匿名播放设备注册失败，请重启应用后重试'), { code: 'DEVICE_REGISTRATION_FAILED' });
    }
  });
  return registration;
}
