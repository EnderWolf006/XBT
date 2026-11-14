import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Camera, EyeOff, Eye, MapPin, CheckCircle2, LocateOff, ScanFace } from 'lucide-react';
import { Html5Qrcode, type CameraDevice } from 'html5-qrcode';
import toast from 'react-hot-toast';
import client, { LONG_REQUEST_TIMEOUT } from '../api/client';
import { useAuthStore } from '../store/auth';
import { ProgressCard } from '../components/sign/ProgressCard';
import type { ApiResponse, SignStatusMessage, Classmate, User, SignCheckItem, SignExecuteResult, SignLocation } from '../types';
import { getErrorMessage, isCancellationError } from '../utils/errors';
import scanCursor from '../assets/scan_cursor.png';
import LocationDialog from '../components/LocationDialog';

interface QrData {
  enc: string;
  c: string;
  timestamp: number;
}

type NativeCameraBridge = {
  isReady?: () => boolean;
  getCameraState?: () => string;
  setScannerActive?: (active: boolean) => void;
  setLensFacing?: (mode: 'user' | 'environment') => void;
  zoomByPinchDelta?: (delta: number) => number;
  syncPunchHole?: (left: number, top: number, width: number, height: number) => void;
};

type WindowWithBridge = Window & {
  XBTCameraBridge?: NativeCameraBridge;
};

const getFriendlyCameraLabel = (camera: CameraDevice, index: number) => {
  const raw = (camera.label || '').trim();
  const lower = raw.toLowerCase();
  if (/back|rear|environment|后置|后面|背面/.test(lower)) return '后置摄像头';
  if (/front|user|前置|自拍/.test(lower)) return '前置摄像头';
  if (/external|usb|外接/.test(lower)) return '外接摄像头';
  if (raw) return raw;
  return `摄像头 ${index + 1}`;
};

const FullScanner = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user: currentUser } = useAuthStore();
  
  const [isExecuting, setIsExecuting] = useState(false);
  const [latestQrData, setLatestQrData] = useState<QrData | null>(null);
  const [signStatuses, setSignStatuses] = useState<Record<number, Partial<SignStatusMessage>>>({});
  
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [showCameraList, setShowCameraList] = useState(false);
  const [isStealthMode, setIsStealthMode] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(true);

  useEffect(() => {
    if (isCameraReady) {
      const timer = setTimeout(() => {
        setShowLoadingOverlay(false);
      }, 5);
      return () => clearTimeout(timer);
    } else {
      setShowLoadingOverlay(true);
    }
  }, [isCameraReady]);

  const [selectedLocation, setSelectedLocation] = useState<SignLocation | null>(null);
  const [signLocations, setSignLocations] = useState<SignLocation[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);

  const selectedLocationRef = useRef<SignLocation | null>(null);
  const lastScanTimeRef = useRef<number>(0);

  useEffect(() => {
    selectedLocationRef.current = selectedLocation;
  }, [selectedLocation]);

  const loadSignLocations = useCallback(async () => {
    setLocationLoading(true);
    setLocationError('');
    try {
      const response = await client.get<ApiResponse<SignLocation[]>>('/sign/locations');
      setSignLocations(response.data.data ?? []);
    } catch (error) {
      setLocationError(getErrorMessage(error, '获取个人常用地点失败，请重试'));
    } finally {
      setLocationLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isLocationPickerOpen) void loadSignLocations();
  }, [isLocationPickerOpen, loadSignLocations]);
  
  useEffect(() => {
    const handleFullScreen = async () => {
      try {
        if (isStealthMode) {
          if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          }
        } else {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
          }
        }
      } catch (err) {
        console.warn("Fullscreen toggle failed:", err);
      }
    };
    handleFullScreen();
  }, [isStealthMode]);

  useEffect(() => {
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  const lastTouchDistance = useRef<number | null>(null);
  const pinchLockedByMultiTouch = useRef(false);
  const currentZoom = useRef<number>(1);
  const [displayZoom, setDisplayZoom] = useState(1);
  const [showZoomOverlay, setShowZoomOverlay] = useState(false);
  const zoomHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const scannerRef = useRef<HTMLDivElement>(null);

  // 窗口状态变化时强制重置，防止手势中断导致 UI 锁定
  useEffect(() => {
    const handleReset = () => {
      lastTouchDistance.current = null;
      setShowZoomOverlay(false);
    };
    window.addEventListener('blur', handleReset);
    window.addEventListener('visibilitychange', handleReset);
    return () => {
      window.removeEventListener('blur', handleReset);
      window.removeEventListener('visibilitychange', handleReset);
    };
  }, []);

  const isNativeBridgeModeRef = useRef(false);
  const [isNativeBridgeMode, setIsNativeBridgeMode] = useState(false);
  const [nativePreviewReady, setNativePreviewReady] = useState(false);
  const nativePreviewReadyRef = useRef(false);
  const selectedDeviceIdRef = useRef<string | null>(null);

  const { activity, selectedUids, classmates } = location.state || {};
  const latestQrDataRef = useRef<QrData | null>(null);
  const isExecutingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 二维码签到同样可能叠加人脸验证，扫码前必须先采集本人照片。
  const requiresPhoto = !!activity?.if_photo;
  const [facePhotos, setFacePhotos] = useState<File[]>([]);
  const [facePreviews, setFacePreviews] = useState<string[]>([]);
  const photoObjectIDCache = useRef<Map<File, string>>(new Map());

  useEffect(() => {
    const returned = location.state?.returnedPhotos as File[] | undefined;
    if (returned && returned.length > 0) {
      setFacePhotos(prev => [...prev, ...returned]);
      setFacePreviews(prev => [...prev, ...returned.map(file => URL.createObjectURL(file))]);
      window.history.replaceState({ ...location.state, returnedPhotos: undefined }, '');
      toast.success('人脸照片已采集，请扫描老师展示的二维码');
    }
  }, [location.state]);

  const getNativeBridge = (): NativeCameraBridge | null => {
    const bridge = (window as WindowWithBridge).XBTCameraBridge;
    if (!bridge) return null;
    try {
      if (typeof bridge.isReady === 'function' && !bridge.isReady()) return null;
    } catch {
      return null;
    }
    return bridge;
  };

  const syncReaderPunchHole = useCallback(() => {
    const bridge = getNativeBridge();
    const reader = readerRef.current;
    if (!bridge || !reader || typeof bridge.syncPunchHole !== 'function') return;
    const rect = reader.getBoundingClientRect();
    bridge.syncPunchHole(rect.left, rect.top, rect.width, rect.height);
  }, []);

  const setNativeLensFacing = useCallback((deviceId: string | null) => {
    const bridge = getNativeBridge();
    if (!bridge || typeof bridge.setLensFacing !== 'function' || !deviceId) return;
    const selected = cameras.find((c) => c.id === deviceId);
    const label = selected?.label?.toLowerCase() ?? '';
    const facing: 'user' | 'environment' = /front|user|前置|自拍/.test(label) ? 'user' : 'environment';
    bridge.setLensFacing(facing);
  }, [cameras]);

  const orderedTargetUids = [currentUser?.uid, ...(selectedUids || [])].filter(Boolean) as number[];

  useEffect(() => {
    latestQrDataRef.current = latestQrData;
  }, [latestQrData]);

  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);

  useEffect(() => {
    nativePreviewReadyRef.current = nativePreviewReady;
  }, [nativePreviewReady]);

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  useEffect(() => {
    setNativeLensFacing(selectedDeviceId);
  }, [selectedDeviceId, setNativeLensFacing]);

  useEffect(() => {
    if (!activity) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const maxRetry = 30;

    const activateNativeScanner = () => {
      if (disposed) return;
      const bridge = getNativeBridge();
      if (!bridge || typeof bridge.setScannerActive !== 'function') {
        if (retryCount < maxRetry) {
          retryCount += 1;
          timer = setTimeout(activateNativeScanner, 120);
        }
        return;
      }

      bridge.setScannerActive(true);
      setNativeLensFacing(selectedDeviceIdRef.current);

      if (!nativePreviewReadyRef.current && retryCount < maxRetry) {
        retryCount += 1;
        timer = setTimeout(activateNativeScanner, 150);
      }
    };

    activateNativeScanner();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      const bridge = getNativeBridge();
      bridge?.setScannerActive?.(false);
    };
  }, [activity, setNativeLensFacing]);

  useEffect(() => {
    return () => {
      if (isExecutingRef.current) {
        isExecutingRef.current = false;
        abortControllerRef.current?.abort();
      }
    };
  }, []);

  const closePopup = () => {
    setIsExecuting(false);
    isExecutingRef.current = false;
    abortControllerRef.current?.abort();
    lastScanTimeRef.current = Date.now(); // 2s protection after close
  };

  useEffect(() => {
    if (getNativeBridge()) {
      setSelectedDeviceId('__native_environment__');
      setCameras([
        { id: '__native_environment__', label: '后置摄像头' } as CameraDevice,
        { id: '__native_user__', label: '前置摄像头' } as CameraDevice,
      ]);
      return;
    }

    Html5Qrcode.getCameras().then(devices => {
      if (devices && devices.length > 0) {
        const normalizedDevices = devices.map((d, index) => ({
          ...d,
          label: getFriendlyCameraLabel(d, index),
        }));
        setCameras(normalizedDevices);
        const backCamera = normalizedDevices.find(d =>
          /back|rear|environment|后置|后面|背面/.test(d.label.toLowerCase())
        );
        setSelectedDeviceId(backCamera ? backCamera.id : (normalizedDevices.length > 1 ? normalizedDevices[1].id : normalizedDevices[0].id));
      }
    }).catch(err => console.error("Error getting cameras", err));
  }, []);

  useEffect(() => {
    const bridge = getNativeBridge();
    isNativeBridgeModeRef.current = !!bridge;
    setIsNativeBridgeMode(!!bridge);
    setNativePreviewReady(false);
    if (bridge) {
      setSelectedDeviceId('__native_environment__');
      setCameras([
        { id: '__native_environment__', label: '后置摄像头' } as CameraDevice,
        { id: '__native_user__', label: '前置摄像头' } as CameraDevice,
      ]);
    }
  }, []);

  useEffect(() => {
    if (!isNativeBridgeMode) return;

    const scannerRoot = readerRef.current?.parentElement ?? null;
    const touchedElements: Array<{ el: HTMLElement; bg: string }> = [];
    let cursor = scannerRoot;
    while (cursor) {
      touchedElements.push({ el: cursor, bg: cursor.style.backgroundColor });
      cursor.style.backgroundColor = 'transparent';
      cursor = cursor.parentElement;
    }

    const root = document.getElementById('root');
    const prevHtmlBg = document.documentElement.style.backgroundColor;
    const prevBodyBg = document.body.style.backgroundColor;
    const prevRootBg = root?.style.backgroundColor ?? '';

    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    if (root) root.style.backgroundColor = 'transparent';

    return () => {
      touchedElements.forEach(({ el, bg }) => {
        el.style.backgroundColor = bg;
      });
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.backgroundColor = prevBodyBg;
      if (root) root.style.backgroundColor = prevRootBg;
    };
  }, [isNativeBridgeMode]);

  useEffect(() => {
    const onCameraState = (event: Event) => {
      if (!isNativeBridgeModeRef.current) return;
      const customEvent = event as CustomEvent<{ active?: boolean; error?: string }>;
      const isActive = !!customEvent.detail?.active;
      const error = customEvent.detail?.error?.trim() || '';
      if (!isActive && error === 'inactive') return;
      setNativePreviewReady(isActive);
      if (isActive || (error && error !== 'inactive')) setIsCameraReady(true);
    };
    window.addEventListener('xbt-native-camera-state', onCameraState);
    return () => {
      window.removeEventListener('xbt-native-camera-state', onCameraState);
    };
  }, []);

  // 兜底：部分机型在极端快切场景下可能丢失 camera-state 事件，轮询原生状态避免一直卡加载。
  useEffect(() => {
    if (!isNativeBridgeMode || nativePreviewReady) return;
    let disposed = false;
    let tickCount = 0;
    const maxTicks = 24; // 约 3.6s
    const timer = setInterval(() => {
      if (disposed) return;
      const bridge = getNativeBridge();
      if (!bridge || typeof bridge.getCameraState !== 'function') return;
      try {
        const raw = bridge.getCameraState();
        if (!raw) return;
        const state = JSON.parse(raw) as { active?: boolean; error?: string };
        const active = !!state.active;
        const error = (state.error || '').trim();
        if (active) {
          setNativePreviewReady(true);
          setIsCameraReady(true);
          return;
        }
        if (error && error !== 'inactive') {
          setIsCameraReady(true);
        }
      } catch {
        // ignore malformed payload
      }
      tickCount += 1;
      if (tickCount >= maxTicks) {
        clearInterval(timer);
      }
    }, 150);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [isNativeBridgeMode, nativePreviewReady]);

  const activeScannerRef = useRef<Html5Qrcode | null>(null);
  const transitionPromise = useRef<Promise<void>>(Promise.resolve());
  const scannerSessionKey = isNativeBridgeMode ? '__native__' : (selectedDeviceId || '');

  useEffect(() => {
    if (!activity) {
      if (!activity) navigate('/');
      return;
    }
    const deviceId = scannerSessionKey === '__native__' ? null : scannerSessionKey;
    if (!deviceId && !isNativeBridgeModeRef.current) return;

    const bridge = getNativeBridge();
    if (bridge) {
      setNativePreviewReady(false);
      setIsCameraReady(false);
    }

    let isMounted = true;
    const safeStart = async () => {
      setIsCameraReady(false);
      transitionPromise.current = transitionPromise.current.then(async () => {
        try {
          const useNativeScanner = !!bridge;
          if (activeScannerRef.current) {
            const scanner = activeScannerRef.current;
            if (scanner.isScanning) await scanner.stop();
            const container = document.getElementById("reader");
            if (container) container.innerHTML = "";
            activeScannerRef.current = null;
          }

          if (!isMounted) return;
          if (useNativeScanner) {
            syncReaderPunchHole();
            return;
          }
          if (!deviceId) return;

          const html5QrCode = new Html5Qrcode("reader");
          activeScannerRef.current = html5QrCode;

          await html5QrCode.start(
            deviceId,
            {
              fps: 30,
              aspectRatio: 1.777778,
              videoConstraints: {
                deviceId: { exact: deviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                advanced: [{ focusMode: "continuous" }]
              }
            },
            text => onScanSuccess(text),
            () => {}
          );
          
          setIsCameraReady(true);
          
          if (window.BarcodeDetector) {
            const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
            const videoElement = document.querySelector<HTMLVideoElement>("#reader video");
            const nativeScanLoop = async () => {
              if (!isMounted || !activeScannerRef.current) return;
              if (videoElement && videoElement.readyState >= 2) {
                try {
                  const barcodes = await detector.detect(videoElement);
                  if (barcodes.length > 0) onScanSuccess(barcodes[0].rawValue);
                } catch (error) {
                  console.warn('浏览器二维码检测失败，继续使用主扫描器', error);
                  return;
                }
              }
              requestAnimationFrame(nativeScanLoop);
            };
            nativeScanLoop();
          }
        } catch (err) {
          if (isMounted && !String(err).includes("transition")) toast.error("相机启动失败，请重试");
        }
      });
    };

    safeStart();
    return () => {
      isMounted = false;
      setNativePreviewReady(false);
      transitionPromise.current = transitionPromise.current.then(async () => {
        if (activeScannerRef.current) {
          const scanner = activeScannerRef.current;
          try {
            if (scanner.isScanning) await scanner.stop();
          } catch (error) {
            console.warn('停止二维码扫描器失败', error);
          }
          activeScannerRef.current = null;
          const container = document.getElementById("reader");
          if (container) container.innerHTML = "";
        }
      });
    };
  }, [activity, navigate, scannerSessionKey, syncReaderPunchHole]);

  useEffect(() => {
    if (!isNativeBridgeModeRef.current) return;
    syncReaderPunchHole();
    const reader = readerRef.current;
    if (!reader) return;

    const observer = new ResizeObserver(() => syncReaderPunchHole());
    observer.observe(reader);
    window.addEventListener('resize', syncReaderPunchHole);
    window.addEventListener('scroll', syncReaderPunchHole, { passive: true });

    // 缩放
    let lastTouchDist = 0;
    const getTouchDist = (touches: TouchList) => {
      return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );
    };

    const handleTouchStartNative = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        lastTouchDist = getTouchDist(e.touches);
      }
    };

    const handleTouchMoveNative = (e: TouchEvent) => {
      if (e.touches.length === 2 && lastTouchDist > 0) {
        const currentDistance = getTouchDist(e.touches);
        const delta = (currentDistance - lastTouchDist) * 0.01;
        
        const bridge = getNativeBridge();
        if (bridge && typeof bridge.zoomByPinchDelta === 'function') {
          bridge.zoomByPinchDelta(delta);
        }
        lastTouchDist = currentDistance;
      }
    };

    const handleTouchEndNative = () => {
      lastTouchDist = 0;
    };

    reader.addEventListener('touchstart', handleTouchStartNative, { passive: true });
    reader.addEventListener('touchmove', handleTouchMoveNative, { passive: true });
    reader.addEventListener('touchend', handleTouchEndNative, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncReaderPunchHole);
      window.removeEventListener('scroll', syncReaderPunchHole);
      reader.removeEventListener('touchstart', handleTouchStartNative);
      reader.removeEventListener('touchmove', handleTouchMoveNative);
      reader.removeEventListener('touchend', handleTouchEndNative);
    };
  }, [isCameraReady, syncReaderPunchHole]);

  useEffect(() => {
    if (!isNativeBridgeMode) return;
    const onNativeQr = (event: Event) => {
      const customEvent = event as CustomEvent<{ text?: string }>;
      const text = customEvent.detail?.text;
      if (typeof text === 'string' && text.length > 0) {
        onScanSuccess(text);
      }
    };
    window.addEventListener('xbt-native-qr', onNativeQr);
    return () => {
      window.removeEventListener('xbt-native-qr', onNativeQr);
    };
  }, [isNativeBridgeMode]);

  const parseQrText = (text: string): QrData | null => {
    if (!text.includes("mobilelearn.chaoxing.com")) return null;
    try {
      const url = new URL(text);
      const enc = url.searchParams.get('enc');
      const c = url.searchParams.get('c');
      if (enc) return { enc, c: c || '', timestamp: Date.now() };
    } catch {
      const encMatch = text.match(/[?&]enc=([^&]+)/);
      const cMatch = text.match(/[?&]c=([^&]+)/);
      if (encMatch) return { enc: encMatch[1], c: cMatch ? cMatch[1] : '', timestamp: Date.now() };
    }
    return null;
  };

  const handleExecute = async (initialQr: QrData) => {
    if (isExecutingRef.current) return;
    if (activity?.need_face) {
      toast.error('该签到要求学习通 App 活体人脸验证，网页无法代签，请用学习通 App 扫码签到');
      return;
    }
    if ((activity?.sign_type === 4 || activity?.if_get_range) && !selectedLocationRef.current) {
      toast.error('该签到要求位置验证，请先选择签到地点');
      return;
    }
    if (requiresPhoto && facePhotos.length === 0) {
      toast.error('该签到要求人脸验证，请先点左下角「人脸」拍摄本人正脸');
      return;
    }
    setIsExecuting(true);
    isExecutingRef.current = true;
    abortControllerRef.current = new AbortController();
    
    const initialStatuses: Record<number, Partial<SignStatusMessage>> = {};
    orderedTargetUids.forEach(uid => initialStatuses[uid] = { status: 'pending', message: '等待中' });
    setSignStatuses(initialStatuses);

    try {
      // 1. Check current sign status first
      const checkResp = await client.post<ApiResponse<{ items: SignCheckItem[] }>>('/sign/check', {
        activity_id: activity.active_id,
        user_ids: orderedTargetUids
      }, {
        signal: abortControllerRef.current?.signal, timeout: LONG_REQUEST_TIMEOUT,
      });

      const checkItems = checkResp.data.data.items;
      const signedUids = new Set(checkItems.filter(item => item.signed).map(item => item.user_id));
      
      checkItems.forEach(item => {
        if (item.signed) {
          setSignStatuses(prev => ({ ...prev, [item.user_id]: { status: 'success', message: item.message || '已签到' } }));
        }
      });

      const toSignUids = orderedTargetUids.filter(uid => !signedUids.has(uid));
      if (toSignUids.length === 0) return;

      // 人脸验证：整轮只上传一次照片换 object_id，所有目标共用同一个已采集人脸。
      let faceObjectID = '';
      if (requiresPhoto) {
        const faceFile = facePhotos[0];
        faceObjectID = photoObjectIDCache.current.get(faceFile) || '';
        if (!faceObjectID) {
          const formData = new FormData();
          formData.append('file', faceFile);
          const uploadResp = await client.post<ApiResponse<{ object_id: string }>>('/sign/photo/upload', formData, {
            signal: abortControllerRef.current?.signal, timeout: LONG_REQUEST_TIMEOUT,
          });
          faceObjectID = uploadResp.data.data?.object_id || '';
          if (!faceObjectID) throw new Error('人脸照片上传失败，请重试');
          photoObjectIDCache.current.set(faceFile, faceObjectID);
        }
      }

      // 2. Concurrent execution with Retry Logic
      await Promise.all(toSignUids.map(async (uid) => {
        const MAX_RETRIES = 15;
        let lastError = '';
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (!isExecutingRef.current) return;

          const currentQr = latestQrDataRef.current || initialQr;
          setSignStatuses(prev => ({ 
            ...prev, 
            [uid]: { 
              ...prev[uid], 
              status: attempt === 0 ? 'signing' : 'retrying', 
              attempt, 
              message: attempt === 0 ? '正在尝试签到' : (prev[uid]?.message || `准备重试(${attempt})`)
            } 
          }));
          try {
            const special_params: Record<string, unknown> = { enc: currentQr.enc, c: currentQr.c };
            if (faceObjectID) special_params.object_id = faceObjectID;
            const execResp = await client.post<ApiResponse<SignExecuteResult>>('/sign/execute', {
              activity_id: activity.active_id, target_uid: uid, sign_type: 2,
              course_id: activity.course_id, class_id: activity.class_id, if_refresh_ewm: activity.if_refresh_ewm,
              require_range: !!activity.if_get_range,
              location_id: selectedLocationRef.current?.id,
              special_params
            }, {
              signal: abortControllerRef.current?.signal, timeout: LONG_REQUEST_TIMEOUT,
            });
            const res = execResp.data.data;
            if (res.success || res.already_signed) {
              setSignStatuses(prev => ({ ...prev, [uid]: { status: 'success', message: res.message || '成功' } }));
              return;
            }
            lastError = res.message || '失败';
            setSignStatuses(prev => ({ ...prev, [uid]: { ...prev[uid], message: lastError } }));
          } catch (err) { 
            if (isCancellationError(err)) return;
            lastError = getErrorMessage(err, '异常'); 
            setSignStatuses(prev => ({ ...prev, [uid]: { ...prev[uid], message: lastError } }));
          }
          if (attempt < MAX_RETRIES) {
            const delay = attempt < 3 ? 1000 : 2000;
            for (let i = 0; i < delay; i += 100) {
              if (!isExecutingRef.current) return;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } else setSignStatuses(prev => ({ ...prev, [uid]: { status: 'failed', message: lastError } }));
        }
      }));
    } catch (error) {
      if (!isCancellationError(error)) {
        toast.error(getErrorMessage(error, '执行过程出错'));
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  const onScanSuccess = useEffectEvent((decodedText: string) => {
    const now = Date.now();
    if (isExecuting || isExecutingRef.current || (now - lastScanTimeRef.current < 2000)) return;

    const qr = parseQrText(decodedText);
    if (qr) {
      lastScanTimeRef.current = now;
      if (!latestQrDataRef.current || latestQrDataRef.current.enc !== qr.enc) setLatestQrData(qr);
      handleExecute(qr);
    }
  });

  const onTouchStart = (e: React.TouchEvent) => {
    // 如果上一轮被三指打断，新的触摸序列自动解锁，避免永久失效
    if (pinchLockedByMultiTouch.current && e.touches.length <= 2) {
      pinchLockedByMultiTouch.current = false;
      lastTouchDistance.current = null;
    }

    if (e.touches.length >= 3) {
      pinchLockedByMultiTouch.current = true;
      lastTouchDistance.current = null;
      return;
    }
    if (!pinchLockedByMultiTouch.current && e.touches.length === 2) {
      lastTouchDistance.current = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
    }
  };

  const onTouchMove = async (e: React.TouchEvent) => {
    if (e.touches.length >= 3) {
      pinchLockedByMultiTouch.current = true;
      lastTouchDistance.current = null;
      return;
    }
    if (pinchLockedByMultiTouch.current) {
      return;
    }

    if (e.touches.length === 2) {
      const distance = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
      
      // 自动校准初始距离
      if (lastTouchDistance.current === null) {
        lastTouchDistance.current = distance;
        return;
      }

      const zoomStep = (distance - lastTouchDistance.current) / 80;
      const bridge = getNativeBridge();

      try {
        if (bridge && typeof bridge.zoomByPinchDelta === 'function') {
          const nativeZoom = bridge.zoomByPinchDelta(zoomStep);
          if (Number.isFinite(nativeZoom)) {
            currentZoom.current = nativeZoom;
            setDisplayZoom(nativeZoom);
            setShowZoomOverlay(true);
            if (zoomHideTimerRef.current) clearTimeout(zoomHideTimerRef.current);
            lastTouchDistance.current = distance;
          }
          return;
        }

        const videoElement = document.querySelector("#reader video") as HTMLVideoElement;
        const stream = videoElement?.srcObject as MediaStream;
        const track = stream?.getVideoTracks()[0];

        if (!track) return;
        const capabilities = track.getCapabilities();
        if (!capabilities.zoom) return;

        let newZoom = currentZoom.current + zoomStep;
        newZoom = Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, newZoom));
        await track.applyConstraints({ advanced: [{ zoom: newZoom }] });
        currentZoom.current = newZoom;
        setDisplayZoom(newZoom);
        setShowZoomOverlay(true);
        if (zoomHideTimerRef.current) clearTimeout(zoomHideTimerRef.current);
        lastTouchDistance.current = distance;
      } catch (err) {
        console.error("Zoom apply failed", err);
      }
    } else {
      lastTouchDistance.current = null;
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      pinchLockedByMultiTouch.current = false;
    }
    if (e.touches.length < 2) {
      lastTouchDistance.current = null;
      if (showZoomOverlay) {
        if (zoomHideTimerRef.current) clearTimeout(zoomHideTimerRef.current);
        zoomHideTimerRef.current = setTimeout(() => {
          setShowZoomOverlay(false);
        }, 500);
      }
    }
  };

  const getStatusColor = (status: string | undefined) => {
    switch (status) {
      case 'success': return '#10b981';
      case 'failed': return '#ff4d4d';
      case 'signing': return '#3399ff';
      case 'retrying': return '#ffcc00';
      default: return '#cbd5e1';
    }
  };

  const isAllSuccess = orderedTargetUids.length > 0 && orderedTargetUids.every(uid => signStatuses[uid]?.status === 'success');
  const formattedTime = (() => {
    const now = new Date();
    return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  })();

  const stats = {
    signing: Object.values(signStatuses).filter(s => s.status === 'signing').length,
    success: Object.values(signStatuses).filter(s => s.status === 'success').length,
    retry: Object.values(signStatuses).filter(s => s.status === 'retrying').length,
    failed: Object.values(signStatuses).filter(s => s.status === 'failed').length
  };

  return (
    <div
      ref={scannerRef}
      className={`fixed inset-0 z-[100] flex flex-col overflow-hidden ${isNativeBridgeMode && nativePreviewReady ? 'bg-transparent' : 'bg-black'}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      data-native-bridge={isNativeBridgeMode ? '1' : '0'}
      data-native-ready={nativePreviewReady ? '1' : '0'}
    >
      <div id="reader" ref={readerRef} className="w-full h-full" />

      {/* Zoom Multiplier Overlay */}
      <AnimatePresence>
        {showZoomOverlay && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3 }}
            className="absolute top-[calc(24px+var(--sat))] right-4 z-[100] bg-black/40 backdrop-blur-sm border border-white/20 text-white font-bold py-1.5 px-3 rounded-full flex items-center shadow-lg"
          >
            <span className="text-[14px] tracking-widest">{displayZoom.toFixed(1)}x</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Camera Loading Overlay */}
      <AnimatePresence>
        {showLoadingOverlay && (
          <motion.div 
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 z-[110] bg-slate-900 flex flex-col items-center justify-center"
          >
            <div className="relative">
              <div className="w-20 h-20 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
              <Camera className="absolute inset-0 m-auto text-blue-500" size={32} />
            </div>
            <p className="mt-6 text-blue-400 font-bold tracking-widest text-sm animate-pulse px-8 text-center">正在启动相机...</p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute top-0 left-0 right-0 z-20 px-4 pt-[calc(24px+var(--sat))] pb-6 flex items-center justify-center text-white pointer-events-none">
        <button onClick={() => navigate(-1)} className="top-[calc(24px+var(--sat))] left-4 absolute active:opacity-60 transition-opacity pointer-events-auto">
          <ChevronLeft size={32} strokeWidth={1.5} strokeLinecap="square" strokeLinejoin="miter" />
        </button>
        <h2 className="text-[20px] font-normal tracking-widest">扫一扫</h2>
      </div>

      <AnimatePresence>
        {!(isStealthMode && isAllSuccess) && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            className="absolute inset-0 pointer-events-none z-30 flex justify-center"
          >
            <motion.img 
              src={scanCursor} 
              className="w-full absolute" 
              initial={{ top: '5%', opacity: 0 }} 
              animate={{ 
                top: ['5%', '70%'], 
                opacity: [0, 1, 1, 0] 
              }} 
              transition={{ 
                top: {
                  duration: 2.5,
                  repeat: Infinity,
                  ease: "linear",
                },
                opacity: {
                  duration: 2.5,
                  repeat: Infinity,
                  times: [0, 0.1, 0.9, 1],
                  ease: "linear",
                }
              }} 
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isExecuting && !isStealthMode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-30 flex items-end justify-center bg-black/20" onClick={closePopup}>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }} className="bg-white/70 backdrop-blur-md w-full rounded-t-[2rem] shadow-[0_-10px_40px_rgba(0,0,0,0.4)] border-t border-white/20 flex flex-col max-h-[40vh] overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="p-5 pt-7 shrink-0 flex items-center justify-between border-b border-black/5">
                <div className="flex flex-col">
                  <div className="flex items-center space-x-2">
                    <h3 className="text-lg font-black text-slate-900 tracking-tight">签到进度</h3>
                    <div className="flex items-center space-x-1">
                      <AnimatePresence>
                        {stats.signing > 0 && (
                          <motion.span 
                            initial={{ scale: 0.8, opacity: 0 }} 
                            animate={{ scale: 1, opacity: 1 }} 
                            exit={{ scale: 0.8, opacity: 0 }} 
                            className="text-[13px] font-black px-1.5 py-0 rounded-md border border-[#2563eb] text-[#2563eb] bg-white/80 whitespace-nowrap"
                          >
                            签到中 {stats.signing}
                          </motion.span>
                        )}
                        {stats.success > 0 && (
                          <motion.span 
                            initial={{ scale: 0.8, opacity: 0 }} 
                            animate={{ scale: 1, opacity: 1 }} 
                            exit={{ scale: 0.8, opacity: 0 }} 
                            className="text-[13px] font-black px-1.5 py-0 rounded-md border border-[#059669] text-[#059669] bg-white/80 whitespace-nowrap"
                          >
                            成功 {stats.success}
                          </motion.span>
                        )}
                        {stats.retry > 0 && (
                          <motion.span 
                            initial={{ scale: 0.8, opacity: 0 }} 
                            animate={{ scale: 1, opacity: 1 }} 
                            exit={{ scale: 0.8, opacity: 0 }} 
                            className="text-[13px] font-black px-1.5 py-0 rounded-md border border-[#d97706] text-[#d97706] bg-white/80 whitespace-nowrap"
                          >
                            重试 {stats.retry}
                          </motion.span>
                        )}
                        {stats.failed > 0 && (
                          <motion.span 
                            initial={{ scale: 0.8, opacity: 0 }} 
                            animate={{ scale: 1, opacity: 1 }} 
                            exit={{ scale: 0.8, opacity: 0 }} 
                            className="text-[13px] font-black px-1.5 py-0 rounded-md border border-[#e11d48] text-[#e11d48] bg-white/80 whitespace-nowrap"
                          >
                            失败 {stats.failed}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                  {latestQrData && <p className="text-[9px] text-blue-600 font-bold mt-0.5 tracking-tighter text-ellipsis">Enc: {latestQrData.enc}</p>}
                </div>
                <button 
                  onClick={() => isAllSuccess ? navigate(-1) : closePopup()} 
                  className={isAllSuccess ? "px-4 py-1.5 bg-blue-600 text-white rounded-full text-sm font-bold shadow-sm" : "w-8 h-8 flex items-center justify-center bg-slate-900/5 text-slate-400 rounded-full hover:bg-slate-900/10 transition-colors"}
                >
                  {isAllSuccess ? "完成" : "✕"}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 pb-[calc(20px+var(--sab))] space-y-1 custom-scrollbar">
                {orderedTargetUids.map(uid => {
                  const isHost = uid === currentUser?.uid;
                  const student = isHost ? currentUser : (classmates as Classmate[])?.find(m => m.uid === uid);
                  return <ProgressCard key={uid} name={student?.name || "本人"} avatar={student?.avatar} mobile={isHost ? (student as User)?.mobile : (student as Classmate)?.mobile_masked || ""} isHost={isHost} statusObj={signStatuses[uid]} />;
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isExecuting && isStealthMode && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="absolute bottom-10 left-0 right-0 z-40 flex justify-center items-center space-x-4">
            {orderedTargetUids.map(uid => (
              <motion.div key={uid} animate={{ backgroundColor: getStatusColor(signStatuses[uid]?.status), scale: signStatuses[uid]?.status === 'signing' || signStatuses[uid]?.status === 'retrying' ? [1, 1.4, 1] : 1 }} transition={{ repeat: signStatuses[uid]?.status === 'signing' || signStatuses[uid]?.status === 'retrying' ? Infinity : 0, duration: 1 }} className="w-1 h-1 rounded-full shadow-[0_0_5px_rgba(0,0,0,0.5)]" />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute bottom-[calc(48px+var(--sab))] left-8 right-8 z-20 flex items-center justify-between pointer-events-none">
        <div className="flex items-center space-x-6">
          <AnimatePresence initial={false}>
            {!isStealthMode && !isExecuting && (
              <>
                <motion.button 
                  initial={{ x: -120, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -120, opacity: 0 }}
                  transition={{ ease: "easeInOut", duration: 0.3, delay: 0.1 }}
                  type="button" 
                  aria-label="选择扫码签到位置" onClick={() => setIsLocationPickerOpen(true)} 
                  className="flex flex-col items-center space-y-2 group pointer-events-auto active:scale-95 transition-transform"
                >
                  <div className={`w-14 h-14 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 shadow-lg transition-colors ${selectedLocation ? 'bg-blue-600 text-white' : 'bg-black/40 text-white'}`}>
                    <MapPin size={22} />
                  </div>
                  <span className="text-[10px] text-white/80 font-bold tracking-wider truncate max-w-[60px]">
                    {selectedLocation?.name || "位置"}
                  </span>
                </motion.button>

                {requiresPhoto && (
                  <motion.button
                    initial={{ x: -120, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: -120, opacity: 0 }}
                    transition={{ ease: "easeInOut", duration: 0.2 }}
                    type="button"
                    aria-label="人脸验证拍照"
                    onClick={() => navigate('/photo-capture', {
                      state: {
                        ...location.state,
                        activity,
                        course: location.state?.course,
                        existingPhotos: facePhotos,
                        returnTo: '/scanner',
                      },
                    })}
                    className="flex flex-col items-center space-y-2 group pointer-events-auto active:scale-95 transition-transform"
                  >
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 shadow-lg overflow-hidden transition-colors ${facePhotos.length > 0 ? 'bg-emerald-600 text-white' : 'bg-black/40 text-white'}`}>
                      {facePhotos.length > 0 && facePreviews[0]
                        ? <img src={facePreviews[0]} alt="已采集人脸" className="w-full h-full object-cover" />
                        : <ScanFace size={22} />}
                    </div>
                    <span className="text-[10px] text-white/80 font-bold tracking-wider">
                      {facePhotos.length > 0 ? '已采集' : '人脸'}
                    </span>
                  </motion.button>
                )}

                <motion.button 
                  initial={{ x: -120, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -120, opacity: 0 }}
                  transition={{ ease: "easeInOut", duration: 0.3 }}
                  type="button" 
                  onClick={() => setShowCameraList(true)} 
                  className="flex flex-col items-center space-y-2 group pointer-events-auto active:scale-95 transition-transform"
                >
                  <div className="w-14 h-14 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 text-white shadow-lg"><Camera size={22} /></div>
                  <span className="text-[10px] text-white/80 font-bold tracking-wider">切换</span>
                </motion.button>
              </>
            )}
          </AnimatePresence>
        </div>
        <button type="button" onClick={() => setIsStealthMode(!isStealthMode)} className="flex flex-col items-center space-y-2 transition-all duration-500 pointer-events-auto active:scale-95" style={{ opacity: isStealthMode ? 0.1 : 1 }}>
          <div className="w-14 h-14 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 text-white shadow-lg">{isStealthMode ? <Eye size={22} /> : <EyeOff size={22} />}</div>
          <span className="text-[10px] text-white/80 font-bold tracking-wider">{isStealthMode ? "显示" : "隐藏"}</span>
        </button>
      </div>

      <AnimatePresence>
        {isLocationPickerOpen && (
          <LocationDialog title="选择签到位置" description="选择一个常用地点，或不发送位置信息" onClose={() => setIsLocationPickerOpen(false)}>
              <div className="space-y-3">
                <button type="button" aria-pressed={!selectedLocation}
                  onClick={() => { setSelectedLocation(null); setIsLocationPickerOpen(false); }} 
                  className={`w-full text-left p-4 rounded-2xl border flex items-center gap-3 ${!selectedLocation ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 bg-white'}`}
                >
                  <span className="loc-place-icon"><LocateOff size={20} /></span>
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="font-bold text-slate-800 text-sm">不使用位置</div>
                    <div className="loc-note">不发送地理位置信息进行签到</div>
                  </div>
                  {!selectedLocation && <CheckCircle2 size={20} className="text-blue-600 shrink-0" />}
                </button>

                <p className="loc-note">仅展示当前账号可用的地点。可在“我的常用地点”中添加和管理。</p>
                {locationLoading && <p role="status" className="text-sm text-blue-600">正在加载地点…</p>}
                {locationError && <div role="alert" className="text-sm text-red-600">{locationError}<button type="button" onClick={() => void loadSignLocations()} className="ml-2 underline">重新加载</button></div>}
                {!locationLoading && !locationError && signLocations.length === 0 && <p className="text-sm text-slate-500">暂无可用地点，请先保存个人常用地点。</p>}
                {!locationLoading && !locationError && signLocations.map(p => {
                const isSelected = p.id === selectedLocation?.id;
                return (
                  <motion.button type="button" aria-pressed={isSelected} key={p.id} whileTap={{ scale: 0.98 }} onClick={() => { setSelectedLocation(p); setIsLocationPickerOpen(false); }} className={`w-full text-left p-4 rounded-2xl border transition-colors flex items-center gap-3 ${isSelected ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                    <span className="loc-place-icon"><MapPin size={20} /></span>
                    <div className="flex-1 min-w-0"><div className="font-semibold text-slate-800 text-sm break-words">{p.name}</div><div className="loc-note">{p.address}</div>{p.is_personal && <span className="loc-badge mt-2">我的常用</span>}</div>
                    {isSelected && <CheckCircle2 size={20} className="text-blue-600 shrink-0" />}
                  </motion.button>
                );
              })}</div>
          </LocationDialog>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isStealthMode && isAllSuccess && (
          <motion.div 
            initial={{ opacity: 1 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            transition={{ duration: 0 }}
            className="fixed inset-0 bg-white z-[200] flex flex-col font-sans pt-[var(--sat)] pb-[var(--sab)]"
          >
            <div className="bg-white h-[44px] flex items-center px-1 shrink-0">
              <button onClick={() => navigate(-1)} className="p-2">
                <ChevronLeft size={33} className="text-[#333]" strokeWidth={1.3} />
              </button>
              <div className="flex-1 text-center text-[21px] text-[#333] pr-10">
                签到
              </div>
            </div>

            <div className="flex-1 bg-white flex flex-col pt-0 justify-center">
              <div className="flex-1"></div>
              <div className="flex-4 bg-white px-5 pt-12 pb-8 flex flex-col items-center">
                <div className="w-[50px] h-[50px] mb-5">
                  <img 
                    src="https://mobilelearn-static.chaoxing.com/mobilelearn/front/mobile/sign/images/sign-icon-succeed-green.png" 
                    className="w-full h-full object-contain"
                    alt="success"
                  />
                </div>
                <h1 className="text-[26px] text-[#666666] mb-2 leading-none">
                  签到成功
                </h1>
                <p className="text-[17px] text-[#B3B3B3] signtime pt-1">{formattedTime}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {showCameraList && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4 pointer-events-auto" onClick={() => setShowCameraList(false)}>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} className="bg-white w-full max-w-sm rounded-[2rem] p-6 shadow-2xl relative" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-black mb-4 text-slate-900">选择摄像头</h3>
              <div className="space-y-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
                {cameras.map(camera => (
                  <button key={camera.id} type="button" onClick={() => { setSelectedDeviceId(camera.id); setShowCameraList(false); }} className={`w-full p-4 rounded-xl text-left font-bold transition-all flex items-center justify-between ${selectedDeviceId === camera.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
                    <span className="truncate">{camera.label || `摄像头 ${camera.id.substring(0, 5)}`}</span>
                    {selectedDeviceId === camera.id && <div className="w-2 h-2 bg-white rounded-full" />}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setShowCameraList(false)} className="w-full mt-4 py-3 text-slate-400 font-bold">取消</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        #reader__dashboard, #reader__status_span, #reader img { display: none !important; }
        #reader video { object-fit: cover !important; width: 100% !important; height: 100% !important; }
        #reader { background: black !important; }
        [data-native-bridge="1"][data-native-ready="1"] #reader { background: transparent !important; }
        [data-native-bridge="1"][data-native-ready="1"] #reader video { opacity: 0 !important; }
        .custom-scrollbar::-webkit-scrollbar { width: 0px; }
      `}</style>
    </div>
  );
};

export default FullScanner;
