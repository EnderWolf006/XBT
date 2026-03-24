import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Camera, EyeOff, Eye, MapPin, CheckCircle2 } from 'lucide-react';
import { Html5Qrcode, type CameraDevice } from 'html5-qrcode';
import toast from 'react-hot-toast';
import client from '../api/client';
import { useAuthStore } from '../store/auth';
import { ProgressCard } from '../components/sign/ProgressCard';
import type { ApiResponse, SignStatusMessage, Classmate, User } from '../types';
import scanCursor from '../assets/scan_cursor.png';
import config from '../../config.yaml';

const LOCATION_PRESETS = config.sign?.location_presets || [];

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

  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locationStr, setLocationStr] = useState('');
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);

  const latRef = useRef('');
  const lngRef = useRef('');
  const locationStrRef = useRef('');
  const lastScanTimeRef = useRef<number>(0);

  useEffect(() => {
    latRef.current = lat;
    lngRef.current = lng;
    locationStrRef.current = locationStr;
  }, [lat, lng, locationStr]);
  
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
  const scanSuccessHandlerRef = useRef<(decodedText: string) => void>(() => {});

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

  const syncReaderPunchHole = () => {
    const bridge = getNativeBridge();
    const reader = readerRef.current;
    if (!bridge || !reader || typeof bridge.syncPunchHole !== 'function') return;
    const rect = reader.getBoundingClientRect();
    bridge.syncPunchHole(rect.left, rect.top, rect.width, rect.height);
  };

  const setNativeLensFacing = (deviceId: string | null) => {
    const bridge = getNativeBridge();
    if (!bridge || typeof bridge.setLensFacing !== 'function' || !deviceId) return;
    const selected = cameras.find((c) => c.id === deviceId);
    const label = selected?.label?.toLowerCase() ?? '';
    const facing: 'user' | 'environment' = /front|user|前置|自拍/.test(label) ? 'user' : 'environment';
    bridge.setLensFacing(facing);
  };

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
  }, [selectedDeviceId, cameras]);

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
  }, [activity]);

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
    if (isNativeBridgeModeRef.current) {
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
    if (!selectedDeviceId && !isNativeBridgeModeRef.current) return;

    const bridge = getNativeBridge();
    if (bridge) {
      setNativePreviewReady(false);
      setIsCameraReady(false);
      setNativeLensFacing(selectedDeviceId);
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
          if (!selectedDeviceId) return;

          const html5QrCode = new Html5Qrcode("reader");
          activeScannerRef.current = html5QrCode;

          await html5QrCode.start(
            selectedDeviceId,
            {
              fps: 30,
              aspectRatio: 1.777778,
              videoConstraints: {
                deviceId: { exact: selectedDeviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                advanced: [{ focusMode: "continuous" } as any]
              }
            },
            onScanSuccess,
            onScanFailure
          );
          
          setIsCameraReady(true);
          
          if ('BarcodeDetector' in window) {
            const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
            const videoElement = document.querySelector("#reader video") as HTMLVideoElement;
            const nativeScanLoop = async () => {
              if (!isMounted || !activeScannerRef.current) return;
              if (videoElement && videoElement.readyState >= 2) {
                try {
                  const barcodes = await detector.detect(videoElement);
                  if (barcodes.length > 0) onScanSuccess(barcodes[0].rawValue);
                } catch (e) {}
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
          try { if (scanner.isScanning) await scanner.stop(); } catch (e) {}
          activeScannerRef.current = null;
          const container = document.getElementById("reader");
          if (container) container.innerHTML = "";
        }
      });
    };
  }, [activity, navigate, scannerSessionKey]);

  useEffect(() => {
    if (!isNativeBridgeModeRef.current) return;
    syncReaderPunchHole();
    const reader = readerRef.current;
    if (!reader) return;

    const observer = new ResizeObserver(() => syncReaderPunchHole());
    observer.observe(reader);
    window.addEventListener('resize', syncReaderPunchHole);
    window.addEventListener('scroll', syncReaderPunchHole, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncReaderPunchHole);
      window.removeEventListener('scroll', syncReaderPunchHole);
    };
  }, [isCameraReady]);

  useEffect(() => {
    if (!isNativeBridgeMode) return;
    const onNativeQr = (event: Event) => {
      const customEvent = event as CustomEvent<{ text?: string }>;
      const text = customEvent.detail?.text;
      if (typeof text === 'string' && text.length > 0) {
        scanSuccessHandlerRef.current(text);
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
    } catch (e) {
      const encMatch = text.match(/[?&]enc=([^&]+)/);
      const cMatch = text.match(/[?&]c=([^&]+)/);
      if (encMatch) return { enc: encMatch[1], c: cMatch ? cMatch[1] : '', timestamp: Date.now() };
    }
    return null;
  };

  const handleExecute = async (initialQr: QrData) => {
    if (isExecutingRef.current) return;
    setIsExecuting(true);
    isExecutingRef.current = true;
    abortControllerRef.current = new AbortController();
    
    const initialStatuses: Record<number, any> = {};
    orderedTargetUids.forEach(uid => initialStatuses[uid] = { status: 'pending', message: '等待中' });
    setSignStatuses(initialStatuses);

    try {
      // 1. Check current sign status first
      const checkResp = await client.post<ApiResponse<{ items: any[] }>>('/sign/check', {
        activity_id: activity.active_id,
        user_ids: orderedTargetUids
      }, {
        signal: abortControllerRef.current?.signal
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
            const special_params: Record<string, any> = { enc: currentQr.enc, c: currentQr.c };
            if (latRef.current && lngRef.current) {
              special_params.latitude = latRef.current;
              special_params.longitude = lngRef.current;
              special_params.description = locationStrRef.current;
            }
            const execResp = await client.post<ApiResponse<any>>('/sign/execute', {
              activity_id: activity.active_id, target_uid: uid, sign_type: 2,
              course_id: activity.course_id, class_id: activity.class_id, if_refresh_ewm: activity.if_refresh_ewm,
              special_params
            }, {
              signal: abortControllerRef.current?.signal
            });
            const res = execResp.data.data;
            if (res.success || res.already_signed) {
              setSignStatuses(prev => ({ ...prev, [uid]: { status: 'success', message: res.message || '成功' } }));
              return;
            }
            lastError = res.message || '失败';
            setSignStatuses(prev => ({ ...prev, [uid]: { ...prev[uid], message: lastError } }));
          } catch (err: any) { 
            if (err.name === 'CanceledError' || err.name === 'AbortError') return;
            lastError = err.message || '异常'; 
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
    } catch (error: any) {
      if (error.name !== 'CanceledError' && error.name !== 'AbortError') {
        toast.error(error.message || '执行过程出错');
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  const onScanSuccess = (decodedText: string) => {
    const now = Date.now();
    if (isExecuting || isExecutingRef.current || (now - lastScanTimeRef.current < 2000)) return;

    const qr = parseQrText(decodedText);
    if (qr) {
      lastScanTimeRef.current = now;
      if (!latestQrDataRef.current || latestQrDataRef.current.enc !== qr.enc) setLatestQrData(qr);
      handleExecute(qr);
    }
  };

  useEffect(() => {
    scanSuccessHandlerRef.current = onScanSuccess;
  }, [onScanSuccess]);

  const onScanFailure = () => {};

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
        const capabilities = track.getCapabilities() as any;
        if (!capabilities.zoom) return;

        let newZoom = currentZoom.current + zoomStep;
        newZoom = Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, newZoom));
        await track.applyConstraints({ advanced: [{ zoom: newZoom } as any] });
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
                  onClick={() => setIsLocationPickerOpen(true)} 
                  className="flex flex-col items-center space-y-2 group pointer-events-auto active:scale-95 transition-transform"
                >
                  <div className={`w-14 h-14 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 shadow-lg transition-colors ${lat ? 'bg-blue-600 text-white' : 'bg-black/40 text-white'}`}>
                    <MapPin size={22} />
                  </div>
                  <span className="text-[10px] text-white/80 font-bold tracking-wider truncate max-w-[60px]">
                    {lat ? LOCATION_PRESETS.find((p: any) => p.lat === lat)?.name || "位置" : "位置"}
                  </span>
                </motion.button>

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
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-end justify-center bg-slate-900/60 backdrop-blur-md p-0" onClick={() => setIsLocationPickerOpen(false)}>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 250 }} className="bg-white w-full max-w-[480px] rounded-t-[3rem] p-8 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
              <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-8 shrink-0" />
              <div className="flex items-center justify-between mb-6 shrink-0"><h3 className="text-xl font-bold text-slate-900">选择签到位置</h3><button onClick={() => setIsLocationPickerOpen(false)} className="w-8 h-8 flex items-center justify-center bg-slate-100 text-slate-400 rounded-full">✕</button></div>
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-[calc(40px+var(--sab))] custom-scrollbar px-1">
                <motion.div 
                  whileTap={{ scale: 0.98 }} 
                  onClick={() => { setLat(''); setLng(''); setLocationStr(''); setIsLocationPickerOpen(false); }} 
                  className={`p-5 rounded-[1.5rem] border-2 transition-all cursor-pointer flex items-center justify-between ${!lat ? 'border-blue-500 bg-blue-50/30' : 'border-slate-50 bg-slate-100/50 hover:bg-white'}`}
                >
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="font-bold text-slate-800 text-sm">不使用位置</div>
                    <div className="text-[10px] text-slate-400 font-medium">不发送地理位置信息进行签到</div>
                  </div>
                  {!lat && <CheckCircle2 size={20} className="text-blue-600 shrink-0" />}
                </motion.div>

                {LOCATION_PRESETS.map((p: any, i: number) => {
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
