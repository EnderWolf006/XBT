import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  ChevronLeft, 
  Plus, 
  Trash2, 
  UserPlus, 
  Upload, 
  Search,
  Shield,
  Loader2,
  X
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../api/client';
import type { ApiResponse, WhitelistItem } from '../types';

const Whitelist = () => {
  const navigate = useNavigate();
  const [list, setList] = useState<WhitelistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  
  const [newMobile, setNewMobile] = useState('');
  const [batchMobiles, setBatchMobiles] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchList = async () => {
    setIsLoading(true);
    try {
      const response = await client.get<ApiResponse<WhitelistItem[]>>('/admin/whitelist/users');
      setList(response.data.data);
    } catch (error: any) {
      toast.error(error.message || '获取白名单失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
  }, []);

  const handleAdd = async () => {
    if (!newMobile) return;
    setIsSubmitting(true);
    try {
      await client.post('/admin/whitelist/users', { mobile: newMobile });
      toast.success('已添加');
      setShowAddModal(false);
      setNewMobile('');
      fetchList();
    } catch (error: any) {
      toast.error(error.message || '添加失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBatchAdd = async () => {
    if (!batchMobiles) return;
    setIsSubmitting(true);
    try {
      await client.post('/admin/whitelist/users/import', { mobiles: batchMobiles });
      toast.success('批量同步成功');
      setShowBatchModal(false);
      setBatchMobiles('');
      fetchList();
    } catch (error: any) {
      toast.error(error.message || '导入失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number, mobile: string) => {
    if (!confirm(`确定要删除 ${mobile} 吗？`)) return;
    try {
      await client.delete(`/admin/whitelist/users/${id}`);
      toast.success('已删除');
      fetchList();
    } catch (error: any) {
      toast.error(error.message || '删除失败');
    }
  };

  const filteredList = list.filter(item => 
    item.mobile_masked.includes(search)
  );

  return (
    <div className="h-full flex flex-col bg-slate-50 relative overflow-hidden">
      <div className="bg-white sticky top-0 z-30 border-b border-slate-100 px-4 h-[calc(80px+var(--sat))] pt-[var(--sat)] flex items-center justify-between shrink-0">
        <div className="flex items-center">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-slate-600 hover:bg-slate-50 rounded-lg">
            <ChevronLeft size={24} />
          </button>
          <h2 className="ml-2 font-bold text-slate-900 text-lg">白名单管理</h2>
        </div>
        <div className="flex space-x-1">
          <motion.button 
            whileTap={{ scale: 0.92 }}
            onClick={() => setShowBatchModal(true)}
            className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg"
            title="批量导入"
          >
            <Upload size={20} />
          </motion.button>
          <motion.button 
            whileTap={{ scale: 0.92 }}
            onClick={() => setShowAddModal(true)}
            className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg"
            title="添加单个"
          >
            <Plus size={24} />
          </motion.button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-[calc(40px+var(--sab))] custom-scrollbar">
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="搜索手机号..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-3 bg-white border border-slate-100 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all shadow-sm"
          />
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-16 bg-slate-50 rounded-2xl animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredList.map((item) => (
              <div 
                key={item.id}
                className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl shadow-sm"
              >
                <div className="flex items-center space-x-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.permission >= 2 ? 'bg-orange-100 text-orange-600' : 'bg-blue-100 text-blue-600'}`}>
                    {item.permission >= 2 ? <Shield size={20} /> : <UserPlus size={20} />}
                  </div>
                  <div>
                    <div className="font-bold text-slate-900">{item.mobile_masked}</div>
                    <div className="text-xs text-slate-500">
                      {item.permission >= 2 ? '管理员' : '普通用户'}
                    </div>
                  </div>
                </div>
                {item.permission < 2 && (
                  <button 
                    onClick={() => handleDelete(item.id, item.mobile_masked)}
                    className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm">
          <div className="bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold">添加用户</h3>
              <button onClick={() => setShowAddModal(false)}><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-500 ml-1">手机号</label>
                <input
                  type="tel"
                  value={newMobile}
                  onChange={(e) => setNewMobile(e.target.value)}
                  className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="13800000000"
                />
              </div>
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={handleAdd}
                disabled={isSubmitting}
                className="w-full py-4 bg-blue-600 text-white font-bold rounded-2xl shadow-lg disabled:opacity-50"
              >
                {isSubmitting ? <Loader2 className="animate-spin mx-auto" /> : '确认添加'}
              </motion.button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Modal */}
      {showBatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm">
          <div className="bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold">批量导入</h3>
              <button onClick={() => setShowBatchModal(false)}><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <p className="text-xs text-slate-500">支持换行、逗号、空格分隔手机号</p>
              <textarea
                value={batchMobiles}
                onChange={(e) => setBatchMobiles(e.target.value)}
                className="w-full h-40 p-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                placeholder="13800000001&#10;13800000002,13800000003"
              />
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={handleBatchAdd}
                disabled={isSubmitting}
                className="w-full py-4 bg-blue-600 text-white font-bold rounded-2xl shadow-lg disabled:opacity-50"
              >
                {isSubmitting ? <Loader2 className="animate-spin mx-auto" /> : '开始导入'}
              </motion.button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Whitelist;
