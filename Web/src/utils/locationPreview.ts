import client from '../api/client';
import type { ApiResponse } from '../types';
import { getErrorMessage } from './errors';

import type { Point } from './locationMatching';
export type { Point } from './locationMatching';
export type GPSPreview = {
  point: Point; accuracy: number; captured_at: string; poor_accuracy: boolean;
  coordinate_system: 'GCJ-02'; converted: boolean; warning: string;
};

export async function captureLocationPreview(endpoint: string): Promise<GPSPreview> {
  if (!window.isSecureContext) throw new Error('现场定位需要HTTPS或本机localhost安全环境。请切换安全地址后重试。');
  if (!navigator.geolocation) throw new Error('浏览器不支持现场定位，可改用地图选择或手动选择。');
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }));
    const response = await client.post<ApiResponse<GPSPreview>>(endpoint, {
      latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy,
      captured_at: new Date(position.timestamp).toISOString(),
    });
    return response.data.data;
  } catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    throw new Error(code === 1 ? '定位权限被拒绝。请在浏览器站点权限中允许定位后重试。'
      : code === 2 ? '暂时无法取得当前位置，请检查设备定位服务后重试。'
        : code === 3 ? '现场定位超时（10秒），请移到信号较好的位置后重试。'
          : getErrorMessage(cause, '定位预览失败，请重试。'));
  }
}
