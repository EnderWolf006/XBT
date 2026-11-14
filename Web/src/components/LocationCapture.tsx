import { useCallback, useEffect, useRef, useState } from 'react';
import client from '../api/client';
import type { ApiResponse } from '../types';
import { getErrorMessage } from '../utils/errors';
import { captureLocationPreview, type GPSPreview, type Point } from '../utils/locationPreview';
import InteractiveSignMap from './InteractiveSignMap';
import { Map, LocateFixed, CheckCircle2, Loader2, Info, SlidersHorizontal } from 'lucide-react';

export type CapturedPoint = Point & { source: 'device_gps' | 'map_pick' };
type MapPreview = {
  center: Point | null;
  zoom: number;
  coordinate_system: 'GCJ-02';
  image_data: string;
  campus_reference: boolean;
};
type Props = {
  initialPoint: Point | null;
  onSelect: (point: CapturedPoint) => void | Promise<void>;
  onBusy: (busy: boolean) => void;
  selectionMode?: boolean;
  personalMode?: boolean;
};

export default function LocationCapture(props: Props) {
  if (props.selectionMode) {
    return <InteractiveSignMap initialPoint={props.initialPoint} onSelect={props.onSelect} onBusy={props.onBusy} />;
  }
  return <AdminLocationCapture {...props} />;
}

function AdminLocationCapture({ initialPoint, onSelect, onBusy, personalMode = false }: Props) {
  const apiBase = personalMode ? '/sign/locations' : '/admin/sign-locations';
  const [gps, setGPS] = useState<GPSPreview | null>(null);
  const [map, setMap] = useState<MapPreview | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState('');
  const [manualCenter, setManualCenter] = useState({ latitude: '', longitude: '' });
  const request = useRef(0);

  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  useEffect(() => () => { request.current++; }, []);

  const capture = async () => {
    if (busy) return;
    const id = ++request.current;
    setBusy(true);
    setError('');
    setApplied('');
    setGPS(null);
    try {
      const preview = await captureLocationPreview(`${apiBase}/coordinate-preview`);
      if (id === request.current) setGPS(preview);
    } catch (cause) {
      if (id === request.current) setError(getErrorMessage(cause, '定位预览失败，请重试。'));
    } finally {
      if (id === request.current) setBusy(false);
    }
  };

  const loadMap = useCallback(async (center: Point | null) => {
    if (busy) return;
    const id = ++request.current;
    setBusy(true);
    setError('');
    setApplied('');
    if (!center) {
      setMap({ center: null, zoom: 4, coordinate_system: 'GCJ-02', image_data: '', campus_reference: false });
      setMapOpen(true);
      setBusy(false);
      return;
    }
    try {
      const response = await client.post<ApiResponse<MapPreview>>(`${apiBase}/map-preview`, { center, zoom: 16 });
      if (id === request.current) {
        setMap(response.data.data);
        setMapOpen(true);
      }
    } catch (cause) {
      if (id === request.current) setError(getErrorMessage(cause, '地图预览失败，请重试或手动输入坐标。'));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [busy, apiBase]);

  const useManualCenter = () => {
    const latitude = Number(manualCenter.latitude);
    const longitude = Number(manualCenter.longitude);
    if (!manualCenter.latitude.trim() || !manualCenter.longitude.trim() ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude <= -85 || latitude >= 85 || longitude < -180 || longitude > 180) {
      setError('请填写有效GCJ-02地图中心，经度-180至180、纬度-85至85。');
      return;
    }
    void loadMap({ latitude, longitude });
  };

  const accept = async (point: CapturedPoint) => {
    if (busy) return;
    const id = ++request.current;
    setBusy(true);
    setError('');
    setApplied('');
    try {
      await onSelect(point);
      if (id === request.current) {
        setApplied(`${point.source === 'device_gps' ? '现场定位' : '地图中心'}已填入下方GCJ-02坐标；尚未保存，请手填名称和地址。`);
        setMapOpen(false);
      }
    } catch (cause) {
      if (id === request.current) setError(getErrorMessage(cause, '无法使用该坐标，请重试。'));
    } finally {
      if (id === request.current) setBusy(false);
    }
  };

  return <section aria-label="坐标采集与地图取点" className="location-ui loc-capture">
    <div><p className="text-sm font-semibold">选择位置</p><p className="loc-note mt-1">先找到准确位置，再补充地点信息。</p></div>
    <div className="loc-methods">
      <button type="button" aria-label="打开地图取点" disabled={busy} onClick={() => void loadMap(gps?.point ?? initialPoint)} className="loc-method"><Map size={21} /><strong>打开地图取点</strong><span>搜索地点，拖动微调</span></button>
      <button type="button" aria-label="浏览器现场定位" disabled={busy} onClick={() => void capture()} className="loc-method"><LocateFixed size={21} /><strong>浏览器现场定位</strong><span>获取设备当前位置</span></button>
    </div>
    {busy && !mapOpen && <p role="status" className="flex items-center gap-2 loc-note"><Loader2 size={16} className="animate-spin" />正在获取只读坐标或地图中心…</p>}
    {error && <p role="alert" className="loc-banner" data-tone="error"><Info size={16} />{error}</p>}
    {applied && <p role="status" className="loc-banner" data-tone="success"><CheckCircle2 size={16} />{applied}</p>}
    {gps && <div className="loc-card space-y-3" data-testid="gps-preview">
      <div className="flex items-center justify-between"><span className="text-sm font-semibold">设备定位结果</span><span className="loc-badge">精度 {gps.accuracy} 米</span></div>
      <p className="loc-coordinates">GCJ-02 纬度 {gps.point.latitude}，经度 {gps.point.longitude}</p>
      <p className="loc-note">原始精度：{gps.accuracy} 米 · 采集时间：{new Date(gps.captured_at).toLocaleString()}</p>
      {!gps.converted && <p>坐标在近似算法适用范围外，未施加偏移，请人工核对地图。</p>}
      {gps.poor_accuracy && <p role="alert" className="loc-banner" data-tone="warning">定位精度差于50米，可能无法区分相邻楼栋，请人工核对。</p>}
      {gps.warning && <p className="loc-note">{gps.warning}</p>}
      <button type="button" disabled={busy} onClick={() => void accept({ ...gps.point, source: 'device_gps' })} className="loc-primary w-full"><CheckCircle2 size={16} />使用定位点</button>
    </div>}
    {mapOpen && map && <div className="space-y-3" aria-label="地图中心选择">
      <InteractiveSignMap
        key={map.center ? `${map.center.latitude},${map.center.longitude}` : 'overview'}
        initialPoint={map.center}
        initialCampusReference={map.campus_reference}
        selectionMode={false}
        allowOverview
        apiBase={apiBase}
        onSelect={accept}
        onBusy={setBusy}
      />
    </div>}
    <details className="loc-details">
      <summary><SlidersHorizontal size={13} className="inline mr-2" />用坐标设置参考中心</summary>
      <div className="loc-fields">
        <label className="loc-field">参考中心纬度（GCJ-02）<input type="number" step="any" value={manualCenter.latitude} onChange={event => setManualCenter({ ...manualCenter, latitude: event.target.value })} placeholder="例如 31.2304" /></label>
        <label className="loc-field">参考中心经度（GCJ-02）<input type="number" step="any" value={manualCenter.longitude} onChange={event => setManualCenter({ ...manualCenter, longitude: event.target.value })} placeholder="例如 121.4737" /></label>
      </div>
      <button type="button" disabled={busy} onClick={useManualCenter} className="loc-secondary w-full">仅更新参考视图</button>
    </details>
    <p className="loc-note">{personalMode ? '仅保存到当前账号。选取坐标不会自动保存或签到。' : '采集与取点均不自动保存或启用；请核对后填写名称和地址。'}</p>
  </section>;
}
