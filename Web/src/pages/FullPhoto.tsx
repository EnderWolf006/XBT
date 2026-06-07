import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Camera, EyeOff, Eye, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth';

type NativeCameraBridge = {
  isReady?: () => boolean;
  getCameraState?: () => string;
  setScannerActive?: (active: boolean) => void;
  setLensFacing?: (mode: 'user' | 'environment') => void;
  zoomByPinchDelta?: (delta: number) => number;
  syncPunchHole?: (left: number, top: number, width: number, height: number) => void;
  takePhoto?: () => void;
};

type WindowWithBridge = Window & {
  XBTCameraBridge?: NativeCameraBridge;
};

const getFriendlyCameraLabel = (label: string, index: number) => {
  const raw = (label || '').trim();
  const lower = raw.toLowerCase();
  if (/back|rear|environment|后置|后面|背面/.test(lower)) return '后置摄像头';
  if (/front|user|前置|自拍/.test(lower)) return '前置摄像头';
  if (/external|usb|外接/.test(lower)) return '外接摄像头';
  if (raw) return raw;
  return `摄像头 ${index + 1}`;
};

const FullPhoto = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user: currentUser } = useAuthStore();
  
  const { activity, existingPhotos } = location.state || {};

  useEffect(() => {
    if (!activity) {
      navigate('/');
    }
  }, [activity, navigate]);
  
  const [capturedFiles, setCapturedFiles] = useState<File[]>(existingPhotos || []);
  const [capturedPreviews, setCapturedPreviews] = useState<string[]>(() => 
    (existingPhotos || []).map((f: File) => URL.createObjectURL(f))
  );
  
  const [isStealthMode, setIsStealthMode] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);

  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [showCameraList, setShowCameraList] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  
  const isNativeBridgeModeRef = useRef(false);
  const [isNativeBridgeMode, setIsNativeBridgeMode] = useState(false);
  const [nativePreviewReady, setNativePreviewReady] = useState(false);
  const nativePreviewReadyRef = useRef(false);
  const selectedDeviceIdRef = useRef<string | null>(null);

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

  const setNativeLensFacing = (deviceId: string | null) => {
    const bridge = getNativeBridge();
    if (!bridge || typeof bridge.setLensFacing !== 'function' || !deviceId) return;
    const selected = cameras.find((c) => c.id === deviceId);
    const label = (selected?.label || '').toLowerCase();
    const facing: 'user' | 'environment' = /front|user|前置|自拍/.test(label) ? 'user' : 'environment';
    bridge.setLensFacing(facing);
  };

  const syncReaderPunchHole = () => {
    const bridge = getNativeBridge();
    const reader = readerRef.current;
    if (!bridge || !reader || typeof bridge.syncPunchHole !== 'function') return;
    const rect = reader.getBoundingClientRect();
    bridge.syncPunchHole(rect.left, rect.top, rect.width, rect.height);
  };

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
    const bridge = getNativeBridge();
    isNativeBridgeModeRef.current = !!bridge;
    setIsNativeBridgeMode(!!bridge);
    setNativePreviewReady(false);
    
    if (bridge) {
      setSelectedDeviceId('__native_environment__');
      setCameras([
        { id: '__native_environment__', label: '后置摄像头' },
        { id: '__native_user__', label: '前置摄像头' },
      ]);
    } else {
      const initWebCamera = async () => {
        try {
          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const stream = await navigator.mediaDevices.getUserMedia({ 
              video: { facingMode: { ideal: 'environment' } } 
            });
            stream.getTracks().forEach(t => t.stop());
          }
          
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoDevices = devices.filter(d => d.kind === 'videoinput');
          const normalized = videoDevices.map((d, i) => ({ 
            id: d.deviceId, 
            label: getFriendlyCameraLabel(d.label, i) 
          }));
          
          setCameras(normalized);
          if (normalized.length > 0) {
            const back = normalized.find(d => 
              /back|rear|environment|后置|后面|背面/.test(d.label.toLowerCase())
            );
            setSelectedDeviceId(back ? back.id : normalized[normalized.length - 1].id);
          } else {
            setIsCameraReady(true);
            toast.error("未检测到摄像头设备");
          }
        } catch (err) {
          console.error("Web camera init error:", err);
          setIsCameraReady(true);
          toast.error("无法访问摄像头，请检查权限设置");
        }
      };
      initWebCamera();
    }
  }, []);

  useEffect(() => {
    if (isCameraReady) {
      const timer = setTimeout(() => setShowLoadingOverlay(false), 50);
      return () => clearTimeout(timer);
    }
    setShowLoadingOverlay(true);
  }, [isCameraReady]);

  useEffect(() => {
    const handleFullScreen = async () => {
      try {
        if (isStealthMode) {
          if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        } else {
          if (document.fullscreenElement) await document.exitFullscreen();
        }
      } catch (err) {
        console.warn("Fullscreen toggle failed:", err);
      }
    };
    handleFullScreen();
  }, [isStealthMode]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      const bridge = getNativeBridge();
      bridge?.setScannerActive?.(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      capturedPreviews.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);


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
      setNativeLensFacing(selectedDeviceIdRef.current || '__native_environment__');

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
      touchedElements.forEach(({ el, bg }) => {
        el.style.backgroundColor = bg;
      });
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.backgroundColor = prevBodyBg;
      if (root) root.style.backgroundColor = prevRootBg;
      window.removeEventListener('xbt-native-camera-state', onCameraState);
    };
  }, [isNativeBridgeMode]);

  useEffect(() => {
    if (!isNativeBridgeMode || nativePreviewReady) return;
    let disposed = false;
    let tickCount = 0;
    const maxTicks = 24; 
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
        //
      }
      tickCount += 1;
      if (tickCount >= maxTicks) clearInterval(timer);
    }, 150);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [isNativeBridgeMode, nativePreviewReady]);

  useEffect(() => {
    if (!isNativeBridgeMode) return;
    syncReaderPunchHole();
    const reader = readerRef.current;
    if (!reader) return;

    const observer = new ResizeObserver(() => syncReaderPunchHole());
    observer.observe(reader);
    window.addEventListener('resize', syncReaderPunchHole);
    window.addEventListener('scroll', syncReaderPunchHole, { passive: true });

    let lastTouchDistance = 0;
    const getDistance = (touches: TouchList) => {
      return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        lastTouchDistance = getDistance(e.touches);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && lastTouchDistance > 0) {
        const currentDistance = getDistance(e.touches);
        const delta = (currentDistance - lastTouchDistance) * 0.01;
        
        const bridge = getNativeBridge();
        if (bridge && typeof bridge.zoomByPinchDelta === 'function') {
          bridge.zoomByPinchDelta(delta);
        }
        lastTouchDistance = currentDistance;
      }
    };

    const handleTouchEnd = () => {
      lastTouchDistance = 0;
    };

    reader.addEventListener('touchstart', handleTouchStart, { passive: true });
    reader.addEventListener('touchmove', handleTouchMove, { passive: true });
    reader.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncReaderPunchHole);
      window.removeEventListener('scroll', syncReaderPunchHole);
      reader.removeEventListener('touchstart', handleTouchStart);
      reader.removeEventListener('touchmove', handleTouchMove);
      reader.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isNativeBridgeMode, isCameraReady]);

  useEffect(() => {
    if (isNativeBridgeMode || !selectedDeviceId) return;

    let isMounted = true;
    const startCamera = async () => {
      setIsCameraReady(false);
      try {
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { 
            deviceId: { exact: selectedDeviceId }, 
            width: { ideal: 1280 }, 
            height: { ideal: 720 },
            facingMode: /back|rear|environment/.test(cameras.find(c => c.id === selectedDeviceId)?.label.toLowerCase() || '') ? 'environment' : 'user'
          }
        });
        if (!isMounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onplaying = () => {
            if (isMounted) setIsCameraReady(true);
          };
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play().catch(() => {});
          };
        }
      } catch (err) {
        if (isMounted) {
          console.error("Web camera start failed:", err);
          toast.error("相机启动失败，请确保权限已开启");
          setIsCameraReady(true);
        }
      }
    };

    startCamera();
    return () => { isMounted = false; };
  }, [selectedDeviceId, isNativeBridgeMode]);

  const handleCapture = async () => {
    if (isCapturing) return;
    setIsCapturing(true);

    try {
      let photoBlob: Blob | null = null;

      if (isNativeBridgeMode) {
        const bridge = getNativeBridge();
        if (bridge && typeof bridge.takePhoto === 'function') {
          const possibleResult = (bridge.takePhoto as any)();
          
          if (possibleResult instanceof Promise) {
            const base64 = await possibleResult;
            if (typeof base64 === 'string' && base64.length > 100) {
              const byteString = atob(base64.split(',')[1] || base64);
              const ia = new Uint8Array(byteString.length);
              for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
              photoBlob = new Blob([ia], { type: 'image/jpeg' });
            }
          }

          if (!photoBlob) {
            photoBlob = await new Promise<Blob | null>((resolve) => {
              const timeout = setTimeout(() => {
                cleanup();
                resolve(null);
              }, 6000);

              const onPhoto = (e: any) => {
                const base64 = e.detail?.base64 || e.base64 || (typeof e === 'string' ? e : null);
                if (typeof base64 === 'string' && base64.length > 100) {
                  clearTimeout(timeout);
                  cleanup();
                  const byteString = atob(base64.split(',')[1] || base64);
                  const ia = new Uint8Array(byteString.length);
                  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                  resolve(new Blob([ia], { type: 'image/jpeg' }));
                }
              };

              (window as any).onXBTNativePhoto = onPhoto;

              const events = ['xbt-native-photo', 'xbt-native-camera-photo', 'native-photo'];
              const targets = [window, document];

              events.forEach(ev => {
                targets.forEach(target => target.addEventListener(ev, onPhoto));
              });

              function cleanup() {
                delete (window as any).onXBTNativePhoto;
                events.forEach(ev => {
                  targets.forEach(target => target.removeEventListener(ev, onPhoto));
                });
              }
            });
          }
        } else {
          console.warn("Bridge found but takePhoto is not a function");
        }
      }

      if (!photoBlob && videoRef.current) {
        const video = videoRef.current;
        if (video.readyState >= 2) {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0);
            photoBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
          }
        }
      }

      if (!photoBlob) {
        toast.error(isNativeBridgeMode ? "原生相机拍照超时，请重试" : "拍照失败，请重试");
        setIsCapturing(false);
        return;
      }

      const file = new File([photoBlob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      const url = URL.createObjectURL(photoBlob);
      
      setCapturedFiles(prev => [...prev, file]);
      setCapturedPreviews(prev => [...prev, url]);
      toast.success("已添加至照片池");
    } catch (err) {
      console.error("Capture error:", err);
      toast.error("处理照片失败");
    } finally {
      setIsCapturing(false);
    }
  };

  const handleFinish = () => {
    if (capturedFiles.length === 0) {
      navigate(-1);
      return;
    }
    navigate(`/sign/${activity.active_id}`, {
      state: {
        ...location.state,
        returnedPhotos: capturedFiles
      },
      replace: true
    });
  };

  const removePhoto = (index: number) => {
    const url = capturedPreviews[index];
    if (url) URL.revokeObjectURL(url);
    setCapturedFiles(prev => prev.filter((_, i) => i !== index));
    setCapturedPreviews(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div 
      className={`fixed inset-0 z-[100] flex flex-col overflow-hidden ${isNativeBridgeMode && nativePreviewReady ? 'bg-transparent' : 'bg-black'}`}
      data-native-bridge={isNativeBridgeMode ? '1' : '0'}
      data-native-ready={nativePreviewReady ? '1' : '0'}
    >
      <div id="reader" ref={readerRef} className="w-full h-full">
        {!isNativeBridgeMode && (
          <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
        )}
      </div>

      <AnimatePresence>
        {showLoadingOverlay && (
          <motion.div exit={{ opacity: 0 }} className="absolute inset-0 z-[110] bg-slate-900 flex flex-col items-center justify-center">
            <div className="relative">
              <div className="w-20 h-20 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
              <Camera className="absolute inset-0 m-auto text-blue-500" size={32} />
            </div>
            <p className="mt-6 text-blue-400 font-bold text-sm animate-pulse">正在启动相机...</p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute top-0 left-0 right-0 z-20 px-4 pt-[calc(24px+var(--sat))] flex items-center justify-between text-white pointer-events-none">
        <button onClick={() => navigate(-1)} className="p-2 active:opacity-60 transition-opacity pointer-events-auto">
          <ChevronLeft size={32} />
        </button>
        <h2 className="text-[20px] font-normal tracking-widest">拍照签到</h2>
        <button 
          onClick={handleFinish}
          className="px-4 py-1.5 bg-blue-600 text-white rounded-full text-sm font-bold shadow-sm pointer-events-auto active:scale-95 transition-transform"
        >
          完成 {capturedFiles.length > 0 && `(${capturedFiles.length})`}
        </button>
      </div>

      <div className="absolute bottom-[calc(48px+var(--sab))] left-0 right-0 z-20 flex flex-col items-center gap-6 px-8">
        {/* 已经拍完的照片和上传的照片 */}
        {capturedPreviews.length > 0 && (
          <div className="w-full flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar no-scrollbar">
            {capturedPreviews.map((url, index) => (
              <div key={url} className="relative shrink-0 w-16 h-16 rounded-xl border-2 border-white/20 overflow-hidden shadow-lg">
                <img src={url} className="w-full h-full object-cover" />
                <button 
                  onClick={() => removePhoto(index)}
                  className="absolute top-0 right-0 bg-black/50 text-white p-0.5 rounded-bl-lg"
                >
                  <ChevronLeft size={12} className="rotate-45" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-8">
          <button onClick={() => setShowCameraList(true)} className="w-14 h-14 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 text-white shadow-lg pointer-events-auto">
            <Camera size={22} />
          </button>
          <button 
            onClick={handleCapture}
            disabled={isCapturing}
            className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-2xl active:scale-90 transition-transform disabled:opacity-50 pointer-events-auto"
          >
            <div className="w-16 h-16 border-4 border-slate-900 rounded-full flex items-center justify-center">
              {isCapturing ? <Loader2 className="animate-spin text-slate-900" /> : <div className="w-12 h-12 bg-slate-900 rounded-full" />}
            </div>
          </button>
          <button onClick={() => setIsStealthMode(!isStealthMode)} className={`w-14 h-14 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 text-white shadow-lg transition-opacity pointer-events-auto ${isStealthMode ? 'opacity-20' : ''}`}>
            {isStealthMode ? <Eye size={22} /> : <EyeOff size={22} />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {showCameraList && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4 pointer-events-auto" onClick={() => setShowCameraList(false)}>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} className="bg-white w-full max-w-sm rounded-[2rem] p-6 shadow-2xl relative" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-black mb-4 text-slate-900">选择摄像头</h3>
              <div className="space-y-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
                {cameras.map(camera => (
                  <button key={camera.id} type="button" onClick={() => { setSelectedDeviceId(camera.id); setShowCameraList(false); }} className={`w-full p-4 rounded-xl text-left font-bold transition-all flex items-center justify-between ${selectedDeviceId === camera.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
                    <span className="truncate">{camera.label}</span>
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
        video { object-fit: cover; }
        #reader video { object-fit: cover !important; width: 100% !important; height: 100% !important; }
        #reader { background: black !important; }
        [data-native-bridge="1"][data-native-ready="1"] #reader { background: transparent !important; }
        [data-native-bridge="1"][data-native-ready="1"] #reader video { opacity: 0 !important; }
        .custom-scrollbar::-webkit-scrollbar { width: 0px; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
};

export default FullPhoto;

