import axios from 'axios';
import type { ApiResponse } from '../types';
import { useAuthStore } from '../store/auth';
import config from '../../config.yaml';

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly queryKeywords?: string;
  constructor(message: string, status: number, details: unknown, queryKeywords?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.queryKeywords = queryKeywords;
  }
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || config.api?.base_url || '/api';

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: config.api?.timeout || 10000,
});

// 签到执行、照片上传要同步调用学习通，10 秒默认超时会被正常慢请求截断。
export const LONG_REQUEST_TIMEOUT = 60000;

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => {
    const res: ApiResponse<unknown> = response.data;
    if (res.code !== 0) {
      return Promise.reject(new Error(res.message || '操作失败'));
    }
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/#/login';
      return Promise.reject(new Error(error.response?.data?.message || '登录已失效，请重新登录'));
    }
    if (error.response?.data?.message) {
      return Promise.reject(new ApiError(error.response.data.message, error.response.status, error.response.data.data,
        typeof error.response.data.query_keywords === 'string' ? error.response.data.query_keywords : undefined));
    }
    return Promise.reject(error);
  }
);

export default client;
