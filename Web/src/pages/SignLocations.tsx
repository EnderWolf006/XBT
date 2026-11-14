import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Edit3, Loader2, MapPin, Plus, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import client, { ApiError } from '../api/client';
import type { ApiResponse, SaveCandidateResult, SignLocation, SignLocationCandidate } from '../types';
import { getErrorMessage } from '../utils/errors';
import LocationCapture, { type CapturedPoint } from '../components/LocationCapture';
import LocationDialog from '../components/LocationDialog';
import PersonalLocations from './PersonalLocations';

type StatusFilter = 'all' | 'pending' | 'enabled' | 'disabled';
type LocationForm = Pick<SignLocation, 'name' | 'address' | 'latitude' | 'longitude'> & { status: SignLocation['status']; source?: 'manual' | 'device_gps' | 'map_pick' };
type CandidateFeedback = { message: string; deleted?: SignLocation };

function deletedLocation(error: unknown): SignLocation | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return;
  const details = error.details;
  if (!details || typeof details !== 'object' || !('error_code' in details) || details.error_code !== 'SIGN_LOCATION_DELETED' ||
    !('location' in details) || !details.location || typeof details.location !== 'object') return;
  const row = details.location;
  if (!('id' in row) || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0 ||
    !('name' in row) || typeof row.name !== 'string' || !('address' in row) || typeof row.address !== 'string' ||
    !('latitude' in row) || typeof row.latitude !== 'number' || !('longitude' in row) || typeof row.longitude !== 'number') return;
  return { id: row.id, name: row.name, address: row.address, latitude: row.latitude, longitude: row.longitude };
}

const emptyForm: LocationForm = { name: '', address: '', latitude: 0, longitude: 0, status: 'pending' };
const statusLabels: Record<string, string> = { pending: '待确认', enabled: '已启用', disabled: '已停用' };
const statusClasses: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700', enabled: 'bg-emerald-100 text-emerald-700', disabled: 'bg-slate-100 text-slate-600',
};
const sourceLabels: Record<string, string> = { amap: '高德候选', manual: '手动', config: '配置', device_gps: '现场定位', map_pick: '地图取点' };

const LegacySignLocations = () => {
  const navigate = useNavigate();
  const [locations, setLocations] = useState<SignLocation[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [keyword, setKeyword] = useState('教学楼');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<'campus' | 'full'>('full');
  const [candidates, setCandidates] = useState<SignLocationCandidate[]>([]);
  const [searched, setSearched] = useState('');
  const [searchError, setSearchError] = useState('');
  const [queryKeywords, setQueryKeywords] = useState('');
  const [candidateFeedback, setCandidateFeedback] = useState<Record<number, CandidateFeedback>>({});
  const [savedCandidates, setSavedCandidates] = useState<Record<number, SaveCandidateResult>>({});
  const [savingCandidate, setSavingCandidate] = useState<SignLocationCandidate | null>(null);
  const [highlightedID, setHighlightedID] = useState<number | null>(null);
  const searchRequest = useRef(0);
  const listRequest = useRef(0);
  const candidateBusy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<SignLocation | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<LocationForm>(emptyForm);
  const [formError, setFormError] = useState('');
  const [captureBusy, setCaptureBusy] = useState(false);

  const fetchLocations = useCallback(async (selectedFilter: StatusFilter = filter) => {
    const requestID = ++listRequest.current;
    setLoading(true);
    try {
      const query = selectedFilter === 'all' ? '' : `?status=${selectedFilter}`;
      const response = await client.get<ApiResponse<SignLocation[]>>(`/admin/sign-locations${query}`);
      if (requestID !== listRequest.current) return;
      setLocations(response.data.data || []);
    } catch (error) {
      if (requestID === listRequest.current) toast.error(getErrorMessage(error, '获取签到地点失败'));
    } finally {
      if (requestID === listRequest.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);
  useEffect(() => () => { searchRequest.current++; listRequest.current++; }, []);
  useEffect(() => {
    if (!loading && highlightedID !== null) {
      document.getElementById(`saved-location-${highlightedID}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedID, loading, locations]);

  const searchCandidates = async () => {
    const requestID = ++searchRequest.current;
    const value = keyword.trim() || '教学楼';
    setCandidates([]);
    setSavedCandidates({});
    setCandidateFeedback({});
    setSearchError('');
    setQueryKeywords('');
    setSearched(`${scope === 'campus' ? '校区 + 关键词' : '完整地点名称'}：${value}`);
    if (value.length > 64) {
      setSearching(false);
      setSearchError('搜索关键词不能超过 64 个字符');
      return;
    }
    setSearching(true);
    try {
      const response = await client.post<ApiResponse<SignLocationCandidate[]> & { query_keywords?: string }>('/admin/sign-locations/search', { keywords: value, scope });
      if (requestID === searchRequest.current) {
        setCandidates(response.data.data || []);
        setQueryKeywords(response.data.query_keywords || '');
      }
    } catch (error) {
      if (requestID === searchRequest.current) {
        const message = getErrorMessage(error, '搜索候选地点失败');
        setSearchError(message);
        if (error instanceof ApiError) setQueryKeywords(error.queryKeywords || '');
      }
    } finally {
      if (requestID === searchRequest.current) setSearching(false);
    }
  };

  const locateSaved = async (id: number) => {
    setHighlightedID(id);
    setFilter('all');
    await fetchLocations('all');
  };

  const saveCandidate = async (candidate: SignLocationCandidate, index: number, restore?: SignLocation) => {
    if (candidateBusy.current) return;
    if (restore && !window.confirm(`恢复已删除的“${restore.name}”（#${restore.id}）？将保留旧记录的名称、地址及坐标并置为待确认，不会自动启用；不会使用搜索结果覆盖旧内容。`)) return;
    candidateBusy.current = true;
    const requestID = searchRequest.current;
    setSavingCandidate(candidate);
    try {
      const response = restore
        ? await client.post<ApiResponse<SaveCandidateResult>>(`/admin/sign-locations/${restore.id}/restore`, { confirmed: true })
        : await client.post<ApiResponse<SaveCandidateResult>>('/admin/sign-locations/candidates', candidate);
      const result = response.data.data;
      if (requestID === searchRequest.current) {
        setSavedCandidates(previous => ({ ...previous, [index]: result }));
        setCandidateFeedback(previous => ({ ...previous, [index]: { message: '' } }));
      }
      toast.success(result.restored ? '旧地点已恢复为待确认，请核对后明确启用' : result.created ? '已保存为待确认地点，请核对后明确启用' : '地点已存在，保留原有内容和状态', { id: 'sign-location-candidate-success' });
      await locateSaved(result.location.id);
    } catch (error) {
      if (requestID === searchRequest.current) {
        setCandidateFeedback(previous => ({ ...previous, [index]: {
          message: getErrorMessage(error, '操作失败，请检查网络后重试'),
          deleted: restore || deletedLocation(error),
        } }));
      } else {
        toast.error('上一查询中已确认地点的保存失败；请重新搜索并核对', { id: 'sign-location-previous-save-error' });
      }
    } finally {
      candidateBusy.current = false;
      setSavingCandidate(null);
    }
  };

  const validateForm = () => {
    if (!form.name.trim()) return '请输入地点名称';
    if (!form.address.trim()) return '请输入地点地址';
    if (!Number.isFinite(form.latitude) || form.latitude < -90 || form.latitude > 90) return '纬度必须在 -90 至 90 之间';
    if (!Number.isFinite(form.longitude) || form.longitude < -180 || form.longitude > 180) return '经度必须在 -180 至 180 之间';
    return null;
  };

  const submitForm = async () => {
    const error = validateForm();
    if (error) { setFormError(error); return; }
    if (captureBusy) { setFormError('请等待坐标预览完成后再保存'); return; }
    setFormError('');
    setSaving(true);
    try {
      if (editing) {
        await client.put(`/admin/sign-locations/${editing.id}`, form);
        toast.success('地点已更新');
      } else {
        await client.post('/admin/sign-locations', { ...form, source: form.source || 'manual' });
        toast.success('地点已新增');
      }
      setShowForm(false);
      setEditing(null);
      setForm(emptyForm);
      await fetchLocations();
    } catch (requestError) {
      setFormError(getErrorMessage(requestError, '保存地点失败'));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (location: SignLocation, status: 'enable' | 'disable') => {
    try {
      await client.post(`/admin/sign-locations/${location.id}/${status}`);
      toast.success(status === 'enable' ? '地点已启用' : '地点已停用');
      await fetchLocations();
    } catch (error) {
      toast.error(getErrorMessage(error, '更新地点状态失败'));
    }
  };

  const removeLocation = async (location: SignLocation) => {
    if (!window.confirm(`确定要删除“${location.name}”吗？删除后将不再出现在地点列表中。`)) return;
    try {
      await client.delete(`/admin/sign-locations/${location.id}`);
      toast.success('地点已删除');
      await fetchLocations();
    } catch (error) {
      toast.error(getErrorMessage(error, '删除地点失败'));
    }
  };

  const openCreate = () => { setEditing(null); setForm(emptyForm); setFormError(''); setShowForm(true); };
  const openEdit = (location: SignLocation) => {
    setEditing(location);
    setFormError('');
    setForm({ name: location.name, address: location.address, latitude: location.latitude, longitude: location.longitude, status: location.status || 'pending' });
    setShowForm(true);
  };
  const applyCapturedPoint = (point: CapturedPoint) => {
    setForm(previous => ({ ...previous, ...point, status: 'pending' }));
    setFormError('');
  };

  return (
    <div className="location-ui h-full flex flex-col bg-slate-50 overflow-hidden">
      <header className="bg-white border-b border-slate-100 px-4 h-[calc(80px+var(--sat))] pt-[var(--sat)] flex items-center justify-between shrink-0">
        <div className="flex items-center min-w-0">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-slate-600 rounded-lg" aria-label="返回"><ChevronLeft size={24} /></button>
          <div className="ml-2 min-w-0"><h1 className="font-bold text-slate-900 text-lg truncate">签到地点</h1><p className="text-xs text-slate-400">管理员地点管理</p></div>
        </div>
        <button onClick={openCreate} className="p-2 text-blue-600 rounded-lg" title="手动新增"><Plus size={24} /></button>
      </header>

      <main className="flex-1 overflow-y-auto p-4 pb-[calc(40px+var(--sab))] custom-scrollbar">
        <section className="bg-white rounded-2xl border border-slate-100 p-3 shadow-sm mb-4">
          <h2 className="font-bold text-slate-900 mb-2">搜索高德候选</h2>
          <label className="block text-xs text-slate-500 mb-2">检索方式
            <select aria-label="检索方式" value={scope} onChange={e => setScope(e.target.value === 'full' ? 'full' : 'campus')} className="ml-2 p-2 rounded-lg bg-slate-50">
              <option value="campus">校区 + 建筑关键词</option><option value="full">完整学校 / 地点名称</option>
            </select>
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} /><input value={keyword} onChange={e => setKeyword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') searchCandidates(); }} placeholder="搜索关键词，默认教学楼" className="w-full pl-9 pr-3 py-3 bg-slate-50 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 text-sm" /></div>
            <button onClick={searchCandidates} aria-label="搜索" className="px-4 rounded-xl bg-blue-600 text-white text-sm font-bold">{searching ? <Loader2 size={18} className="animate-spin" /> : '搜索'}</button>
          </div>
          <div className="flex gap-2 mt-2">{['教学楼', '图书馆', '宿舍', '食堂'].map(word => <button key={word} onClick={() => { setKeyword(word); }} className="px-2 py-1 rounded-lg bg-slate-50 text-xs text-blue-600">{word}</button>)}</div>
          <details className="loc-details mt-3"><summary>检索方式与保存说明</summary>
          <p className="text-xs text-slate-500 mt-2 px-1">校区方式将后端配置的校区文字加入查询，不是地理围栏；完整名称方式不追加校区。学校名称可能只返回学校整体，请补充具体楼栋名称。</p>
          <p className="text-xs text-slate-500 mt-2 px-1">若校区配置是详细道路门牌地址，组合楼名可能过窄。可切换“完整学校 / 地点名称”，输入“学校全名 + 校区 + 楼栋正式名称”，无需填写道路门牌。未被高德收录的建筑不会因此出现，也不能用学校中心代替楼栋坐标。</p>
          <p className="text-xs text-slate-500 mt-2 px-1">搜索不保存。每次显示最多 25 个候选，重新搜索替换本区结果；请核对名称、地址及高德坐标，确认保存后仍需明确启用。已保存历史地点不会删除。</p>
          </details>
        </section>

        {searched && <section aria-label="本次搜索结果" aria-busy={searching} className="mb-5 space-y-3">
          <h2 className="font-bold text-slate-900">本次搜索结果</h2>
          <p className="text-xs text-slate-500 break-words">{searched}</p>
          {queryKeywords && <p className="text-xs text-slate-600 break-words" data-testid="actual-query">实际检索词：{queryKeywords}</p>}
          {savingCandidate && !candidates.includes(savingCandidate) && <p role="status" className="text-xs text-blue-600">正在保存上一查询中已确认的地点，新结果尚未保存。</p>}
          {searching ? <p role="status" className="text-sm text-blue-600">正在搜索，仅显示本次查询结果…</p> : searchError ? <p role="alert" className="text-sm text-red-600">{searchError}</p> : candidates.length === 0 ? <p className="text-sm text-slate-500">本次未找到有效候选，请调整校区或楼栋关键词。</p> : candidates.map((candidate, index) => <div key={`${searched}-${index}`} className="bg-blue-50 rounded-2xl border border-blue-100 p-4" data-testid="search-candidate">
            <h3 className="font-bold text-slate-900">{candidate.name}</h3>
            <p className="text-sm text-slate-600 mt-1">{candidate.address}</p>
            <p className="text-xs text-slate-500 mt-2">来源：高德 POI · 纬度：{candidate.latitude} · 经度：{candidate.longitude}</p>
            {candidate.amap_poi_id && <p className="text-xs text-slate-500">POI ID：{candidate.amap_poi_id}</p>}
            {savedCandidates[index] ? <div className="mt-3 text-sm text-emerald-700">
              <p>{savedCandidates[index].restored ? '旧记录已恢复为待确认，原内容已保留' : savedCandidates[index].created ? '已保存为待确认地点' : '地点已存在，原内容及状态已保留'} · #{savedCandidates[index].location.id}</p>
              <button onClick={() => locateSaved(savedCandidates[index].location.id)} className="font-bold underline mt-2">查看已保存地点</button>
            </div> : <>
              {candidateFeedback[index]?.message && <div className="mt-3 text-sm text-amber-900 rounded-lg bg-amber-50 p-3">
                <p role="alert">{candidateFeedback[index].message}</p>
                {candidateFeedback[index].deleted && <p className="text-xs mt-2">待恢复旧记录 #{candidateFeedback[index].deleted.id}：{candidateFeedback[index].deleted.name} · {candidateFeedback[index].deleted.address} · 坐标 {candidateFeedback[index].deleted.latitude}, {candidateFeedback[index].deleted.longitude}。恢复后保留这些内容。</p>}
              </div>}
              <button disabled={savingCandidate !== null} onClick={() => saveCandidate(candidate, index, candidateFeedback[index]?.deleted)} className="mt-3 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold disabled:opacity-50">{savingCandidate === candidate ? '正在保存…' : candidateFeedback[index]?.deleted ? '确认恢复旧地点为待确认' : candidateFeedback[index]?.message ? '重试保存候选' : '确认保存为待确认'}</button>
            </>}
          </div>)}
        </section>}

        <h2 className="font-bold text-slate-900 mb-3">已保存地点</h2>
        <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
          {(['all', 'pending', 'enabled', 'disabled'] as StatusFilter[]).map(value => <button key={value} onClick={() => setFilter(value)} className={`px-4 py-2 rounded-full text-xs font-bold whitespace-nowrap ${filter === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-100'}`}>{value === 'all' ? '全部' : statusLabels[value]}</button>)}
        </div>

        {loading ? <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-32 bg-white rounded-2xl animate-pulse" />)}</div> : locations.length === 0 ? <div className="py-16 text-center text-slate-400 bg-white rounded-2xl border border-dashed border-slate-200"><MapPin size={40} className="mx-auto mb-3 opacity-30" /><p>暂无签到地点</p><p className="text-xs mt-1">可搜索教学楼候选或手动新增</p></div> : <div className="space-y-3">{locations.map(location => <article key={location.id} id={`saved-location-${location.id}`} data-highlighted={highlightedID === location.id} className={`bg-white rounded-2xl border p-4 shadow-sm ${highlightedID === location.id ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-100'}`}>
          {highlightedID === location.id && <p role="status" className="text-xs font-bold text-blue-600 mb-2">当前定位：已保存地点 #{location.id}</p>}
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="font-bold text-slate-900 truncate">{location.name}</h2><p className="text-sm text-slate-500 mt-1 break-words">{location.address}</p></div><span className={`shrink-0 px-2 py-1 rounded-lg text-xs font-bold ${statusClasses[location.status || 'pending'] || statusClasses.pending}`}>{statusLabels[location.status || 'pending'] || location.status}</span></div>
          <div className="mt-3 text-xs text-slate-400 space-y-1"><p>来源：{sourceLabels[location.source || ''] || location.source || '未知'} · 坐标（GCJ-02）：{location.latitude}, {location.longitude}</p>{location.amap_poi_id && <p>POI ID：{location.amap_poi_id}</p>}</div>
          <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-slate-50"><button onClick={() => openEdit(location)} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-50 text-slate-600 text-xs font-bold"><Edit3 size={14} />编辑</button>{location.status !== 'enabled' && <button onClick={() => changeStatus(location, 'enable')} className="px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-bold">明确启用</button>}{location.status === 'enabled' && <button onClick={() => changeStatus(location, 'disable')} className="px-3 py-2 rounded-lg bg-amber-50 text-amber-700 text-xs font-bold">停用</button>}<button onClick={() => removeLocation(location)} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-red-50 text-red-600 text-xs font-bold"><Trash2 size={14} />删除</button></div>
        </article>)}</div>}
      </main>

      {showForm && <LocationDialog title={editing ? '编辑地点' : '手动新增地点'} description="选取准确位置，再补充地点信息" onClose={() => setShowForm(false)} busy={saving} footer={<>{formError && <p role="alert" className="loc-banner mb-3" data-tone="error">{formError}</p>}<button disabled={saving || captureBusy} onClick={submitForm} className="loc-primary">{saving ? <Loader2 size={18} className="animate-spin" /> : '保存地点'}</button></>}>
          <div className="space-y-4">
            <LocationCapture initialPoint={editing ? { latitude: editing.latitude, longitude: editing.longitude } : null} onSelect={applyCapturedPoint} onBusy={setCaptureBusy} />
            {form.source && <p className="text-xs text-blue-700">本次坐标来源：{sourceLabels[form.source]}；采集/地图取点保存后为待确认，需重新核实。</p>}
            <label className="loc-field">名称<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="第一教学楼" /></label>
            <label className="loc-field">地址<input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="请输入详细地址" /></label>
            <p className="text-xs text-slate-500">下方经纬度为GCJ-02。不会根据坐标生成楼名，也不会提交签到。</p>
            <div className="loc-fields">
              <label className="loc-field">纬度<input type="number" step="any" value={form.latitude} onChange={e => setForm({ ...form, latitude: Number(e.target.value), source: 'manual' })} /></label>
              <label className="loc-field">经度<input type="number" step="any" value={form.longitude} onChange={e => setForm({ ...form, longitude: Number(e.target.value), source: 'manual' })} /></label>
            </div>
          </div>
      </LocationDialog>}
    </div>
  );
};

export default function SignLocations() {
  const [personalOnly, setPersonalOnly] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    client.get<ApiResponse<{ personal_only: boolean }>>('/sign/locations/settings').then(response => {
      setPersonalOnly(response.data.data.personal_only);
      setError('');
    }).catch(cause => {
      setError(getErrorMessage(cause, '读取地点模式失败'));
    });
  useEffect(() => { void load(); }, []);
  if (error) return <div role="alert" className="p-4 text-red-600">{error}<button type="button" onClick={() => void load()}>重新加载</button></div>;
  if (personalOnly === null) return <p role="status" className="p-4">正在加载地点…</p>;
  return personalOnly ? <PersonalLocations /> : <LegacySignLocations />;
}
