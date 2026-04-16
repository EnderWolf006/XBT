import axios from 'axios';
import type { ApiResponse } from '../types';
import { useAuthStore } from '../store/auth';
import config from '../../config.yaml';

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || config.api?.base_url || '/api',
  timeout: config.api?.timeout || 10000,
});

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => {
    const res = response.data as ApiResponse<any>;
    if (res.code !== 0) {
      return Promise.reject(new Error(res.message || '操作失败'));
    }
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
      return Promise.reject(new Error(error.response?.data?.message || '登录已失效，请重新登录'));
    }
    if (error.response?.data?.message) {
      return Promise.reject(new Error(error.response.data.message));
    }
    return Promise.reject(error);
  }
);

export default client;
