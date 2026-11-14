import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import {
  User as UserIcon,
  Settings,
  ShieldCheck,
  RefreshCw,
  Clock,
  ChevronRight,
  ChevronDown,
  Activity,
  QrCode,
  MapPin,
  Camera,
  Fingerprint,
  BookOpen,
  CheckCircle2,
  RectangleEllipsis
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../api/client';
import { useAuthStore } from '../store/auth';
import { getChineseStringByDatetime } from '../utils/datetime';
import type { ApiResponse, CourseActivities } from '../types';
import PullToRefresh from '../components/PullToRefresh';
import { getErrorMessage } from '../utils/errors';
import RemoteImage from '../components/RemoteImage';
import { describeSignRules } from '../utils/signRules';

type PendingActivityEntry = {
  activity: CourseActivities['activities'][number];
  course: CourseActivities;
};

const RefreshIndicator = ({ spinning }: { spinning: boolean }) => {
  const rafRef = useRef<number | null>(null);
  const angleRef = useRef(0);
  const iconRef = useRef<SVGSVGElement>(null);
  const updateAngle = (angle: number) => {
    angleRef.current = angle;
    if (iconRef.current) iconRef.current.style.transform = `rotate(${angle}deg)`;
  };

  const stopRaf = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  useEffect(() => {
    if (spinning) {
      stopRaf();
      let last = performance.now();
      const tick = (now: number) => {
        const delta = now - last;
        last = now;
        angleRef.current = (angleRef.current + delta * 0.36) % 360;
        updateAngle(angleRef.current);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => stopRaf();
    }

    stopRaf();
    const current = ((angleRef.current % 360) + 360) % 360;
    if (current < 0.5) {
      angleRef.current = 0;
      updateAngle(0);
      return;
    }

    const remain = 360 - current;
    const duration = Math.max(140, Math.min(260, (remain / 360) * 260));
    const start = performance.now();
    const settle = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = current + remain * eased;
      angleRef.current = next % 360;
      updateAngle(angleRef.current);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(settle);
      } else {
        angleRef.current = 0;
        updateAngle(0);
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(settle);
    return () => stopRaf();
  }, [spinning]);

  useEffect(() => () => stopRaf(), []);

  return <RefreshCw ref={iconRef} size={20} />;
};

const Lobby = () => {
  const { user, activeUid } = useAuthStore();
  const navigate = useNavigate();

  // Initialize from cache if available
  const [activities, setActivities] = useState<CourseActivities[]>(() => {
    const cached = localStorage.getItem(`cached_activities_${activeUid}`);
    if (!cached) return [];
    try {
      const parsed: unknown = JSON.parse(cached);
      return Array.isArray(parsed) ? parsed as CourseActivities[] : [];
    } catch {
      localStorage.removeItem(`cached_activities_${activeUid}`);
      return [];
    }
  });

  const [isLoading, setIsLoading] = useState(false);
  const [activityError, setActivityError] = useState('');
  const fetchingRef = useRef(false);
  const [expandedCourses, setExpandedCourses] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const [pendingEntry, setPendingEntry] = useState<PendingActivityEntry | null>(null);

  // 已知活动 ID 集合：首次加载只登记不提醒，之后的差异才是"新签到"。
  const knownActivityIdsRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const playNotifySound = useCallback(() => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.18);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.55);
      window.setTimeout(() => { void ctx.close(); }, 900);
    } catch {
      // 浏览器限制自动播放时静默降级，不影响列表与 toast 提醒。
    }
  }, []);

  const flashTitle = useCallback(() => {
    const original = document.title;
    if (original.startsWith('● ')) return;
    document.title = '● 新签到';
    window.setTimeout(() => {
      document.title = original.replace(/^● /, '');
    }, 12000);
  }, []);

  const noticeNewActivities = useCallback((data: CourseActivities[]) => {
    const nowMs = Date.now();
    const currentIds = new Set<number>();
    const fresh: PendingActivityEntry[] = [];

    data.forEach((course) => {
      course.activities.forEach((activity) => {
        currentIds.add(activity.active_id);
        if (knownActivityIdsRef.current && !knownActivityIdsRef.current.has(activity.active_id)
          && !activity.record_source_name && activity.end_time > nowMs) {
          fresh.push({ activity, course });
        }
      });
    });

    knownActivityIdsRef.current = currentIds;
    if (fresh.length === 0) return;

    fresh.sort((a, b) => b.activity.start_time - a.activity.start_time);
    fresh.forEach(({ activity, course }) => {
      toast.success(
        `新签到：${course.course_name} · ${activity.activity_name}（${describeSignRules(activity)}）${activity.need_face ? '｜需在学习通 App 完成人脸验证' : ''}`,
        { id: `new-activity-${activity.active_id}`, duration: 10000 },
      );
    });
    playNotifySound();
    flashTitle();
    if (fresh.length > 1) {
      toast(`共 ${fresh.length} 条新签到，下拉列表查看`, { icon: '🔔', duration: 8000, id: 'new-activity-summary' });
    }
  }, [flashTitle, playNotifySound]);

  const fetchActivities = useCallback(async (options?: { silent?: boolean; force?: boolean }) => {
    // Prevent multiple requests if already loading
    if (fetchingRef.current) return;

    const silent = options?.silent === true;
    fetchingRef.current = true;
    if (!silent) setIsLoading(true);
    try {
      const response = await client.get<ApiResponse<CourseActivities[]>>('/sign/activities',
        options?.force ? { headers: { 'Cache-Control': 'no-cache' } } : undefined);
      if (useAuthStore.getState().activeUid !== activeUid) return;
      const data = response.data.data || [];
      setActivities(data);
      setActivityError('');

      // Update cache
      if (activeUid) {
        localStorage.setItem(`cached_activities_${activeUid}`, JSON.stringify(data));
      }
      noticeNewActivities(data);
    } catch (error) {
      if (useAuthStore.getState().activeUid !== activeUid) return;
      setActivityError(getErrorMessage(error, '活动刷新失败，当前显示上次加载结果'));
      if (!silent) toast.error(getErrorMessage(error, '获取签到活动失败'));
    } finally {
      fetchingRef.current = false;
      if (!silent) setIsLoading(false);
    }
  }, [activeUid, noticeNewActivities]);

  useEffect(() => {
    // 换账号后重新建立"已知活动"基线，避免把另一账号的活动当成新签到。
    knownActivityIdsRef.current = null;
    // Initial fetch
    fetchActivities();
  }, [fetchActivities]);

  // 后台轮询：定位/人脸签到通知时间窗口很短，仅靠进入页面拉一次会漏掉。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchActivities({ silent: true });
      }
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchActivities({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchActivities]);

  const toggleCourse = (courseId: number, classId: number) => {
    const key = `${courseId}-${classId}`;
    setExpandedCourses(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const getSignTypeIcon = (activity: CourseActivities['activities'][number]) => {
    if (activity.sign_type === 0 && activity.if_photo) return <Camera size={18} />;

    switch (activity.sign_type) {
      case 2: return <QrCode size={18} />;
      case 3: return <Fingerprint size={18} />;
      case 4: return <MapPin size={18} />;
      case 5: return <RectangleEllipsis size={18} />;
      default: return <CheckCircle2 size={18} />;
    }
  };

  const getSignState = (source: number, name: string) => {
    if (source === -1) return '学习通签到';
    if (source === user?.uid) return `本人签到`;
    return `${name}代签`;
  };

  const enterActivity = (activity: CourseActivities['activities'][number], course: CourseActivities) => {
    navigate(`/sign/${activity.active_id}`, { state: { activity, course } });
  };

  const handleActivityClick = (activity: CourseActivities['activities'][number], course: CourseActivities, shouldHighlight: boolean) => {
    if (shouldHighlight) {
      enterActivity(activity, course);
      return;
    }

    setPendingEntry({ activity, course });
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-50 relative overflow-hidden">
      {/* Header */}
      <div className="bg-white sticky top-0 z-10 border-b border-slate-100 px-4 h-[calc(80px+var(--sat))] pt-[var(--sat)] flex items-center shrink-0">
        <div className="flex items-center justify-between w-full">
          <motion.div
            whileTap={{ scale: 0.92 }}
            onClick={() => navigate('/accounts')}
            className="flex items-center space-x-3 cursor-pointer hover:opacity-80 transition-opacity"
          >
            <div className="w-12 h-12 rounded-xl bg-slate-100 overflow-hidden border-2 border-white shadow-sm">
              {user?.avatar ? (
                <RemoteImage src={user.avatar} alt={user.name} loading="eager" className="w-full h-full" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400">
                  <UserIcon size={24} />
                </div>
              )}
            </div>
            <div>
              <h2 className="font-bold text-slate-900 flex items-center">
                {user?.name || '未登录'}
                <ChevronRight size={14} className="ml-1 text-slate-400" />
              </h2>
              <p className="text-xs text-slate-500">{user?.mobile}</p>
            </div>
          </motion.div>
          <div className="flex items-center space-x-1">
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => navigate('/courses')}
              className="p-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
              title="课程配置"
            >
              <Settings size={20} />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => { void fetchActivities({ force: true }); }}
              className="p-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
              title="刷新活动"
            >
              <RefreshIndicator spinning={isLoading} />
            </motion.button>
            {user && user.permission >= 2 && (
              <>
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={() => navigate('/admin/whitelist')}
                  className="p-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                  title="白名单管理"
                >
                  <ShieldCheck size={20} />
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={() => navigate('/admin/sign-locations')}
                  className="p-2 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                  title="签到地点管理"
                >
                  <MapPin size={20} />
                </motion.button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <PullToRefresh
        onRefresh={() => fetchActivities({ force: true })}
        isRefreshing={isLoading}
        className="p-4"
      >
        <div className="pb-[calc(80px+var(--sab))] space-y-4">
          {activityError && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            {activityError}。列表可能不是最新，请刷新后核对。
          </p>}
          {isLoading && activities.length === 0 ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-20 bg-slate-50 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : !isLoading && activities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
              <Clock size={48} className="mb-4 opacity-20" />
              <p>暂无正在进行的签到</p>
            </div>
          ) : (
            <LayoutGroup>
              {activities.map((course) => {
                const key = `${course.course_id}-${course.class_id}`;
                const isExpanded = expandedCourses[key];
                const activeCount = course.activities.filter(a =>
                  now < a.end_time && !a.record_source_name
                ).length;

                // Find the latest activity time for the header
                const latestActivityTime = course.activities.length > 0
                  ? Math.max(...course.activities.map(a => a.start_time))
                  : null;

                return (
                  <motion.div
                    layout
                    key={key}
                    className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden"
                  >
                    {/* Course Header */}
                    <motion.div
                      layout="position"
                      onClick={() => toggleCourse(course.course_id, course.class_id)}
                      className={`p-4 flex items-center justify-between cursor-pointer active:bg-slate-50 transition-colors ${isExpanded ? 'bg-slate-50/50' : ''}`}
                    >
                      <div className="flex items-center space-x-4 flex-1 min-w-0">
                        <div className="relative flex-shrink-0">
                          <div className="w-12 h-12 rounded-xl bg-slate-100 overflow-hidden">
                            {course.icon ? (
                              <RemoteImage src={course.icon} alt={course.course_name} className="w-full h-full" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-300">
                                <BookOpen size={20} />
                              </div>
                            )}
                          </div>
                          {activeCount > 0 && (
                            <div className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-red-500 rounded-full flex items-center justify-center text-[13px] text-white font-bold px-0.5 z-10 shadow-sm">
                              {activeCount}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-bold text-slate-900 leading-tight truncate">{course.course_name}</h3>
                          <div className="flex items-center space-x-2 mt-1">
                            <p className="text-xs text-slate-500 truncate flex-1">{course.course_teacher}</p>
                            {latestActivityTime && !isExpanded && (
                              <span className={`text-[10px] font-medium whitespace-nowrap flex-shrink-0 ${activeCount > 0 ? 'text-blue-600' : 'text-slate-400'}`}>
                                {getChineseStringByDatetime(latestActivityTime)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <motion.div
                        animate={{ rotate: isExpanded ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                        className="text-slate-300 flex items-center ml-2 flex-shrink-0"
                      >
                        <ChevronDown size={20} />
                      </motion.div>
                    </motion.div>

                    {/* Activities List */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: "circOut" }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 space-y-2 border-t border-slate-50 pt-3">
                            {course.activities.length > 0 ? (
                              course.activities.map((activity) => {
                                const isOngoing = now < activity.end_time;
                                const isFinished = !!activity.record_source_name;
                                const shouldHighlight = isOngoing && !isFinished;

                                // Countdown logic
                                let countdownStr = "";
                                if (shouldHighlight) {
                                  const diff = Math.max(0, activity.end_time - now);
                                  const mins = Math.floor(diff / 60000);
                                  const secs = Math.floor((diff % 60000) / 1000);
                                  countdownStr = `${mins}:${secs.toString().padStart(2, '0')}`;
                                }

                                return (
                                  <motion.div
                                    key={activity.active_id}
                                    layout
                                    whileTap={{ scale: 0.92 }}
                                    onClick={() => handleActivityClick(activity, course, shouldHighlight)}
                                    className={`flex items-center justify-between p-3 rounded-2xl border transition-all group cursor-pointer ${shouldHighlight
                                      ? 'bg-purple-50 border-purple-600'
                                      : 'bg-blue-50/50 border-blue-100/50 hover:bg-blue-50'
                                      }`}
                                  >
                                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-sm flex-shrink-0 bg-white ${shouldHighlight ? 'text-purple-600' : 'text-blue-600'
                                        }`}>
                                        {getSignTypeIcon(activity)}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className={`font-bold text-sm truncate text-slate-900`}>{activity.activity_name}</div>
                                        <div className="mt-1">
                                          <span className="sign-rule-label" aria-label={`签到要求：${describeSignRules(activity)}`}>
                                            {describeSignRules(activity)}
                                          </span>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                          {activity.need_face && (
                                            <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded-md font-medium">
                                              需在学习通 App 验证
                                            </span>
                                          )}
                                          {shouldHighlight && (
                                            <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-md font-medium whitespace-nowrap flex-shrink-0">
                                              进行中 {countdownStr}
                                            </span>
                                          )}
                                          {activity.record_source_name && (
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium truncate flex-shrink min-w-0 bg-green-100 text-green-700`}>
                                              {getSignState(activity.record_source, activity.record_source_name)}
                                            </span>
                                          )}
                                          <span className={`text-[10px] flex items-center flex-shrink-0 text-slate-500`}>
                                            <Clock size={10} className="mr-1" />
                                            {getChineseStringByDatetime(activity.start_time)}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                    <ChevronRight size={18} className={`text-slate-300 group-hover:text-blue-500 transition-colors ml-2 flex-shrink-0`} />
                                  </motion.div>
                                );
                              })
                            ) : (
                              <div className="py-8 flex flex-col items-center justify-center text-slate-300">
                                <Activity size={32} className="mb-2 opacity-20" />
                                <p className="text-xs font-medium">暂无签到活动</p>
                              </div>
                            )}
                            {course.has_more && (
                              <div className="text-center pt-1">
                                <p className="text-[13px] text-slate-400 font-medium">
                                  仅显示最近 {course.activities.length} 条活动
                                </p>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </LayoutGroup>
          )}
        </div>
      </PullToRefresh>

      <AnimatePresence>
        {pendingEntry && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-sm p-6"
            onClick={() => setPendingEntry(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              className="w-full max-w-sm rounded-[2rem] bg-white p-6 shadow-2xl border border-slate-100"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="space-y-3">
                <div>
                  <p className="text-lg font-black text-slate-900">温馨提示</p>
                  <p className="text-sm text-slate-500 mt-1 leading-6">
                    当前点击的签到活动（{pendingEntry.activity.activity_name}）已结束或已完成，仍要进入详情页吗？
                  </p>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => {
                      enterActivity(pendingEntry.activity, pendingEntry.course);
                      setPendingEntry(null);
                    }}
                    className="flex-1 rounded-xl bg-slate-100 px-4 py-3 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-200"
                  >
                    确认进入
                  </button>
                  <button
                    onClick={() => setPendingEntry(null)}
                    className="flex-1 rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-100 transition-colors hover:bg-blue-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Lobby;
