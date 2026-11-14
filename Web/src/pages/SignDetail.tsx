import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
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
  Camera,
  Fingerprint,
  RectangleEllipsis,
  LocateFixed,
  Map as MapIcon,
  Info
} from 'lucide-react';
import toast from 'react-hot-toast';
import client, { LONG_REQUEST_TIMEOUT } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { ApiResponse, Classmate, SignActivity, CourseActivities, SignStatusMessage, SignCheckItem, SignLocation, SignExecuteResult } from '../types';
import { getErrorMessage, isCancellationError } from '../utils/errors';

// Import refactored components
import { GestureInput } from '../components/sign/GestureInput';
import { PinInput } from '../components/sign/PinInput';
import { LocationInput } from '../components/sign/LocationInput';
import { QrInput } from '../components/sign/QrInput';
import { NormalInput } from '../components/sign/NormalInput';
import { PhotoInput } from '../components/sign/PhotoInput';
import { ProgressCard } from '../components/sign/ProgressCard';
import LocationCapture from '../components/LocationCapture';
import LocationDialog from '../components/LocationDialog';
import SignLocationPicker from '../components/sign/SignLocationPicker';
import { captureLocationPreview, type GPSPreview, type Point } from '../utils/locationPreview';
import { nearestEnabledLocation } from '../utils/locationMatching';
import RemoteImage from '../components/RemoteImage';
import { describeSignRules } from '../utils/signRules';

const MAX_PHOTO_UPLOAD_BYTES = 20 * 1024 * 1024;

const isImageFile = (file: File) => (
  file.type.startsWith('image/')
  || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(file.name)
);

function shuffleItems<T>(items: T[]) {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

const buildPhotoAssignments = (targetUids: number[], files: File[]) => {
  const assignments = new Map<number, File>();
  if (files.length === 0) return assignments;

  if (files.length >= targetUids.length) {
    const shuffledFiles = shuffleItems(files);
    targetUids.forEach((uid, index) => {
      assignments.set(uid, shuffledFiles[index]);
    });
    return assignments;
  }

  let shuffledCycle = shuffleItems(files);
  targetUids.forEach((uid, index) => {
    if (index > 0 && index % files.length === 0) {
      shuffledCycle = shuffleItems(files);
    }
    assignments.set(uid, shuffledCycle[index % files.length]);
  });
  return assignments;
};

const SignDetail = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user: currentUser } = useAuthStore();
  
  const activity = location.state?.activity as SignActivity;
  const course = location.state?.course as CourseActivities;
  // 人脸/拍照验证与签到类型无关：手势、签到码、位置签到都可能额外要求拍照。
  const requiresPhoto = !!activity?.if_photo;
  // 限定范围校验与位置签到同样需要坐标。
  const requiresLocation = activity?.sign_type === 4 || !!activity?.if_get_range;
  const isPhotoSign = activity?.sign_type === 0 && !!activity.if_photo;

  const [classmates, setClassmates] = useState<Classmate[]>([]);
  const [selectedUids, setSelectedUids] = useState<number[]>([]);
  const [isLoadingClassmates, setIsLoadingClassmates] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  
  const [signCode, setSignCode] = useState('');
  const [signLocations, setSignLocations] = useState<SignLocation[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<SignLocation | null>(null);
  const [selectedMapPoint, setSelectedMapPoint] = useState<Point | null>(null);
  const [isLoadingLocations, setIsLoadingLocations] = useState(false);
  const [locationLoadError, setLocationLoadError] = useState('');
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);
  const [isLocationMapOpen, setIsLocationMapOpen] = useState(false);
  const [isMapBusy, setMapBusy] = useState(false);
  const [isQuickLocationSigning, setIsQuickLocationSigning] = useState(false);
  const locationSelectionEpoch = useRef(0);
  const closeLocationPicker = () => { locationSelectionEpoch.current++; setIsLocationPickerOpen(false); };
  const closeLocationMap = () => { locationSelectionEpoch.current++; setIsLocationMapOpen(false); };
  useEffect(() => () => { locationSelectionEpoch.current++; }, []);
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviewUrls, setPhotoPreviewUrls] = useState<string[]>([]);
  
  const [showProgress, setShowProgress] = useState(false);
  const [signStatuses, setSignStatuses] = useState<Record<number, Partial<SignStatusMessage>>>({});
  const [classmateSignStates, setClassmateSignStates] = useState<Record<number, SignCheckItem>>({});
  
  const isExecutingRef = useRef(false);
  const isQuickLocationSigningRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const photoPreviewUrlsRef = useRef<string[]>([]);

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

  useEffect(() => {
    const returnedPhotos = location.state?.returnedPhotos as File[];
    if (returnedPhotos && returnedPhotos.length > 0) {
      handlePhotoAdd(returnedPhotos);
      // Clean up the returnedPhotos from location state to prevent double adding
      window.history.replaceState({ ...location.state, returnedPhotos: undefined }, '');
    }
  }, [location.state]);

  useEffect(() => {
    photoPreviewUrlsRef.current = photoPreviewUrls;
  }, [photoPreviewUrls]);

  useEffect(() => () => {
    photoPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const sortedClassmates = useMemo(() => {
    if (!currentUser) return classmates;
    return [...classmates].sort((a, b) => {
      if (a.uid === currentUser.uid) return -1;
      if (b.uid === currentUser.uid) return 1;
      return 0;
    });
  }, [classmates, currentUser]);

  const getSignStateLabel = (targetUid: number, source: number, name: string) => {
    if (source === -1) return '学习通签到';
    if (source === targetUid) return '本人签到';
    return `${name}代签`;
  };

  const loadClassmateSignStates = useCallback(async (students: Classmate[]) => {
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
  }, [activity, currentUser?.uid]);

  const loadSignLocations = async () => {
    setIsLoadingLocations(true);
    setLocationLoadError('');
    try {
      const response = await client.get<ApiResponse<SignLocation[]>>('/sign/locations');
      setSignLocations(response.data.data || []);
    } catch (error) {
      setLocationLoadError(getErrorMessage(error, '获取签到地点失败'));
    } finally {
      setIsLoadingLocations(false);
    }
  };
  const savePersonalLocation = async (name: string, address: string) => {
    const point = selectedMapPoint ?? selectedLocation;
    if (!point) throw new Error('请先选择地图点或已有地点。');
    const response = await client.post<ApiResponse<SignLocation>>('/sign/locations/personal', {
      name, address, latitude: point.latitude, longitude: point.longitude,
    });
    const saved = { ...response.data.data, is_personal: true };
    setSignLocations(previous => [...previous.filter(item => item.id !== saved.id), saved]);
    setSelectedLocation(saved);
    setSelectedMapPoint(null);
    toast.success('已保存到当前账号的个人常用地点');
  };
  const deletePersonalLocation = async (locationToDelete: SignLocation) => {
    await client.delete(`/sign/locations/personal/${locationToDelete.id}`);
    setSignLocations(previous => previous.filter(item => item.id !== locationToDelete.id));
    if (selectedLocation?.id === locationToDelete.id) setSelectedLocation(null);
    toast.success('已删除个人常用地点');
  };
  const selectMapPoint = (point: Point) => {
    const epoch = locationSelectionEpoch.current;
    if (epoch !== locationSelectionEpoch.current) return;
    setSelectedLocation(null);
    setSelectedMapPoint(point);
    setIsLocationMapOpen(false);
  };
  const selectNearestLocation = async (point: Point) => {
    const epoch = locationSelectionEpoch.current;
    const response = await client.get<ApiResponse<SignLocation[]>>('/sign/locations');
    if (epoch !== locationSelectionEpoch.current) return;
    const enabled = response.data.data || [];
    setSignLocations(enabled);
    const matched = nearestEnabledLocation(enabled, point);
    if (!matched) throw new Error('附近150米内没有已启用地点，请手动选择列表中的地点或使用地图选点。');
    setSelectedLocation(matched);
    setSelectedMapPoint(null);
    setIsLocationMapOpen(false);
    setIsLocationPickerOpen(false);
  };

  useEffect(() => {
    if (!activity || !requiresLocation) return;
    loadSignLocations();
  }, [activity, requiresLocation]);

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
      } catch (error) {
        toast.error(getErrorMessage(error, '获取同学列表失败'));
      } finally {
        setIsLoadingClassmates(false);
      }
    };
    fetchClassmates();
  }, [activity, navigate, loadClassmateSignStates]);

  const toggleClassmate = (uid: number) => {
    setSelectedUids(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]);
  };

  const selectAll = () => {
    if (!classmates) return;
    setSelectedUids(selectedUids.length === classmates.length ? [] : classmates.map(c => c.uid));
  };

  const handlePhotoAdd = (files: File[]) => {
    const acceptedFiles: File[] = [];
    let invalidTypeCount = 0;
    let oversizeCount = 0;

    files.forEach((file) => {
      if (!isImageFile(file)) {
        invalidTypeCount += 1;
        return;
      }

      if (file.size > MAX_PHOTO_UPLOAD_BYTES) {
        oversizeCount += 1;
        return;
      }

      acceptedFiles.push(file);
    });

    if (invalidTypeCount > 0) {
      toast.error(`${invalidTypeCount} 个文件不是图片，已跳过`);
    }
    if (oversizeCount > 0) {
      toast.error(`${oversizeCount} 张照片超过 20MB，已跳过`);
    }
    if (acceptedFiles.length === 0) return;

    const nextUrls = acceptedFiles.map((file) => URL.createObjectURL(file));
    setPhotoFiles(prev => [...prev, ...acceptedFiles]);
    setPhotoPreviewUrls(prev => [...prev, ...nextUrls]);
  };

  const removePhoto = (index: number) => {
    const url = photoPreviewUrls[index];
    if (url) {
      URL.revokeObjectURL(url);
    }
    setPhotoFiles(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviewUrls(prev => prev.filter((_, i) => i !== index));
  };

  const clearPhotos = () => {
    photoPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    setPhotoFiles([]);
    setPhotoPreviewUrls([]);
  };

  const photoObjectIDCache = useRef<Map<File, string>>(new Map());
  const ensurePhotoObjectID = async (file: File, signal?: AbortSignal) => {
    const cached = photoObjectIDCache.current.get(file);
    if (cached) return cached;
    const formData = new FormData();
    formData.append('file', file);
    const response = await client.post<ApiResponse<{ object_id: string }>>('/sign/photo/upload', formData, { signal, timeout: LONG_REQUEST_TIMEOUT });
    const objectID = response.data.data?.object_id;
    if (!objectID) throw new Error('照片上传失败，请重试');
    photoObjectIDCache.current.set(file, objectID);
    return objectID;
  };

  const handleExecute = async (locationOverride?: SignLocation, deviceLocation?: GPSPreview, allowDuringQuickLocationSign = false, mapPointOverride?: Point) => {
    if (!activity || isExecutingRef.current || (isQuickLocationSigningRef.current && !allowDuringQuickLocationSign)) return;
    const selectedPhotoFiles = [...photoFiles];
    const locationForExecution = locationOverride ?? selectedLocation;
    const mapPointForExecution = deviceLocation ? undefined : mapPointOverride ?? selectedMapPoint;

    if ((activity.sign_type === 3 || activity.sign_type === 5) && (!signCode || signCode.length < 4)) {
      toast.error('请输入正确位数的签到码 / 手势');
      return;
    }

    if (requiresLocation && !locationForExecution && !deviceLocation && !mapPointForExecution) {
      toast.error('该签到要求位置验证，请先选择签到地点');
      return;
    }

    if (requiresPhoto && selectedPhotoFiles.length === 0) {
      toast.error('该签到还要求人脸/拍照验证，请先拍照或选择照片');
      return;
    }

    setIsExecuting(true);
    isExecutingRef.current = true;
    setShowProgress(true);
    setSignStatuses({});

    abortControllerRef.current = new AbortController();

    const targetUids = Array.from(new Set([currentUser?.uid, ...selectedUids].filter(Boolean) as number[]));
    const photoAssignments = requiresPhoto ? buildPhotoAssignments(targetUids, selectedPhotoFiles) : new Map<number, File>();
    const initialStatuses: Record<number, Partial<SignStatusMessage>> = {};
    targetUids.forEach(uid => initialStatuses[uid] = { status: 'pending', message: '等待中' });
    setSignStatuses(initialStatuses);

    try {
      const checkResp = await client.post<ApiResponse<{ items: SignCheckItem[] }>>('/sign/check', {
        activity_id: activity.active_id,
        user_ids: selectedUids
      });

      const checkItems = checkResp.data.data.items;
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
            const assignedPhotoFile = isPhotoSign ? photoAssignments.get(uid) : null;
            if (isPhotoSign && !assignedPhotoFile) {
              lastError = '未找到可上传照片';
              setSignStatuses(prev => ({ ...prev, [uid]: { ...prev[uid], message: lastError } }));
              continue;
            }

            const special_params: Record<string, unknown> = {};
            if (activity.sign_type === 3 || activity.sign_type === 5) special_params.sign_code = signCode;

            const executeBody = {
              activity_id: activity.active_id, target_uid: uid, sign_type: activity.sign_type,
              course_id: activity.course_id, class_id: activity.class_id, if_refresh_ewm: activity.if_refresh_ewm,
              require_range: !!activity.if_get_range,
              location_id: requiresLocation && !deviceLocation && !mapPointForExecution ? locationForExecution?.id : undefined,
              location_mode: requiresLocation && deviceLocation ? 'device_gps'
                : requiresLocation && mapPointForExecution ? 'map_pick' : undefined,
              device_location: requiresLocation && deviceLocation ? {
                latitude: deviceLocation.point.latitude,
                longitude: deviceLocation.point.longitude,
                accuracy: deviceLocation.accuracy,
                captured_at: deviceLocation.captured_at,
                coordinate_system: deviceLocation.coordinate_system,
              } : undefined,
              map_location: requiresLocation && mapPointForExecution ? {
                latitude: mapPointForExecution.latitude,
                longitude: mapPointForExecution.longitude,
                coordinate_system: 'GCJ-02',
              } : undefined,
            };

            let execResp;
            if (requiresPhoto && assignedPhotoFile) {
              if (isPhotoSign) {
                const formData = new FormData();
                formData.append('activity_id', String(activity.active_id));
                formData.append('course_id', String(activity.course_id));
                formData.append('class_id', String(activity.class_id));
                formData.append('target_uid', String(uid));
                formData.append('if_refresh_ewm', String(activity.if_refresh_ewm));
                formData.append('file', assignedPhotoFile);
                execResp = await client.post<ApiResponse<SignExecuteResult>>('/sign/photo', formData, {
                  signal: abortControllerRef.current?.signal, timeout: LONG_REQUEST_TIMEOUT,
                });
              } else {
                // 手势/签到码/位置签到叠加人脸验证时：先上传照片换 object_id，再随签到一起提交。
                const objectID = await ensurePhotoObjectID(assignedPhotoFile, abortControllerRef.current?.signal);
                execResp = await client.post<ApiResponse<SignExecuteResult>>('/sign/execute', {
                  ...executeBody,
                  special_params: { ...special_params, object_id: objectID },
                }, {
                  signal: abortControllerRef.current?.signal, timeout: LONG_REQUEST_TIMEOUT,
                });
              }
            } else {
              execResp = await client.post<ApiResponse<SignExecuteResult>>('/sign/execute', {
                ...executeBody,
                special_params,
              }, {
                signal: abortControllerRef.current?.signal, timeout: LONG_REQUEST_TIMEOUT,
              });
            }

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
          } catch (err) {
            if (isCancellationError(err)) return;
            lastError = getErrorMessage(err, '网络连接异常');
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
    } catch (error) {
      if (!isCancellationError(error)) {
        toast.error(getErrorMessage(error, '执行过程出错'));
      }
    } finally {
      if (isExecutingRef.current) {
        setIsExecuting(false);
        isExecutingRef.current = false;
        abortControllerRef.current = null;
      }
    }
  };

  const handleQuickLocationSign = async () => {
    if (isQuickLocationSigningRef.current || isExecutingRef.current || isMapBusy) return;

    isQuickLocationSigningRef.current = true;
    setIsQuickLocationSigning(true);
    try {
      const preview = await captureLocationPreview('/sign/locations/coordinate-preview');
      if (preview.poor_accuracy) {
        toast('定位精度差于50米，仍将使用本次设备坐标签到。');
      }
      await handleExecute(undefined, preview, true);
    } catch (error) {
      toast.error(getErrorMessage(error, '定位或签到失败，请重试。'));
    } finally {
      isQuickLocationSigningRef.current = false;
      setIsQuickLocationSigning(false);
    }
  };

  if (!activity) return null;

  const getSignIcon = (size: number = 24) => {
    if (isPhotoSign) return <Camera size={size} />;

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
          <h2 className="font-bold text-slate-900 leading-snug break-words">{describeSignRules(activity)}</h2>
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
              {course?.icon ? <RemoteImage src={course.icon} alt={course.course_name} className="w-full h-full" /> : <div className="w-full h-full flex items-center justify-center text-slate-300"><BookOpen size={24} /></div>}
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
        {activity.need_face && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-700">
            该签到由教师开启了<strong>人脸验证（活体）</strong>，验证由学习通客户端完成，网页无法代签。请直接用学习通 App 签到；本页仅可查看活动信息与位置。
          </div>
        )}
        <div className={`bg-white rounded-[2rem] shadow-xl shadow-blue-900/5 border border-slate-100 overflow-hidden flex flex-col ${activity.need_face ? 'opacity-60 pointer-events-none' : ''}`}>
          <div className="p-5 pb-4">
            {activity.sign_type === 3 && <GestureInput value={signCode} onChange={setSignCode} />}
            {activity.sign_type === 5 && <PinInput value={signCode} onChange={setSignCode} />}
            {requiresLocation && (
              <>
                <div className="location-ui mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-label="位置签到主操作">
                  <button
                    type="button"
                    onClick={handleQuickLocationSign}
                    disabled={isExecuting || isQuickLocationSigning || isMapBusy}
                    className="loc-primary flex-col items-start! px-4! py-4! text-left"
                  >
                    <LocateFixed size={21} /><span>{isQuickLocationSigning ? '正在定位并签到…' : '一键现场定位并签到'}</span><span className="text-[11px] font-normal text-blue-100">使用设备当前位置直接签到</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { locationSelectionEpoch.current++; setIsLocationMapOpen(true); }}
                    disabled={isExecuting || isQuickLocationSigning || isMapBusy}
                    className="loc-method"
                  >
                    <MapIcon size={21} /><strong>打开地图选择位置</strong><span>搜索目标楼栋，核对后确认签到</span>
                  </button>
                </div>
                <LocationInput
                  name={selectedMapPoint ? '地图选择点' : selectedLocation?.name || ''}
                  description={selectedMapPoint
                    ? `GCJ-02：纬度 ${selectedMapPoint.latitude}，经度 ${selectedMapPoint.longitude}`
                    : selectedLocation?.address || (locationLoadError || (isLoadingLocations ? '正在加载地点…' : signLocations.length === 0 ? '暂无可用签到地点' : '点击选择地点'))}
                  onOpen={() => { locationSelectionEpoch.current++; setIsLocationPickerOpen(true); }}
                />
                {locationLoadError && <p className="mt-2 text-xs text-red-500">{locationLoadError}</p>}
                <p className="mt-3 text-xs leading-relaxed text-slate-500 flex gap-2"><Info size={14} className="shrink-0 mt-0.5" />现场定位和地图确认会使用本次坐标签到；常用地点需选中后点击“立即签到”。坐标不证明教师设定的签到范围。</p>
              </>
            )}
            {activity.sign_type === 2 && <QrInput isDynamic={activity.if_refresh_ewm} />}
            {requiresPhoto && (
              <PhotoInput 
                files={photoFiles} 
                previewUrls={photoPreviewUrls} 
                disabled={isExecuting}
                faceMode={requiresPhoto}
                onAdd={handlePhotoAdd} 
                onRemove={removePhoto} 
                onClear={clearPhotos}
                onOpenCamera={() => navigate('/photo-capture', { state: { activity, course, selectedUids, classmates, existingPhotos: photoFiles } })}
              />
            )}
            {activity.sign_type === 0 && !requiresPhoto && <NormalInput />}
          </div>

          <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 mt-auto shrink-0">
            <button 
              onClick={activity.sign_type === 2 
                ? () => navigate('/scanner', { state: { activity, course, selectedUids, classmates } }) 
                : () => handleExecute()
              }
              disabled={isExecuting || isQuickLocationSigning || isMapBusy || activity.need_face}
              className={`w-full py-3.5 rounded-xl font-bold text-sm shadow-lg transition-all active:scale-[0.97] flex items-center justify-center gap-3 ${isExecuting || activity.need_face ? 'bg-slate-300 text-slate-500 shadow-none' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-100'}`}
            >
              {isExecuting ? (
                <Loader2 className="animate-spin" size={18} />
              ) : activity.need_face ? (
                <>需学习通 App 人脸验证</>
              ) : activity.sign_type === 2 ? (
                <><QrCode size={18} /> 去扫码签到</>
              ) : (
                <>{selectedUids.length > 0 ? `立即签到 (${selectedUids.length + 1})` : "立即签到"}</>
              )}
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
                      {student.avatar ? <RemoteImage src={student.avatar} alt={student.name} className="w-full h-full" /> : student.name[0]}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-0.5 min-w-0">
                        <p className="font-bold text-base text-slate-800 leading-tight truncate">{student.name}</p>
                        {classmateSignStates[student.uid]?.signed && (
                          <span className="max-w-[140px] truncate text-[10px] px-1.5 py-0.5 rounded-md font-medium shrink-0 bg-green-100 text-green-700" title={getSignStateLabel(student.uid, classmateSignStates[student.uid].record_source, classmateSignStates[student.uid].record_source_name)}>
                            {getSignStateLabel(student.uid, classmateSignStates[student.uid].record_source, classmateSignStates[student.uid].record_source_name)}
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
        {isLocationMapOpen && <LocationDialog title="地图选择签到位置" description="搜索目标位置，拖动地图微调后确认" onClose={closeLocationMap}>
            <LocationCapture selectionMode initialPoint={selectedMapPoint ?? selectedLocation} onSelect={selectMapPoint} onBusy={setMapBusy} />
        </LocationDialog>}
        {isLocationPickerOpen && (
          <LocationDialog title="选择签到位置" description="从常用地点中选择，定位可按距离排序" onClose={closeLocationPicker}>
                <SignLocationPicker
                  locations={signLocations}
                  selectedID={selectedLocation?.id}
                  loading={isLoadingLocations}
                  loadError={locationLoadError}
                  savePoint={selectedMapPoint ?? (selectedLocation?.is_personal ? null : selectedLocation)}
                  onReload={loadSignLocations}
                  onSelect={item => { setSelectedLocation(item); setSelectedMapPoint(null); closeLocationPicker(); }}
                  onNearest={selectNearestLocation}
                  onSavePersonal={savePersonalLocation}
                  onDeletePersonal={deletePersonalLocation}
                />
          </LocationDialog>
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
