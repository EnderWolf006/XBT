import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import client from '../api/client';
import type { ApiResponse, SignLocation, SignLocationCandidate } from '../types';
import LocationCapture, { type CapturedPoint } from '../components/LocationCapture';
import { getErrorMessage } from '../utils/errors';
import { ArrowLeft, Plus, Search, MapPin, LockKeyhole, Pencil, Trash2, Loader2, Bookmark, ArrowUpRight, Check, Info } from 'lucide-react';
import LocationDialog from '../components/LocationDialog';

type Form = Pick<SignLocation, 'name' | 'address'> & { latitude: string; longitude: string };
const emptyForm: Form = { name: '', address: '', latitude: '', longitude: '' };

function formPoint(form: Form) {
  const latitude = Number(form.latitude);
  const longitude = Number(form.longitude);
  if (!form.latitude.trim() || !form.longitude.trim() || !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export default function PersonalLocations() {
  const navigate = useNavigate();
  const [locations, setLocations] = useState<SignLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [candidates, setCandidates] = useState<SignLocationCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SignLocation | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const writing = useRef(false);
  const searchEpoch = useRef(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await client.get<ApiResponse<SignLocation[]>>('/sign/locations/personal');
      setLocations(response.data.data ?? []);
    } catch (cause) {
      setError(getErrorMessage(cause, '获取个人地点失败'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => () => { searchEpoch.current++; }, []);

  const search = async () => {
    if (!keyword.trim()) { setSearchError('请输入学校全名、楼栋或地址'); return; }
    const epoch = ++searchEpoch.current;
    setSearching(true);
    setSearchError('');
    setCandidates([]);
    try {
      const response = await client.post<ApiResponse<SignLocationCandidate[]>>('/sign/locations/search-map', { keywords: keyword.trim(), scope: 'full' });
      if (epoch === searchEpoch.current) {
        setCandidates(response.data.data ?? []);
        if (!response.data.data?.length) setSearchError('没有匹配地点，请输入更完整的名称或地址');
      }
    } catch (cause) {
      if (epoch === searchEpoch.current) setSearchError(getErrorMessage(cause, '搜索地点失败'));
    } finally {
      if (epoch === searchEpoch.current) setSearching(false);
    }
  };
  const openForm = (location?: SignLocation, candidate?: SignLocationCandidate) => {
    setEditing(location ?? null);
    const point = location ?? candidate;
    setForm(point ? { name: point.name, address: point.address, latitude: String(point.latitude), longitude: String(point.longitude) } : emptyForm);
    setFormError('');
    setShowForm(true);
  };
  const save = async () => {
    if (writing.current || captureBusy) return;
    const point = formPoint(form);
    if (!form.name.trim() || !form.address.trim() || !point) {
      setFormError('请填写名称、地址和完整的 GCJ-02 坐标：纬度 -90～90，经度 -180～180');
      return;
    }
    writing.current = true;
    setBusy(true);
    setFormError('');
    try {
      const payload = { ...form, ...point };
      if (editing) await client.put(`/sign/locations/personal/${editing.id}`, payload);
      else await client.post('/sign/locations/personal', payload);
      toast.success('已保存到当前账号，仅自己可见');
      setShowForm(false);
      await reload();
    } catch (cause) {
      setFormError(getErrorMessage(cause, '保存个人地点失败'));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const remove = async (location: SignLocation) => {
    if (writing.current || !window.confirm(`删除我的常用地点“${location.name}”？`)) return;
    writing.current = true;
    setBusy(true);
    try {
      await client.delete(`/sign/locations/personal/${location.id}`);
      setLocations(previous => previous.filter(item => item.id !== location.id));
      toast.success('个人地点已删除');
    } catch (cause) {
      setError(getErrorMessage(cause, '删除个人地点失败'));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const applyPoint = (point: CapturedPoint) => {
    setForm(previous => ({ ...previous, latitude: String(point.latitude), longitude: String(point.longitude) }));
    setFormError('');
  };
  const filtered = locations.filter(location => `${location.name} ${location.address}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return <div className="location-ui loc-page">
    <header className="loc-page-header">
      <button type="button" aria-label="返回" className="loc-icon-button" onClick={() => navigate(-1)}><ArrowLeft size={20} /></button>
      <div className="flex-1 min-w-0"><h1>我的常用地点</h1><p>保存一次，下次快速调用</p></div>
      <button type="button" title="手动新增" aria-label="添加位置" onClick={() => openForm()} className="loc-primary"><Plus size={17} /><span className="loc-add-label">添加位置</span></button>
    </header>
    <main className="loc-page-content">
      <div className="loc-banner"><LockKeyhole size={17} /><div><strong className="block mb-0.5">你的地点，只对你可见</strong>按账号独立保存，其他用户及网站管理员不可查看或修改。</div></div>
      <section className="loc-card">
        <div className="loc-section-title"><span>找到一个新地点</span><span className="loc-badge">高德搜索</span></div>
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); void search(); }}>
          <label className="sr-only" htmlFor="personal-place-search">完整地点名称或地址</label>
          <div className="loc-map-search"><Search size={18} /><input id="personal-place-search" className="loc-search-input" value={keyword} onChange={event => setKeyword(event.target.value)} maxLength={64} placeholder="学校全名、校区或楼栋" />
          <button type="submit" disabled={searching} className="loc-primary shrink-0">{searching ? <Loader2 size={16} className="animate-spin" /> : '搜索'}</button></div>
          <p className="loc-note">输入完整名称更准确。搜索不会保存，核对位置后再加入常用。</p>
        </form>
        {searchError && <p role="alert" className="loc-banner mt-3" data-tone="warning"><Info size={16} />{searchError}</p>}
        {candidates.length > 0 && <div className="mt-4 grid gap-3 max-h-96 overflow-y-auto" aria-label="地点搜索结果">
        {candidates.map((candidate, index) => <div key={`${candidate.amap_poi_id}-${index}`} className="rounded-xl border border-slate-200 p-4">
          <div className="loc-place"><span className="loc-place-icon"><MapPin size={19} /></span><div className="min-w-0"><h3>{candidate.name}</h3><p>{candidate.address}</p></div></div>
          <button type="button" onClick={() => openForm(undefined, candidate)} className="loc-secondary w-full mt-3">核对并保存为我的地点<ArrowUpRight size={15} /></button>
        </div>)}
        </div>}
      </section>
      <section>
        <div className="loc-saved-toolbar">
          <div className="loc-section-title"><span className="flex items-center gap-2"><Bookmark size={17} className="text-blue-600" />已保存地点<span className="loc-badge">{locations.length}</span></span></div>
          {locations.length > 0 && <label className="loc-field"><span className="sr-only">筛选我的地点</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="按名称或地址筛选" aria-label="筛选我的地点" /></label>}
        </div>
        {loading && <div role="status" className="grid gap-3"><span className="sr-only">正在加载个人地点…</span>{[1, 2].map(value => <div key={value} className="h-32 rounded-2xl bg-slate-200/60 animate-pulse" />)}</div>}
        {error && <div role="alert" className="loc-banner" data-tone="error"><Info size={16} /><div>{error}<button type="button" onClick={() => void reload()} className="loc-secondary mt-2">重新加载</button></div></div>}
        {!loading && !error && !locations.length && <div className="loc-empty"><div className="loc-empty-icon"><MapPin size={28} strokeWidth={1.5} /></div><div><h2 className="font-semibold">还没有常用地点</h2><p className="loc-note mt-1">搜索学校或楼栋，也可以在地图上选取位置。</p></div><button type="button" className="loc-secondary" onClick={() => openForm()}><Plus size={16} />添加第一个地点</button></div>}
        {!loading && !error && !!locations.length && !filtered.length && <div className="loc-empty"><Search size={24} className="text-slate-400" /><p>没有匹配的已保存地点</p><button type="button" className="loc-secondary" onClick={() => setFilter('')}>清除筛选</button></div>}
        <div className="loc-saved-grid">
        {!loading && !error && filtered.map(location => <article key={location.id} className="loc-card loc-saved-card">
          <div className="loc-place"><span className="loc-place-icon"><MapPin size={20} /></span><div className="min-w-0 flex-1"><h2>{location.name}</h2><p>{location.address}</p></div></div>
          <div className="loc-coordinates"><span>纬度 {location.latitude}</span><span>经度 {location.longitude}</span><span>GCJ-02</span></div>
          <div className="loc-saved-footer">
            <span className="loc-privacy"><LockKeyhole size={12} />仅自己可见</span>
            <div className="loc-saved-actions">
              <button type="button" disabled={busy} onClick={() => openForm(location)} className="loc-secondary"><Pencil size={14} />编辑</button>
              <button type="button" disabled={busy} onClick={() => void remove(location)} className="loc-danger loc-delete" aria-label={`删除 ${location.name}`}><Trash2 size={14} /><span className="sr-only">删除</span></button>
            </div>
          </div>
        </article>)}
      </div>
      </section>
    </main>
    {showForm && <LocationDialog title={editing ? '编辑个人地点' : '添加个人地点'} description="选取位置 · 补充信息 · 保存到我的地点" onClose={() => setShowForm(false)} busy={busy} footer={<>
      {formError && <p role="alert" className="loc-banner mb-3" data-tone="error"><Info size={16} />{formError}</p>}
      <button type="button" disabled={busy || captureBusy} onClick={() => void save()} className="loc-primary">{busy ? <Loader2 size={17} className="animate-spin" /> : <Check size={17} />}{busy ? '正在保存…' : '保存个人地点'}</button>
    </>}>
      <div className="space-y-5">
        <LocationCapture personalMode initialPoint={formPoint(form)} onSelect={applyPoint} onBusy={setCaptureBusy} />
        <div className="space-y-4">
          <div className="loc-section-title"><span>地点信息</span><span className="loc-badge"><LockKeyhole size={11} />仅自己可见</span></div>
          <label className="loc-field">名称<input value={form.name} maxLength={255} placeholder="例如：图书馆东门" onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <label className="loc-field">地址<input value={form.address} maxLength={1024} placeholder="学校、校区及具体楼栋" onChange={event => setForm({ ...form, address: event.target.value })} /></label>
          <div className="loc-fields">
            <label className="loc-field">纬度<input type="number" step="any" min="-90" max="90" value={form.latitude} placeholder="-90～90" onChange={event => setForm({ ...form, latitude: event.target.value })} /></label>
            <label className="loc-field">经度<input type="number" step="any" min="-180" max="180" value={form.longitude} placeholder="-180～180" onChange={event => setForm({ ...form, longitude: event.target.value })} /></label>
          </div>
          <p className="loc-note">使用高德 GCJ-02 坐标。地图确认后自动填入，也可手动修改；请勿直接混用 GPS 或百度坐标。</p>
        </div>
      </div>
    </LocationDialog>}
  </div>;
}
