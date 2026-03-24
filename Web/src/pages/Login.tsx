import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Phone, Lock, Eye, EyeOff, Loader2, ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../api/client';
import { useAuthStore } from '../store/auth';
import type { ApiResponse, AuthResponse } from '../types';

const Login = () => {
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { addAccount, accounts } = useAuthStore();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mobile || !password) {
      toast.error('请填写手机号和密码');
      return;
    }

    setIsLoading(true);
    try {
      const response = await client.post<ApiResponse<AuthResponse>>('/auth/login', {
        mobile,
        password,
      });
      
      const { token, user } = response.data.data;
      addAccount(user, token);
      toast.success('登录成功');
      navigate('/', { replace: true });
    } catch (error: any) {
      toast.error(error.message || '登录失败，请检查账号密码');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-8 justify-center relative">
      {accounts.length > 0 && (
        <button 
          onClick={() => navigate(-1)}
          className="absolute top-[calc(var(--spacing)*4.5+var(--sat))] left-2 p-2 text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-all"
        >
          <ChevronLeft size={24} />
        </button>
      )}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full"
      >
        <div className="mb-12 text-center">
          <div className="inline-flex items-center justify-center w-22 h-22 bg-[rgb(255,250,251)] text-white rounded-2xl shadow-lg mb-4 overflow-hidden p-1.5">
            <img src="/favicon.jpg" alt="Logo" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">学不通 2.0</h1>
          <p className="text-slate-500">一人签到，全寝睡觉</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700 ml-1">手机号</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Phone size={18} />
              </div>
              <input
                type="tel"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="学习通绑定手机号"
                className="block w-full pl-10 pr-3 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
                autoComplete="username"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700 ml-1">密码</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock size={18} />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="学习通密码"
                className="block w-full pl-10 pr-10 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <motion.button
            whileTap={{ scale: 0.92 }}
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center py-4 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-lg shadow-blue-200 transition-all disabled:opacity-70 disabled:active:scale-100"
          >
            {isLoading ? (
              <Loader2 className="animate-spin mr-2" size={20} />
            ) : (
              '登录 / 注册'
            )}
          </motion.button>
        </form>

        <div className="mt-12 text-center text-slate-400 text-xs">
          <p>注册即代表同意本网站收集您的第三方网站隐私信息。其中包括:
        姓名，手机号，密码，课程信息等。您的密码将仅用于登录第三方网站。</p>
        </div>
      </motion.div>
    </div>
  );
};

export default Login;
