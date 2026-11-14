import { useEffect, useRef, useState } from 'react';
import type { SignLocation } from '../../types';
import { captureLocationPreview, type GPSPreview, type Point } from '../../utils/locationPreview';
import { rankEnabledLocations, LOCATION_MATCH_METERS } from '../../utils/locationMatching';
import { getErrorMessage } from '../../utils/errors';
import { MapPin, LocateFixed, BookmarkPlus, Trash2, Loader2, CheckCircle2, Info, LockKeyhole } from 'lucide-react';

type Props = {
  locations: SignLocation[]; selectedID?: number; loading: boolean; loadError: string;
  savePoint: (Point & { name?: string; address?: string }) | null;
  onReload: () => void; onSelect: (location: SignLocation) => void;
  onNearest: (point: Point) => Promise<void>;
  onSavePersonal: (name: string, address: string) => Promise<void>;
  onDeletePersonal: (location: SignLocation) => Promise<void>;
};

export default function SignLocationPicker({ locations, selectedID, loading, loadError, savePoint, onReload, onSelect, onNearest, onSavePersonal, onDeletePersonal }: Props) {
  const [gps, setGPS] = useState<GPSPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingID, setDeletingID] = useState<number | null>(null);
  const epoch = useRef(0), working = useRef(false);
  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => {
    setName(savePoint?.name ?? '');
    setAddress(savePoint?.address ?? '');
  }, [savePoint?.latitude, savePoint?.longitude, savePoint?.name, savePoint?.address]);
  const run = async (capture: boolean) => {
    if (working.current) return;
    working.current = true;
    const id = ++epoch.current;
    setBusy(true); setError('');
    if (capture) setGPS(null);
    try {
      if (capture) {
        const preview = await captureLocationPreview('/sign/locations/coordinate-preview');
        if (id === epoch.current) setGPS(preview);
      } else if (gps) await onNearest(gps.point);
    } catch (cause) {
      if (id === epoch.current) setError(getErrorMessage(cause, '定位或匹配失败，请重试。'));
    } finally {
      if (id === epoch.current) { working.current = false; setBusy(false); }
    }
  };
  const ranked = gps ? rankEnabledLocations(locations, gps.point) : locations.filter(item => item.status === 'enabled').map(location => ({ location, distance: undefined }));
  const nearest = ranked[0];
  const save = async () => {
    if (!savePoint || saving) return;
    if (!name.trim() || !address.trim()) {
      setError('请填写地点名称和地址后再保存。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSavePersonal(name.trim(), address.trim());
    } catch (cause) {
      setError(getErrorMessage(cause, '保存个人常用地点失败，请重试。'));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (location: SignLocation) => {
    if (deletingID !== null) return;
    setDeletingID(location.id);
    setError('');
    try {
      await onDeletePersonal(location);
    } catch (cause) {
      setError(getErrorMessage(cause, '删除个人常用地点失败，请重试。'));
    } finally {
      setDeletingID(null);
    }
  };
  return <div className="location-ui space-y-4">
    <button type="button" disabled={busy} onClick={() => run(true)} className="loc-secondary w-full">{busy ? <Loader2 size={17} className="animate-spin" /> : <LocateFixed size={17} />}{busy ? '正在定位或匹配…' : '现场定位'}</button>
    <p className="loc-note">定位仅按距离排序，不会自动选择或签到。</p>
    {error && <p role="alert" className="loc-banner" data-tone="error"><Info size={16} />{error}</p>}
    {gps && <div className="loc-capture" data-testid="nearby-preview">
      <p className="loc-note">GCJ-02：{gps.point.latitude}, {gps.point.longitude} · 原始精度 {gps.accuracy} 米 · {new Date(gps.captured_at).toLocaleString()}</p>
      {gps.poor_accuracy && <p className="text-amber-800">定位精度差于50米，距离仅供参考，请人工核对。</p>}
      {!gps.converted && <p className="text-amber-800">超出近似转换适用范围，坐标未偏移，请人工核对。</p>}
      {!loading && !loadError && (nearest?.distance !== undefined && nearest.distance <= LOCATION_MATCH_METERS
        ? <button type="button" disabled={busy} onClick={() => run(false)} className="loc-primary">使用最近地点</button>
        : <p>附近150米内没有已启用地点，仍可手动选择列表中的地点。</p>)}
    </div>}
    {loadError && <div className="text-center text-sm text-red-500 py-6"><p>{loadError}</p><button type="button" onClick={onReload} className="mt-3 text-blue-600 font-bold">重新加载</button></div>}
    {!loadError && loading && <p className="text-center text-sm text-slate-400 py-6">正在加载签到地点…</p>}
    {!loadError && !loading && ranked.length === 0 && <div className="loc-empty"><MapPin size={28} className="text-blue-500" /><p className="loc-note">暂无可用签到地点，可先地图选点再保存为个人常用地点。</p></div>}
    {!loadError && !loading && ranked.map(({ location, distance }) => <div key={location.id} className={`w-full rounded-2xl border ${selectedID === location.id ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-stretch">
        <button type="button" onClick={() => onSelect(location)} data-testid="enabled-location-option" aria-pressed={selectedID === location.id} className="min-w-0 flex-1 text-left p-4 flex gap-3 items-start">
          <span className="loc-place-icon">{selectedID === location.id ? <CheckCircle2 size={20} /> : <MapPin size={20} />}</span>
          <span className="min-w-0"><span className="block font-semibold text-slate-800 text-sm break-words">{location.name}</span>
          <span className="block loc-note">{location.address}</span>
          {location.is_personal && <span className="loc-badge mt-2">我的常用</span>}
          {distance !== undefined && <span className="block text-xs text-blue-700 mt-2">距采集点约 {distance.toFixed(1)} 米</span>}</span>
        </button>
        {location.is_personal && <button type="button" aria-label={`删除个人常用地点 ${location.name}`} disabled={deletingID !== null}
          onClick={() => void remove(location)} className="shrink-0 px-3 text-red-500">
          {deletingID === location.id ? <Loader2 size={17} className="animate-spin" /> : <Trash2 size={17} />}
        </button>}
      </div>
    </div>)}
    <section className="loc-capture">
      <h4 className="text-sm font-semibold flex items-center gap-2"><BookmarkPlus size={17} className="text-blue-600" />我的常用地点</h4>
      <p className="loc-note flex gap-2"><LockKeyhole size={14} className="shrink-0 mt-0.5" />保存后只有当前账号可以查看和调用。</p>
      {savePoint ? <>
        <label className="loc-field">地点名称
          <input value={name} onChange={event => setName(event.target.value)} maxLength={255} placeholder="给这个位置起个名字" />
        </label>
        <label className="loc-field">详细地址
          <input value={address} onChange={event => setAddress(event.target.value)} maxLength={1024} placeholder="学校、校区及楼栋" />
        </label>
        <button type="button" disabled={saving} onClick={() => void save()} className="loc-primary w-full">
          {saving ? '正在保存…' : '保存为我的常用地点'}
        </button>
      </> : <p className="text-xs text-slate-500">当前没有可保存的地点。请先返回签到页选取地图点或列表地点。</p>}
    </section>
  </div>;
}
