import { useCallback, useEffect, useRef, useState } from 'react';
import client from '../api/client';
import type { ApiResponse } from '../types';
import { getErrorMessage } from '../utils/errors';
import { captureLocationPreview, type GPSPreview, type Point } from '../utils/locationPreview';
import { Search, MapPin, LocateFixed, Plus, Minus, Crosshair, Loader2, Info, Check, RotateCcw } from 'lucide-react';

type AMapCenter = { getLng: () => number; getLat: () => number };
type AMapInstance = {
  getCenter: () => AMapCenter;
  getZoom: () => number;
  resize: () => void;
  setCenter: (center: [number, number]) => void;
  setZoom: (zoom: number) => void;
  on: (event: 'move' | 'moveend', callback: () => void) => void;
  off: (event: 'move' | 'moveend', callback: () => void) => void;
  destroy: () => void;
};
type AMapConstructor = new (container: HTMLElement, options: {
  center: [number, number];
  zoom: number;
  viewMode: '2D';
  resizeEnable: boolean;
  dragEnable: boolean;
  zoomEnable: boolean;
}) => AMapInstance;
type AMapNamespace = { Map: AMapConstructor };

declare global {
  interface Window {
    AMap?: AMapNamespace;
    _AMapSecurityConfig?: { serviceHost: string };
  }
}

type MapConfig = { key: string; service_path: string };
type MapPreview = { center: Point };
type Props = {
  initialPoint: Point | null;
  onSelect: (point: Point & { source: 'map_pick' | 'device_gps' }) => void | Promise<void>;
  onBusy: (busy: boolean) => void;
  selectionMode?: boolean;
  apiBase?: string;
  initialCampusReference?: boolean;
  allowOverview?: boolean;
};

let sdkPromise: Promise<AMapNamespace> | null = null;

function loadAMap(config: MapConfig): Promise<AMapNamespace> {
  window._AMapSecurityConfig = { serviceHost: `${window.location.origin}${config.service_path}` };
  if (window.AMap) return Promise.resolve(window.AMap);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<AMapNamespace>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}`;
    script.async = true;
    script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error('高德地图脚本加载后未初始化'));
    script.onerror = () => reject(new Error('高德地图加载失败，请检查 Web端（JS API）Key 来源白名单与网络'));
    document.head.appendChild(script);
  }).catch(error => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

function readCenter(map: AMapInstance): Point {
  const center = map.getCenter();
  return {
    latitude: Math.round(center.getLat() * 1e6) / 1e6,
    longitude: Math.round(center.getLng() * 1e6) / 1e6,
  };
}

export default function InteractiveSignMap({
  initialPoint,
  onSelect,
  onBusy,
  selectionMode = true,
  apiBase = '/sign/locations',
  initialCampusReference = false,
  allowOverview = false,
}: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMapInstance | null>(null);
  const initialPointRef = useRef(initialPoint);
  const mapInteracted = useRef(false);
  const [center, setCenter] = useState<Point | null>(initialPoint);
  const [gps, setGPS] = useState<GPSPreview | null>(null);
  const [ready, setReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [locationMessage, setLocationMessage] = useState('');
  const [overview, setOverview] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onBusy(busy || selecting);
    return () => onBusy(false);
  }, [busy, onBusy, selecting]);

  const syncCenter = useCallback(() => {
    if (!mapRef.current) return;
    setCenter(readCenter(mapRef.current));
    setConfirmed(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    const capturePromise = selectionMode
      ? captureLocationPreview(`${apiBase}/coordinate-preview`)
        .then(preview => {
          if (!cancelled) {
            setGPS(preview);
            setLocationMessage(preview.poor_accuracy ? '当前定位精度较低，请人工核对地图中心。' : '');
          }
          return preview.point;
        })
        .catch(cause => {
          if (!cancelled) setLocationMessage(getErrorMessage(cause, '无法获取当前位置，可直接拖动地图选点。'));
          return null;
        })
      : Promise.resolve(null);

    void (async () => {
      try {
        const configResponse = await client.get<ApiResponse<MapConfig>>('/sign/locations/map-config');
        const config = configResponse.data.data;
        if (!config.key || !config.service_path) throw new Error('交互地图配置不完整');
        const [sdk, fallback] = await Promise.all([
          loadAMap(config),
          initialPointRef.current ? Promise.resolve(initialPointRef.current) : (selectionMode || allowOverview)
            ? Promise.resolve(null)
            : client.post<ApiResponse<MapPreview>>(
              `${apiBase}/map-preview`, { center: null, zoom: 16 },
            ).then(response => response.data.data.center),
        ]);
        if (cancelled || !mapContainer.current) return;
        const start = initialPointRef.current ?? fallback;
        setOverview(start === null);
        const instance = new sdk.Map(mapContainer.current, {
          center: start ? [start.longitude, start.latitude] : [104, 35],
          zoom: start ? 16 : 4,
          viewMode: '2D',
          resizeEnable: true,
          dragEnable: true,
          zoomEnable: true,
        });
        mapRef.current = instance;
        instance.on('move', syncCenter);
        instance.on('moveend', syncCenter);
        setCenter(readCenter(instance));
        setReady(true);
        setBusy(false);
        resizeObserver = new ResizeObserver(() => {
          instance.resize();
          syncCenter();
        });
        resizeObserver.observe(mapContainer.current);
        const currentLocation = await capturePromise;
        if (!cancelled && currentLocation && !initialPointRef.current && !mapInteracted.current) {
          instance.setCenter([currentLocation.longitude, currentLocation.latitude]);
          instance.setZoom(16);
          setOverview(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(getErrorMessage(cause, '交互地图初始化失败，请重试。'));
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (mapRef.current) {
        mapRef.current.off('move', syncCenter);
        mapRef.current.off('moveend', syncCenter);
        mapRef.current.destroy();
        mapRef.current = null;
      }
    };
  }, [apiBase, selectionMode, allowOverview, syncCenter, attempt]);

  const returnToLocation = async () => {
    if (!selectionMode || selecting) return;
    mapInteracted.current = true;
    setSelecting(true);
    setError('');
    try {
      const preview = await captureLocationPreview(`${apiBase}/coordinate-preview`);
      setGPS(preview);
      setLocationMessage(preview.poor_accuracy ? '当前定位精度较低，请人工核对地图中心。' : '');
      mapRef.current?.setCenter([preview.point.longitude, preview.point.latitude]);
      mapRef.current?.setZoom(16);
      setOverview(false);
    } catch (cause) {
      setError(getErrorMessage(cause, '现场定位失败，请检查定位权限后重试。'));
    } finally {
      setSelecting(false);
    }
  };

  const [searchKeywords, setSearchKeywords] = useState('');
  const [searchInfo, setSearchInfo] = useState('');
  const [searchCandidates, setSearchCandidates] = useState<Array<Point & { name: string; address: string; amap_poi_id?: string }>>([]);
  const [searching, setSearching] = useState(false);

  const searchMap = async () => {
    const keywords = searchKeywords.trim();
    if (!keywords) {
      setError('请输入地点名或地址后再搜索。');
      return;
    }
    if (searching || !mapRef.current) return;
    mapInteracted.current = true;
    setSearching(true);
    setSearchInfo('正在搜索地点…');
    setSearchCandidates([]);
    setError('');
    setConfirmed(false);
    try {
      const response = await client.post<ApiResponse<Array<Point & { name: string; address: string; amap_poi_id?: string }>>>(
        `${apiBase}/search-map`, { keywords, scope: 'full' },
      );
      const rows = response.data.data ?? [];
      if (rows.length === 0) {
        setSearchInfo('');
        setError('没有找到匹配地点，请换一个更具体的地点名或地址。');
      } else if (rows.length === 1) {
        mapRef.current.setCenter([rows[0].longitude, rows[0].latitude]);
        mapRef.current.setZoom(16);
        setOverview(false);
        setSearchInfo(`已找到“${rows[0].name}”，地图已移动到该候选中心；请核对十字后再确认。`);
      } else {
        setSearchInfo(`全域搜索找到 ${rows.length} 个候选（最多查询 75 条），请选择一个作为地图中心。`);
        setSearchCandidates(rows);
      }
    } catch (cause) {
      setSearchInfo('');
      setError(getErrorMessage(cause, '搜索地点失败，请重试。'));
    } finally {
      setSearching(false);
    }
  };

  const chooseSearchCandidate = (candidate: Point & { name: string }) => {
    mapRef.current?.setCenter([candidate.longitude, candidate.latitude]);
    mapRef.current?.setZoom(16);
    setOverview(false);
    setSearchInfo(`已选择“${candidate.name}”作为地图中心；请核对十字后再确认。`);
    setSearchCandidates([]);
  };

  const confirmPoint = async () => {
    if (!confirmed || !mapRef.current || selecting) return;
    setSelecting(true);
    setError('');
    try {
      await onSelect({ ...readCenter(mapRef.current), source: 'map_pick' });
    } catch (cause) {
      setError(getErrorMessage(cause, '无法使用该地图中心，请重试。'));
    } finally {
      setSelecting(false);
    }
  };

  return <section aria-label="地图选点签到" className="location-ui loc-map">
    <form onSubmit={event => { event.preventDefault(); void searchMap(); }}>
      <label className="sr-only" htmlFor={`map-search-${selectionMode ? 'sign' : 'save'}`}>全域搜索地点名或地址</label>
      <div className="loc-map-search">
        <Search size={18} aria-hidden="true" />
        <input id={`map-search-${selectionMode ? 'sign' : 'save'}`} value={searchKeywords} onChange={event => setSearchKeywords(event.target.value)} placeholder="搜索学校、楼栋或详细地址" maxLength={64} className="loc-search-input" />
        <button type="submit" disabled={!ready || searching || selecting} className="loc-primary shrink-0">{searching ? <Loader2 size={16} className="animate-spin" /> : '搜索'}</button>
      </div>
    </form>
    {searchInfo && <p role="status" className="loc-note text-blue-700">{searchInfo}</p>}
    {searchCandidates.length > 0 && <div className="loc-map-candidates" aria-label="搜索候选地点">
        {searchCandidates.map((candidate, index) => <button type="button"
          key={`${candidate.amap_poi_id || candidate.name}-${candidate.latitude}-${candidate.longitude}-${index}`}
          disabled={searching || selecting} onClick={() => chooseSearchCandidate(candidate)}
          className="loc-map-candidate">
          <MapPin size={17} /><span className="min-w-0"><span className="block text-sm font-semibold">{candidate.name}</span>
          <span className="block loc-note">{candidate.address || '地址未知'}</span>
          <span className="loc-coordinates">纬度 {candidate.latitude} · 经度 {candidate.longitude}</span></span>
        </button>)}
    </div>}
    {error && <div role="alert" className="loc-banner" data-tone="error"><Info size={16} /><div>{error}{!ready && !busy && <button type="button" className="loc-secondary mt-2" onClick={() => { setError(''); setBusy(true); setAttempt(value => value + 1); }}><RotateCcw size={14} />重新加载地图</button>}</div></div>}
    {locationMessage && <p role={gps ? 'status' : 'alert'} className="loc-banner" data-tone="warning">{locationMessage}</p>}
    {overview && <p role="status" className="loc-banner"><Info size={16} />当前为全国参考视图，不是你的实际位置。请搜索学校或楼栋，再核对地图中心。</p>}
    <div className="loc-map-surface" data-testid="map-image" aria-busy={busy}>
      <div ref={mapContainer} onPointerDown={() => { mapInteracted.current = true; }} onWheel={() => { mapInteracted.current = true; }} className="absolute inset-0" style={{ width: '100%', height: '100%' }} aria-label="可拖动交互地图" />
      <div aria-hidden="true" className="loc-map-target"><Crosshair size={22} strokeWidth={1.7} /></div>
      {ready && <div className="loc-map-hint">拖动地图，让目标位置对准十字</div>}
      <div className="loc-map-tools">
        {selectionMode && <button type="button" aria-label="回到目前位置" title="回到目前位置" disabled={!ready || selecting} onClick={() => void returnToLocation()} className="loc-icon-button"><LocateFixed size={19} /></button>}
        <div className="grid gap-px">
          <button type="button" aria-label="放大" title="放大" disabled={!ready || (mapRef.current?.getZoom() ?? 16) >= 20} onClick={() => { mapInteracted.current = true; mapRef.current?.setZoom(Math.min(20, mapRef.current.getZoom() + 1)); }} className="loc-icon-button"><Plus size={19} /></button>
          <button type="button" aria-label="缩小" title="缩小" disabled={!ready || (mapRef.current?.getZoom() ?? 16) <= 3} onClick={() => { mapInteracted.current = true; mapRef.current?.setZoom(Math.max(3, mapRef.current.getZoom() - 1)); }} className="loc-icon-button"><Minus size={19} /></button>
        </div>
      </div>
      {busy && <div role="status" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-slate-100/95 text-slate-500"><Loader2 size={24} className="animate-spin text-blue-600" /><span className="text-xs">正在加载交互地图…</span></div>}
      {!ready && !busy && <div className="absolute inset-0 bg-slate-100" />}
    </div>
    <div className="loc-map-footer">
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold flex items-center gap-2"><MapPin size={16} className="text-blue-600" />地图中心</span><span className="loc-badge">GCJ-02</span></div>
      {center && <p className="loc-coordinates" data-testid="map-center">纬度 {center.latitude}，经度 {center.longitude} · 缩放 {mapRef.current?.getZoom() ?? 16}</p>}
      {gps && <p className="loc-note">现场定位精度 {gps.accuracy} 米；可继续拖动地图微调。</p>}
      {!selectionMode && initialCampusReference && <p className="loc-note text-amber-700">当前中心是校区视图参考点，不是已确认的楼栋坐标。</p>}
      <label className="loc-confirm"><input type="checkbox" checked={confirmed} disabled={!ready || selecting || searching} onChange={event => { mapInteracted.current = true; setConfirmed(event.target.checked); }} />{selectionMode ? '我已核对目标楼栋位于中心十字，理解该点不证明签到范围' : '我已核对中心十字指向的目标位置'}</label>
      <button type="button" disabled={!ready || !confirmed || selecting || searching} onClick={() => void confirmPoint()} className="loc-primary w-full">{selecting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}{selectionMode ? '确认使用此坐标签到' : '使用中心点'}</button>
    </div>
    <details className="loc-details"><summary>地图选点说明</summary><p>{selectionMode
      ? '地点搜索只移动地图中心，不匹配附近已启用地点。确认后直接使用本次 GCJ-02 坐标签到；地图点不证明位于老师设定的签到范围内。'
      : '搜索和预览均不保存地点。确认中心后，还需填写名称和地址并明确保存。'}</p><p>全域检索最多查询 3 页、75 条结果，按名称匹配度排序。</p></details>
  </section>;
}
