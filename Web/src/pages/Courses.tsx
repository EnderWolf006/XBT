import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, RefreshCw, Check, Loader2, Book } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../api/client';
import type { ApiResponse, Course } from '../types';
import PullToRefresh from '../components/PullToRefresh';

const Courses = () => {
  const navigate = useNavigate();
  const [courses, setCourses] = useState<Course[]>([]);
  const [initialCourses, setInitialCourses] = useState<Course[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasAttemptedSync, setHasAttemptedSync] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const isDirty = JSON.stringify(courses.map(c => c.is_selected)) !== JSON.stringify(initialCourses.map(c => c.is_selected));

  const fetchCourses = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await client.get<ApiResponse<Course[]>>('/courses');
      const data = response.data.data || [];
      setCourses(data);
      setInitialCourses(JSON.parse(JSON.stringify(data)));
    } catch (error: any) {
      toast.error(error.message || '获取课程失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCourses();
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const handleBack = () => {
    if (isDirty) {
      setShowExitConfirm(true);
    } else {
      navigate(-1);
    }
  };

  useEffect(() => {
    if (!isLoading && courses && courses.length === 0 && !hasAttemptedSync && !isSyncing) {
      setHasAttemptedSync(true);
      handleSync();
    }
  }, [isLoading, courses, hasAttemptedSync, isSyncing]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await client.post('/courses/sync');
      toast.success('同步成功');
      fetchCourses();
    } catch (error: any) {
      toast.error(error.message || '同步失败');
    } finally {
      setIsSyncing(false);
    }
  };

  const toggleSelection = (classId: number) => {
    setCourses(prev => (prev || []).map(c => 
      c.class_id === classId ? { ...c, is_selected: !c.is_selected } : c
    ));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const selectedIds = (courses || [])
        .filter(c => c.is_selected)
        .map(c => c.course_id);
      
      await client.put('/courses/selection', { course_ids: selectedIds });
      toast.success('设置已保存');
      setInitialCourses(JSON.parse(JSON.stringify(courses)));
      navigate('/');
    } catch (error: any) {
      toast.error(error.message || '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-50 relative overflow-hidden">
      <div className="bg-white sticky top-0 z-30 border-b border-slate-100 px-4 h-[calc(80px+var(--sat))] pt-[var(--sat)] flex items-center justify-between shrink-0">
        <button 
          onClick={handleBack}
          className="p-2 -ml-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h2 className="font-bold text-slate-900 text-lg">我的课程</h2>
        <button 
          onClick={handleSync}
          disabled={isSyncing}
          className="p-2 -mr-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={20} className={isSyncing ? 'animate-smooth-spin' : ''} />
        </button>
      </div>

      <PullToRefresh 
        onRefresh={fetchCourses} 
        isRefreshing={isLoading}
        className="p-4"
      >
        <div className="space-y-3 pb-[calc(100px+var(--sab))]">
          <p className="text-sm text-slate-500 px-1 mb-4">
            选择你想要进行签到监控的课程。只有勾选的课程才会出现在首页活动列表中。
          </p>

          {isLoading && courses.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="h-20 bg-slate-50 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : (
            (courses || []).map((course) => (
              <motion.div
                whileTap={{ scale: 0.92 }}
                key={course.class_id}
                onClick={() => toggleSelection(course.class_id)}
                className={`p-4 rounded-2xl border cursor-pointer flex items-center space-x-4 transition-colors duration-200 ${
                  course.is_selected 
                    ? 'bg-blue-50 border-blue-200 shadow-sm' 
                    : 'bg-white border-slate-100 shadow-sm hover:border-slate-200'
                }`}
              >
                <div className="relative w-12 h-12 flex-shrink-0">
                  {course.icon ? (
                    <img src={course.icon} alt={course.name} referrerPolicy="no-referrer" className="w-full h-full rounded-xl object-cover" />
                  ) : (
                    <div className="w-full h-full bg-slate-100 rounded-xl flex items-center justify-center text-slate-400">
                      <Book size={20} />
                    </div>
                  )}
                  <AnimatePresence>
                    {course.is_selected && (
                      <motion.div 
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 500, damping: 25 }}
                        className="absolute -top-1 -right-1 bg-blue-600 text-white rounded-full p-0.5 border-2 border-white z-10"
                      >
                        <Check size={10} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`font-bold truncate transition-colors ${course.is_selected ? 'text-blue-900' : 'text-slate-900'}`}>
                    {course.name}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{course.teacher}</div>
                </div>
              </motion.div>
            ))
          )}
        </div>
      </PullToRefresh>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/80 backdrop-blur-md border-t border-slate-100 max-w-[480px] mx-auto z-30">
        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={handleSave}
          disabled={isSaving || isLoading}
          className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200 transition-all disabled:opacity-70 flex items-center justify-center"
        >
          {isSaving ? <Loader2 className="animate-spin mr-2" /> : '保存设置'}
        </motion.button>
      </div>

      {/* Exit Confirmation Modal */}
      <AnimatePresence>
        {showExitConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white w-full max-w-xs rounded-3xl p-6 shadow-2xl"
            >
              <h3 className="text-lg font-bold text-slate-900 mb-2">未保存的更改</h3>
              <p className="text-slate-500 text-sm mb-6">您有未保存的课程选择，确定要离开吗？</p>
              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => setShowExitConfirm(false)}
                  className="py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition-colors"
                >
                  取消
                </button>
                <button 
                  onClick={() => navigate(-1)}
                  className="py-3 bg-red-500 text-white font-bold rounded-xl hover:bg-red-600 transition-colors shadow-lg shadow-red-100"
                >
                  确定离开
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Courses;
