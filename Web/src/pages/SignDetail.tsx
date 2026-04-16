import { useEffect, useState, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ChevronLeft, 
  Users, 
  MapPin, 
  QrCode, 
  CheckCircle2, 
  Circle,
  Loader2,
  BookOpen,
  User,
  Fingerprint,
  RectangleEllipsis
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../api/client';
import { useAuthStore } from '../store/auth';
import type { ApiResponse, Classmate, SignActivity, CourseActivities, SignStatusMessage, SignCheckItem } from '../types';
import config from '../../config.yaml';

// Import refactored components
import { GestureInput } from '../components/sign/GestureInput';
import { PinInput } from '../components/sign/PinInput';
import { LocationInput } from '../components/sign/LocationInput';
import { QrInput } from '../components/sign/QrInput';
import { NormalInput } from '../components/sign/NormalInput';
import { ProgressCard } from '../components/sign/ProgressCard';

const LOCATION_PRESETS = config.sign?.location_presets || [];

const SignDetail = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user: currentUser } = useAuthStore();
  
  const activity = location.state?.activity as SignActivity;
  const course = location.state?.course as CourseActivities;

  const [classmates, setClassmates] = useState<Classmate[]>([]);
  const [selectedUids, setSelectedUids] = useState<number[]>([]);
  const [isLoadingClassmates, setIsLoadingClassmates] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  
  const [signCode, setSignCode] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locationStr, setLocationStr] = useState('');
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);
  
  const [showProgress, setShowProgress] = useState(false);
  const [signStatuses, setSignStatuses] = useState<Record<number, Partial<SignStatusMessage>>>({});
  const [classmateSignStates, setClassmateSignStates] = useState<Record<number, SignCheckItem>>({});
  
  const isExecutingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Lock scroll when progress modal is open
  useEffect(() => {
    if (showProgress) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      // Cancel execution when progress modal is closed
      if (isExecutingRef.current) {
        isExecutingRef.current = false;
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsExecuting(false);
      }
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showProgress]);

  const sortedClassmates = useMemo(() => {
    if (!currentUser) return classmates;
    return [...classmates].sort((a, b) => {
      if (a.uid === currentUser.uid) return -1;
      if (b.uid === currentUser.uid) return 1;
      return 0;
    });
  }, [classmates, currentUser]);

  const getSignStateLabel = (source: number, name: string) => {
    if (source === -1) return '学习通签到';
    if (source === currentUser?.uid) return '本人签到';
    return `${name}代签`;
  };

  const loadClassmateSignStates = async (students: Classmate[]) => {
    if (!activity || students.length === 0) {
      setClassmateSignStates({});
      return;
    }

    const response = await client.post<ApiResponse<{ items: SignCheckItem[] }>>('/sign/check', {
      activity_id: activity.active_id,
      user_ids: students.map((student) => student.uid),
    });

    const nextStates = response.data.data.items.reduce<Record<number, SignCheckItem>>((acc, item) => {
      if (item.user_id !== currentUser?.uid) {
        acc[item.user_id] = item;
      }
      return acc;
    }, {});

    setClassmateSignStates(nextStates);
  };

  useEffect(() => {
    if (!activity) {
      navigate('/');
      return;
    }
    const fetchClassmates = async () => {
      try {
        const response = await client.get<ApiResponse<Classmate[]>>(`/sign/classmates`, {
          params: { course_id: activity.course_id, class_id: activity.class_id }
        });
        const data = response.data.data || [];
        setClassmates(data);
        setSelectedUids(data.map(c => c.uid));
        await loadClassmateSignStates(data);
      } catch (error: any) {
        toast.error(error.message || '获取同学列表失败');
      } finally {
        setIsLoadingClassmates(false);
      }
    };
    fetchClassmates();
  }, [activity, navigate]);

  const toggleClassmate = (uid: number) => {
    setSelectedUids(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]);
  };

  const selectAll = () => {
    if (!classmates) return;
    setSelectedUids(selectedUids.length === classmates.length ? [] : classmates.map(c => c.uid));
  };

  const handleExecute = async () => {
    if ((activity.sign_type === 3 || activity.sign_type === 5) && (!signCode || signCode.length < 4)) {
      toast.error('请输入正确位数的签到码 / 手势');
      return;
    }

    if (activity.sign_type === 4 && (!lat || !lng)) {
      toast.error('请先选择签到地点');
      return;
    }

    setIsExecuting(true);
    isExecutingRef.current = true;
    setShowProgress(true);
    setSignStatuses({});

    abortControllerRef.current = new AbortController();

    const targetUids = [currentUser?.uid, ...selectedUids].filter(Boolean) as number[];
    const initialStatuses: Record<number, any> = {};
    targetUids.forEach(uid => initialStatuses[uid] = { status: 'pending', message: '等待中' });
    setSignStatuses(initialStatuses);

    try {
      const checkResp = await client.post<ApiResponse<{ items: any[] }>>('/sign/check', {
        activity_id: activity.active_id,
        user_ids: selectedUids
      });

      const checkItems = checkResp.data.data.items as SignCheckItem[];
      setClassmateSignStates(prev => {
        const next = { ...prev };
        checkItems.forEach(item => {
          if (item.user_id !== currentUser?.uid) {
            next[item.user_id] = item;
          }
        });
        return next;
      });
      const signedUids = new Set(checkItems.filter(item => item.signed).map(item => item.user_id));
      
      checkItems.forEach(item => {
        if (item.signed) {
          setSignStatuses(prev => ({ ...prev, [item.user_id]: { status: 'success', message: item.message || '已签到' } }));
        }
      });

      const toSignUids = targetUids.filter(uid => !signedUids.has(uid));
      if (toSignUids.length === 0) {
        toast.success('所有用户均已签到');
        setIsExecuting(false);
        return;
      }

      // 2. Concurrent execution with Retry Logic (5 times)
      await Promise.all(toSignUids.map(async (uid) => {
        const MAX_RETRIES = 5;
        let lastError = '';
        
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (!isExecutingRef.current) return;

          setSignStatuses(prev => ({ 
            ...prev, 
            [uid]: { 
              ...prev[uid],
              status: attempt === 0 ? 'signing' : 'retrying', 
              attempt, 
              message: attempt === 0 ? '正在尝试签到' : (prev[uid]?.message || '正在重试')
            } 
          }));

          try {
            const special_params: Record<string, any> = {};
            if (activity.sign_type === 3 || activity.sign_type === 5) special_params.sign_code = signCode;
            else if (activity.sign_type === 4) {
              special_params.latitude = lat;
              special_params.longitude = lng;
              special_params.description = locationStr;
            }


            const execResp = await client.post<ApiResponse<any>>('/sign/execute', {
              activity_id: activity.active_id, target_uid: uid, sign_type: activity.sign_type,
              course_id: activity.course_id, class_id: activity.class_id, if_refresh_ewm: activity.if_refresh_ewm,
              special_params
            }, {
              signal: abortControllerRef.current?.signal
            });

            const res = execResp.data.data;
            if (res.success || res.already_signed) {
              if (uid !== currentUser?.uid) {
                setClassmateSignStates(prev => ({
                  ...prev,
                  [uid]: {
                    user_id: uid,
                    signed: true,
                    record_source: res.record_source,
                    record_source_name: res.record_source_name,
                    message: res.message || '已签到',
                  },
                }));
              }
              setSignStatuses(prev => ({ ...prev, [uid]: { status: 'success', message: res.message || '签到成功' } }));
              return;
            }
            lastError = res.message || '签到失败';
            setSignStatuses(prev => ({ ...prev, [uid]: { ...prev[uid], message: lastError } }));
          } catch (err: any) {
            if (err.name === 'CanceledError' || err.name === 'AbortError') return;
            lastError = err.message || '网络连接异常';
            setSignStatuses(prev => ({ ...prev, [uid]: { ...prev[uid], message: lastError } }));
          }

          if (attempt < MAX_RETRIES) {
            let delay = 0;
            if (attempt === 2) delay = 1000;
            else if (attempt >= 3) delay = 2000;
            if (delay > 0) {
              for (let i = 0; i < delay; i += 100) {
                if (!isExecutingRef.current) return;
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
          } else {
            // All retries exhausted
            setSignStatuses(prev => ({ 
              ...prev, 
              [uid]: { 
                status: 'failed', 
                message: lastError || '多次重试后失败' 
              } 
            }));
          }
        }
      }));
    } catch (error: any) {
      if (error.name !== 'CanceledError' && error.name !== 'AbortError') {
        toast.error(error.message || '执行过程出错');
      }
    } finally {
      if (isExecutingRef.current) {
        setIsExecuting(false);
        isExecutingRef.current = false;
        abortControllerRef.current = null;
      }
    }
  };

  if (!activity) return null;

  const getSignTypeName = () => {
    switch (activity.sign_type) {
      case 0: return '普通签到';
      case 2: return '二维码签到';
      case 3: return '手势签到';
      case 4: return '位置签到';
      case 5: return '签到码签到';
      default: return '其他签到';
    }
  };

  const getSignIcon = (size: number = 24) => {
    switch (activity.sign_type) {
      case 2: return <QrCode size={size} />;
      case 3: return <Fingerprint size={size} />;
      case 4: return <MapPin size={size} />;
      case 5: return <RectangleEllipsis size={size} />;
      default: return <CheckCircle2 size={size} />;
    }
  };

  const isEnded = Date.now() > activity.end_time;
  const formatSmartTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toTimeString().split(' ')[0];
    if (isToday) return timeStr;
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${timeStr}`;
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-slate-50">
      {/* AppBar */}
      <div className="bg-white sticky top-0 z-10 border-b border-slate-100 px-4 h-[calc(80px+var(--sat))] pt-[var(--sat)] flex items-center shrink-0 overflow-hidden">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors relative z-10">
          <ChevronLeft size={24} />
        </button>
        <div className="ml-2 flex-1 min-w-0 relative z-10">
          <h2 className="font-bold text-slate-900 truncate">{getSignTypeName()}</h2>
          <p className="text-[10px] font-medium text-slate-400 truncate tracking-wide">{activity.course_name}</p>
        </div>
        <div className="absolute -right-8 -bottom-4 text-blue-600/10 pointer-events-none transform rotate-12">
          {getSignIcon(120)}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto touch-pan-y px-6 py-4 space-y-5 custom-scrollbar pb-[calc(40px+var(--sab))]">
        {/* Activity Briefing */}
        <div className="flex items-center justify-between px-1 mt-1">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 bg-slate-100 rounded-2xl overflow-hidden shrink-0 shadow-sm border border-white">
              {course?.icon ? <img src={course.icon} className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : <div className="w-full h-full flex items-center justify-center text-slate-300"><BookOpen size={24} /></div>}
            </div>
            <div className="space-y-0.5 min-w-0">
              <h2 className="text-lg font-black text-slate-900 tracking-tight truncate leading-tight">{activity.activity_name}</h2>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-bold truncate">
                <User size={12} className="text-slate-400 shrink-0" />
                <span>{course?.course_teacher || activity.course_teacher || '未知'}</span>
              </div>
            </div>
          </div>
          <div className="text-right shrink-0 ml-4">
            <div className={`text-sm font-black px-2.5 py-0.5 rounded-lg inline-block shadow-sm ${isEnded ? 'bg-slate-100 text-slate-400' : 'bg-blue-50 text-blue-600 shadow-blue-200'}`}>
              {isEnded ? '已结束' : '进行中'}
            </div>
            <p className="text-[10px] text-slate-400 font-mono font-bold tracking-tighter mt-0.5">
              {formatSmartTime(activity.end_time)} 截止
            </p>
          </div>
        </div>

        {/* Integrated Panel */}
        <div className="bg-white rounded-[2rem] shadow-xl shadow-blue-900/5 border border-slate-100 overflow-hidden flex flex-col">
          <div className="p-5 pb-4">
            {activity.sign_type === 3 && <GestureInput value={signCode} onChange={setSignCode} />}
            {activity.sign_type === 5 && <PinInput value={signCode} onChange={setSignCode} />}
            {activity.sign_type === 4 && <LocationInput name={LOCATION_PRESETS.find((p: any) => p.lat === lat)?.name || ''} description={locationStr} onOpen={() => setIsLocationPickerOpen(true)} />}
            {activity.sign_type === 2 && <QrInput />}
            {activity.sign_type === 0 && <NormalInput />}
          </div>

          <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 mt-auto shrink-0">
            <button 
              onClick={activity.sign_type === 2 ? () => navigate('/scanner', { state: { activity, course, selectedUids, classmates } }) : handleExecute}
              disabled={isExecuting}
              className={`w-full py-3.5 rounded-xl font-bold text-sm shadow-lg transition-all active:scale-[0.97] flex items-center justify-center gap-3 ${isExecuting ? 'bg-blue-400 text-white shadow-none' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-100'}`}
            >
              {isExecuting ? <Loader2 className="animate-spin" size={18} /> : (activity.sign_type === 2 ? <><QrCode size={18} /> 去扫码签到</> : (selectedUids.length > 0 ? `签到 (${selectedUids.length + 1})` : "签到"))}
            </button>
          </div>
        </div>

        {/* Classmate Selection List */}
        <div className="space-y-4 pt-1">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Users size={16} className="text-slate-800" />
              <h3 className="font-bold text-sm text-slate-800">代他人签到</h3>
              <span className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-bold">{selectedUids.length}/{classmates.length}</span>
            </div>
            <button onClick={selectAll} className="text-[11px] font-bold text-blue-600 hover:text-blue-700 transition-colors">
              {selectedUids.length === classmates.length ? '取消全选' : '全选'}
            </button>
          </div>
          {isLoadingClassmates ? (<div className="space-y-2">{[1, 2].map(i => <div key={i} className="h-16 bg-white rounded-[1.25rem] animate-pulse border border-slate-100" />)}</div>) : (
            <div className="grid grid-cols-1 gap-2.5">
              {sortedClassmates.map(student => (
                <div key={student.uid} onClick={() => toggleClassmate(student.uid)} className={`p-3 px-4 rounded-[1.25rem] border-2 transition-all flex items-center justify-between cursor-pointer active:scale-[0.98] ${selectedUids.includes(student.uid) ? 'border-blue-500 bg-blue-50/30' : 'border-slate-50 bg-white hover:border-slate-100 shadow-sm'}`}>
                  <div className="flex items-center gap-4">
                    <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-lg transition-colors shrink-0 overflow-hidden ${selectedUids.includes(student.uid) ? 'bg-blue-600' : 'bg-slate-400'}`}>
                      {student.avatar ? <img src={student.avatar} referrerPolicy="no-referrer" className="w-full h-full object-cover" /> : student.name[0]}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-0.5 min-w-0">
                        <p className="font-bold text-base text-slate-800 leading-tight truncate">{student.name}</p>
                        {classmateSignStates[student.uid]?.signed && (
                          <span className="max-w-[140px] truncate text-[10px] px-1.5 py-0.5 rounded-md font-medium shrink-0 bg-green-100 text-green-700" title={getSignStateLabel(classmateSignStates[student.uid].record_source, classmateSignStates[student.uid].record_source_name)}>
                            {getSignStateLabel(classmateSignStates[student.uid].record_source, classmateSignStates[student.uid].record_source_name)}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 font-mono font-bold tracking-tighter">{student.mobile_masked}</p>
                    </div>
                  </div>
                  <div className={`transition-all shrink-0 ${selectedUids.includes(student.uid) ? 'text-blue-600' : 'text-slate-200'}`}>{selectedUids.includes(student.uid) ? <CheckCircle2 size={24} /> : <Circle size={24} />}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {isLocationPickerOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-md p-0" onClick={() => setIsLocationPickerOpen(false)}>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 250 }} className="bg-white w-full max-w-[480px] rounded-t-[3rem] p-8 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
              <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-8 shrink-0" />
              <div className="flex items-center justify-between mb-6 shrink-0"><h3 className="text-xl font-bold text-slate-900">选择签到位置</h3><button onClick={() => setIsLocationPickerOpen(false)} className="w-8 h-8 flex items-center justify-center bg-slate-100 text-slate-400 rounded-full">✕</button></div>
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-[calc(40px+var(--sab))] custom-scrollbar px-1">{LOCATION_PRESETS.map((p: any, i: number) => {
                const isSelected = p.lat === lat && p.lng === lng;
                return (
                  <motion.div key={i} whileTap={{ scale: 0.98 }} onClick={() => { setLat(p.lat); setLng(p.lng); setLocationStr(p.description); setIsLocationPickerOpen(false); }} className={`p-5 rounded-[1.5rem] border-2 transition-all cursor-pointer flex items-center justify-between ${isSelected ? 'border-blue-500 bg-blue-50/30' : 'border-slate-50 bg-slate-50/50 hover:bg-white'}`}>
                    <div className="flex-1 min-w-0 pr-4"><div className="font-bold text-slate-800 mb-0.5 text-sm">{p.name}</div><div className="text-[10px] text-slate-400 font-medium truncate">{p.description}</div></div>
                    {isSelected && <CheckCircle2 size={20} className="text-blue-600 shrink-0" />}
                  </motion.div>
                );
              })}</div>
            </motion.div>
          </motion.div>
        )}
        {showProgress && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[60] flex items-end justify-center p-0 bg-slate-900/60 backdrop-blur-md" onClick={() => setShowProgress(false)}>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} className="bg-white w-full max-w-[480px] rounded-t-[3rem] px-8 pt-10 pb-0 shadow-2xl flex flex-col max-h-[85vh] relative" onClick={(e) => e.stopPropagation()}>
              <div className="absolute top-full left-0 right-0 h-screen bg-white" />
              <div className="flex items-center justify-between mb-8 shrink-0"><h3 className="text-xl font-bold text-slate-900">执行进度</h3><button onClick={() => setShowProgress(false)} className="w-10 h-10 flex items-center justify-center bg-slate-50 text-slate-400 rounded-full font-bold">✕</button></div>
              <div className="flex-1 overflow-y-auto space-y-1 pr-2 custom-scrollbar pb-[calc(40px+var(--sab))]">
                <ProgressCard name={currentUser?.name || "本人"} avatar={currentUser?.avatar} mobile={currentUser?.mobile || ""} isHost statusObj={signStatuses[currentUser?.uid || 0]} />
                {selectedUids.filter(uid => uid !== currentUser?.uid).map(uid => {
                  const student = classmates.find(m => m.uid === uid);
                  return <ProgressCard key={uid} name={student?.name || "未知"} avatar={student?.avatar} mobile={student?.mobile_masked || ""} statusObj={signStatuses[uid]} />;
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <style>{`.custom-scrollbar::-webkit-scrollbar { width: 0px; }`}</style>
    </div>
  );
};

export default SignDetail;
