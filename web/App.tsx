import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type Hls from 'hls.js';
import { RunCards } from './components/RunCards';
import { ScheduleTimePicker, SegmentCountControl } from './components/SettingsControls';
import { Activity, ArrowDownToLine, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3, Clapperboard, Database, ExternalLink, Film, Globe2, Layers3, ListVideo, LoaderCircle, LockKeyhole, Pencil, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2, Wifi, X } from 'lucide-react';
import type { CollectionRequest, Dashboard, Movie, Resource, Run, Settings, Source } from '../shared/types';
import { localPosterPath } from '../shared/poster-path';
import { bytesToMegabytes, megabytesToBytes, millisecondsToSeconds, secondsToMilliseconds } from '../shared/settings-units';
import { BEIJING_TIMEZONE, DAILY_TIME_PATTERN, MAX_DAILY_TIMES, normalizedDailyTimes } from '../shared/schedule-settings';
import { episodeKey } from '../shared/episode';
import { PlaybackCheckClient } from './playback-check';
import './components/PlaybackResources.css';

type Page = 'library' | 'sources' | 'runs' | 'settings';
type MovieList = {
  items: (Movie & { resourceCount: number; libraryType: string; updateStatus: 'ongoing' | 'completed' | 'unknown' })[];
  total: number; page: number; limit: number; types: string[]; years: string[]; genres: string[]; regions: string[];
  updateStatuses: ('ongoing' | 'completed' | 'unknown')[]; resourceAvailability: ('yes' | 'no')[];
};
type CollectionMode = 'today' | 'all' | 'range';
const validCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validDateRange = (startDate: string, endDate: string) => validCalendarDate(startDate) && validCalendarDate(endDate) && startDate <= endDate;
const tokenKey = 'cloudmedia-token';
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: BEIJING_TIMEZONE, hour12: false }) : '尚未运行';
const hasRating = (value: string) => Number.isFinite(Number(value)) && Number(value) > 0;
const displayCredits = (value: string) => value.split(/[\/／]+/).map(name => name.trim()).filter(Boolean).join(' / ');
function movieTags(movie: Movie): string[] {
  const basic = [...new Set([movie.type, movie.year, movie.region].map(value => value.trim()).filter(Boolean))];
  const genres = [...new Set(movie.genres.map(value => value.trim()).filter(value => value && !basic.includes(value)))].slice(0, 6);
  return [...basic, ...genres];
}
let onAuthNeeded = () => {};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(tokenKey);
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) onAuthNeeded();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result as T;
}

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Spinner() { return <LoaderCircle size={17} className="spin" aria-hidden="true" />; }
function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const modal = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const items = modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], video[controls]');
        if (!items?.length) return;
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.body.style.overflow = priorOverflow; document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={modal} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={20} /></IconButton></div>{children}</div></div>;
}
function Field({ label, hint, children, full = false }: { label: string; hint?: string; children: ReactNode; full?: boolean }) {
  return <label className={`field ${full ? 'full' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" className={`toggle ${checked ? 'active' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>;
}

export default function App() {
  const [page, setPage] = useState<Page>('library');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sourceEdit, setSourceEdit] = useState<Source | 'new' | null>(null);
  const [sourceRun, setSourceRun] = useState<Source | null>(null);
  const [selectedMovie, setSelectedMovie] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [token, setToken] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  const notify = useCallback((message: string) => { setNotice(message); }, []);
  useEffect(() => { onAuthNeeded = () => setAuthNeeded(true); return () => { onAuthNeeded = () => {}; }; }, []);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [stats, list] = await Promise.all([api<Dashboard>('/dashboard'), api<Source[]>('/sources')]);
        if (active) { setDashboard(stats); setSources(list); setError(''); }
      } catch (e) { if (active) setError((e as Error).message); }
    }
    void refresh();
    const timer = setInterval(refresh, 12000);
    return () => { active = false; clearInterval(timer); };
  }, [revision]);
  const navigate = (next: Page) => { setPage(next); setError(''); };
  const runSource = async (source: Source) => { setSourceRun(source); };
  const saveToken = async (event: FormEvent) => {
    event.preventDefault(); setAuthBusy(true); localStorage.setItem(tokenKey, token.trim());
    try { await api('/dashboard'); setAuthNeeded(false); setToken(''); setError(''); reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setAuthBusy(false); }
  };
  const nav = [
    { key: 'library', name: '影视库', icon: Film }, { key: 'sources', name: '采集源', icon: Globe2 },
    { key: 'runs', name: '任务记录', icon: Activity }, { key: 'settings', name: '系统设置', icon: Settings2 },
  ] as const;
  return <div className="app-shell">
    <aside className="sidebar"><button className="brand" onClick={() => navigate('library')} aria-label="CloudMedia 首页"><span className="brand-icon"><Clapperboard size={22} /></span><span>Cloud<span className="brand-light">Media</span><small>YOUR PERSONAL CINEMA</small></span></button>
      <div className="nav-caption">工作空间</div><nav aria-label="主导航">{nav.map(item => <button key={item.key} className={`nav-item ${page === item.key ? 'selected' : ''}`} aria-current={page === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}><item.icon size={19} /><span>{item.name}</span>{item.key === 'runs' && !!dashboard?.runningCount && <span className="nav-count">{dashboard.runningCount}</span>}{page === item.key && <i />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-badge"><span className={`status-dot ${dashboard ? 'online' : ''}`} />{dashboard ? '本地服务已连接' : '正在连接本地服务'}</div><div className="storage-note"><Database size={13} /> {dashboard?.storage === 'postgres' ? 'PostgreSQL · 本地资料库' : dashboard ? '本地文件 · 预览模式' : 'CloudMedia 0.1'}</div><div className="sidebar-footer">留住好电影，随时再相遇。<span>LOCAL COLLECTION / V0.1</span></div></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb">我的空间 <ChevronRight size={13} /> <span>{nav.find(item => item.key === page)?.name}</span></div><div className="topbar-right"><span className="local-label"><ShieldCheck size={14} /> 本地管理</span><button className="avatar" aria-label="打开系统设置" onClick={() => navigate('settings')}>CM</button></div></header>
      <div className="page-content">{error && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{error}</span><IconButton label="关闭错误" onClick={() => setError('')}><X size={15} /></IconButton></div>}
        {page === 'library' && <Library dashboard={dashboard} sources={sources} revision={revision} onMovie={setSelectedMovie} onSource={() => setSourceEdit('new')} onNavigateSources={() => navigate('sources')} />}
        {page === 'sources' && <Sources sources={sources} dashboard={dashboard} onEdit={setSourceEdit} onRun={runSource} onChanged={reload} notify={notify} onError={setError} />}
        {page === 'runs' && <Runs revision={revision} />}
        {page === 'settings' && <SettingsPage dashboard={dashboard} onSaved={() => { reload(); notify('系统设置已保存'); }} />}
      </div><footer className="page-footer"><span>CloudMedia <span className="footer-divider">/</span> 你的本地影视资料库</span><span>资料归档在本地 · 播放依赖远端资源可用性</span></footer>
    </main>
    {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}
    {sourceEdit && <SourceModal source={sourceEdit} onClose={() => setSourceEdit(null)} onSaved={() => { setSourceEdit(null); reload(); notify('采集源已保存'); }} />}
    {sourceRun && <CollectionModal source={sourceRun} onClose={() => setSourceRun(null)} onStarted={() => { setSourceRun(null); reload(); notify(`已提交「${sourceRun.name}」采集任务`); }} />}
    {selectedMovie && <MovieModal id={selectedMovie} sources={sources} onClose={() => setSelectedMovie(null)} onChange={reload} />}
    {authNeeded && <Modal title="连接受保护的资料库" onClose={() => setAuthNeeded(false)}><form className="auth-form" onSubmit={saveToken}><div className="auth-icon"><LockKeyhole size={28} /></div><p>输入服务端配置的 APP_AUTH_TOKEN。凭证仅保存在当前浏览器。</p><Field label="访问令牌"><input type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required /></Field><button className="button primary" disabled={authBusy}>{authBusy ? <Spinner /> : <LockKeyhole size={16} />}连接资料库</button></form></Modal>}
  </div>;
}

function Library({ dashboard, sources, revision, onMovie, onSource, onNavigateSources }: { dashboard: Dashboard | null; sources: Source[]; revision: number; onMovie: (id: string) => void; onSource: () => void; onNavigateSources: () => void }) {
  const [search, setSearch] = useState(''); const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState({ type: '', genre: '', region: '', year: '', updateStatus: '', hasResources: '', sourceId: '' });
  const [page, setPage] = useState(1); const [list, setList] = useState<MovieList | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => {
    if (search === debouncedSearch) return;
    const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search, debouncedSearch]);
  useEffect(() => {
    let active = true; const controller = new AbortController(); setLoading(true);
    const query = new URLSearchParams({ search: debouncedSearch, ...filters, page: String(page), limit: '12' });
    api<MovieList>(`/movies?${query}`, { signal: controller.signal }).then(result => {
      if (active) { setList(result); setPage(result.page); setError(''); }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [debouncedSearch, filters, page, revision, dashboard?.movieCount, dashboard?.resourceCount, dashboard?.runningCount]);
  const changeFilter = (key: keyof typeof filters, value: string) => { setFilters(previous => ({ ...previous, [key]: value })); setPage(1); };
  const clearFilters = () => { setSearch(''); setDebouncedSearch(''); setFilters({ type: '', genre: '', region: '', year: '', updateStatus: '', hasResources: '', sourceId: '' }); setPage(1); };
  const types = [...new Set(['电影', '电视剧', '动漫', '短剧', '综艺', ...(list?.types ?? [])])];
  const statusLabels = { ongoing: '连载中', completed: '已完结', unknown: '未标明' };
  const filterFields = [
    { key: 'type', label: '类型', all: '全部类型', options: types.map(value => ({ value, label: value })) },
    { key: 'genre', label: '题材', all: '全部题材', options: (list?.genres ?? []).map(value => ({ value, label: value })) },
    { key: 'region', label: '地区', all: '全部地区', options: (list?.regions ?? []).map(value => ({ value, label: value })) },
    { key: 'year', label: '年份', all: '全部年份', options: (list?.years ?? []).map(value => ({ value, label: value })) },
    { key: 'updateStatus', label: '更新状态', all: '全部状态', options: Object.entries(statusLabels).map(([value, label]) => ({ value, label })) },
    { key: 'hasResources', label: '片源', all: '全部片源', options: [{ value: 'yes', label: '有片源' }, { value: 'no', label: '无片源' }] },
    { key: 'sourceId', label: '来源', all: '全部来源', options: sources.map(source => ({ value: source.id, label: source.name })) },
  ] as const;
  const stats = [
    { label: '已归档影片', value: dashboard?.movieCount, unit: '部', icon: Film, color: 'purple', note: '本地保存的影片资料' },
    { label: '播放资源', value: dashboard?.resourceCount, unit: '条', icon: Layers3, color: 'blue', note: `播放时检测记录：${dashboard?.healthyResources ?? 0} 条通过` },
    { label: '采集源', value: dashboard?.sourceCount, unit: '个', icon: Globe2, color: 'green', note: `${dashboard?.enabledSourceCount ?? 0} 个源已启用` },
    { label: '平均下载速度', value: dashboard?.averageSpeedMbps != null ? dashboard.averageSpeedMbps.toFixed(1) : '—', unit: 'Mbps', icon: Wifi, color: 'orange', note: '基于播放时的视频分片检测记录' },
  ];
  const filtered = !!(search || Object.values(filters).some(Boolean));
  const activeFilterCount = Object.values(filters).filter(Boolean).length + (search.trim() ? 1 : 0);
  const currentPage = list?.page ?? page; const totalPages = Math.max(1, Math.ceil((list?.total ?? 0) / 12));
  return <>
    <section className="library-intro"><div><div className="eyebrow"><span /> PRIVATE FILM COLLECTION</div><h1>每一部好片，<span>都有归处。</span></h1><p>汇集电影、剧集、动漫与短剧，让你的私人片库持续生长。</p></div><button className="button primary" onClick={onSource}><Plus size={17} />添加采集源</button></section>
    <section className="stats-grid" aria-label="资料库统计">{stats.map(item => <div className="stat-card" key={item.label}><div className="stat-top"><span>{item.label}</span><span className={`stat-icon ${item.color}`}><item.icon size={17} /></span></div><div className="stat-value">{item.value ?? '—'}<small>{item.unit}</small></div><div className="stat-note">{item.note}</div></div>)}</section>
    <section className="catalogue library-catalogue" aria-busy={loading}>
      <div className="section-heading library-heading"><div><h2>我的影视库 <span>{list?.total ?? 0}</span></h2><p>按类型找故事，按条件挑好片。</p></div><span className="archive-label"><span className="status-dot online" />本地归档</span></div>
      <nav className="library-type-tabs" aria-label="影片分类">{['', ...types].map(value => <button type="button" key={value} className={filters.type === value ? 'selected' : ''} aria-pressed={filters.type === value} onClick={() => changeFilter('type', value)}>{value || '全部'}</button>)}</nav>
      <div className="library-filters">
        <div className="library-search-row"><div className="search-field"><Search size={17} /><input aria-label="搜索影片名称、导演或演员" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索片名、导演、演员…" />{search && <IconButton label="清除搜索" onClick={() => { setSearch(''); setDebouncedSearch(''); setPage(1); }}><X size={15} /></IconButton>}</div><span className="library-page-size">每页 12 部</span></div>
        <div className="library-filter-grid">{filterFields.map(field => <label className="library-filter" key={field.key}><span>{field.label}</span><div className="filter-select"><select aria-label={`影片${field.label}`} value={filters[field.key]} onChange={e => changeFilter(field.key, e.target.value)}><option value="">{field.all}</option>{filters[field.key] && !field.options.some(option => option.value === filters[field.key]) && <option value={filters[field.key]}>{field.key === 'sourceId' ? '已移除的来源' : filters[field.key]}</option>}{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={13} /></div></label>)}</div>
        <div className="library-filter-summary"><span>{loading ? <><Spinner />正在更新…</> : <>共找到 <strong>{list?.total ?? 0}</strong> 部影片</>}{activeFilterCount > 0 && <small> · 已选 {activeFilterCount} 项条件</small>}</span>{filtered && <button type="button" className="text-button" onClick={clearFilters}><X size={12} />清除筛选</button>}</div>
      </div>
      {error ? <div className="inline-error" role="alert"><CircleAlert size={18} />{error}</div> : loading && !list?.items.length ? <div className="loading-state"><Spinner />正在读取影视库…</div> : !list?.items.length ? <div className="library-empty"><div className="empty-art" aria-hidden="true"><div className="empty-poster p-left"><Film size={31} /></div><div className="empty-poster p-center"><Clapperboard size={40} /><span>CLOUDMEDIA</span></div><div className="empty-poster p-right"><Play size={29} /></div><span className="art-spark spark-one" /><span className="art-spark spark-two" /></div><h3>{filtered ? '暂时没有符合条件的影片' : '你的私人影院，从一个源开始'}</h3><p>{filtered ? '调整筛选条件，或清除筛选重新浏览全部影片。' : '添加采集源并运行一次采集，影片资料与播放资源就会出现在这里。'}</p>{filtered ? <button className="button secondary" onClick={clearFilters}>清除筛选</button> : <button className="button secondary" onClick={onNavigateSources}>管理采集源 <ArrowRight size={16} /></button>}<div className="empty-hint"><ShieldCheck size={13} />影片资料保存在本地，源站变更后仍可查看</div></div> : <>
        <div className={`movie-grid library-movie-grid ${loading ? 'refreshing' : ''}`}>{list.items.map(movie => <button type="button" className="movie-card library-movie-card" key={movie.id} onClick={() => onMovie(movie.id)} title={movie.title}>
          <div className="poster">{localPosterPath(movie.poster) ? <img key={movie.poster} src={localPosterPath(movie.poster)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} /> : null}<div className="poster-fallback"><Film size={35} /><span>{movie.title}</span></div><span className="poster-type">{movie.libraryType || '影片'}</span>{hasRating(movie.rating) && <span className="rating">★ {movie.rating}</span>}<div className="poster-hover"><span><Play size={22} fill="currentColor" /></span></div></div>
          <div className="movie-card-title">{movie.title}</div><div className="library-movie-meta">{[movie.year, movie.region].filter(Boolean).join(' · ') || '年份 / 地区未标明'}</div><div className="library-movie-bottom"><span className={`library-update-status ${movie.updateStatus}`}>{statusLabels[movie.updateStatus]}</span><span className={movie.resourceCount ? '' : 'no-resources'}>{movie.resourceCount ? `${movie.resourceCount} 条片源` : '暂无片源'}</span></div>
        </button>)}</div>
        <div className="pagination library-pagination"><span>共 {list.total} 部 · 每页 12 部</span><div><IconButton label="上一页" disabled={loading || currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></IconButton><span aria-live="polite">{currentPage} / {totalPages}</span><IconButton label="下一页" disabled={loading || currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></IconButton></div></div>
      </>}
    </section><div className="library-bottom-note"><span><Clock3 size={14} />下次定时采集：{dashboard?.schedulerNextAt ? date(dashboard.schedulerNextAt) : '未安排'}</span><button onClick={() => onNavigateSources()}>查看采集配置 <ArrowRight size={13} /></button></div>
  </>;
}

function Sources({ sources, dashboard, onEdit, onRun, onChanged, notify, onError }: { sources: Source[]; dashboard: Dashboard | null; onEdit: (source: Source | 'new') => void; onRun: (source: Source) => Promise<void>; onChanged: () => void; notify: (message: string) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState('');
  const mutate = async (source: Source, action: 'toggle' | 'delete') => {
    if (action === 'delete' && !window.confirm(`删除采集源「${source.name}」？已采集的影片和播放资源会保留。`)) return;
    setBusy(source.id);
    try {
      if (action === 'toggle') { await api(`/sources/${source.id}`, { method: 'PUT', body: JSON.stringify({ ...source, adapter: 'html', enabled: !source.enabled }) }); notify(source.enabled ? '已暂停定时采集此源' : '已启用此采集源'); }
      else { await api(`/sources/${source.id}`, { method: 'DELETE' }); notify('采集源已删除，本地资料已保留'); }
      onChanged();
    } catch (e) { onError((e as Error).message); } finally { setBusy(''); }
  };
  return <><div className="page-heading"><div><div className="eyebrow">COLLECTION SOURCES</div><h1>采集源</h1><p>管理内容入口，让最新的电影与剧集自动归档。</p></div><button className="button primary" onClick={() => onEdit('new')}><Plus size={17} />添加采集源</button></div><div className="info-strip"><ShieldCheck size={18} /><span>通过 CSS 选择器采集公开 HTML 页面。域名变化时编辑入口地址，本地影片资料会保留。</span></div>
    <div className="source-summary"><span>{sources.length} 个采集源</span><span><i className="status-dot online" />{dashboard?.enabledSourceCount ?? sources.filter(source => source.enabled).length} 个已启用</span></div>
    {!sources.length ? <div className="panel empty-small"><Globe2 size={36} /><h3>连接你的第一个内容源</h3><p>设置站点入口和 CSS 选择器，然后手动采集验证结果。</p><button className="button secondary" onClick={() => onEdit('new')}><Plus size={16} />添加采集源</button></div> : <div className="source-grid">{sources.map(source => <article className="source-card" key={source.id}><div className="source-card-head"><span className="source-icon"><Globe2 size={22} /></span><div><h3>{source.name}</h3><span className={`badge ${source.enabled ? 'success' : 'muted'}`}>{source.enabled ? '已启用' : '已暂停'}</span></div><div className="source-toggle"><Toggle checked={source.enabled} label={`${source.name}启用状态`} onChange={() => void mutate(source, 'toggle')} /></div></div><a className="source-url" href={source.baseUrl} target="_blank" rel="noreferrer">{source.baseUrl}<ExternalLink size={12} /></a><div className="source-details"><div><span>解析方式</span><strong>HTML / CSS 选择器</strong></div><div><span>请求间隔</span><strong>{source.requestIntervalMs / 1000} 秒</strong></div><div><span>并发数</span><strong>{source.concurrency ?? 1}</strong></div><div><span>采集范围</span><strong>运行时选择</strong></div><div><span>最近采集</span><strong>{date(source.lastRunAt)}</strong></div></div>{source.lastError && <div className="source-error"><CircleAlert size={13} /><span>{source.lastError}</span></div>}<div className="source-actions"><button className="button secondary" disabled={busy === source.id} onClick={() => void onRun(source)}>{busy === source.id ? <Spinner /> : <Play size={14} />}立即采集</button><button className="text-button" onClick={() => onEdit(source)}><Pencil size={14} />编辑</button><IconButton label={`删除${source.name}`} disabled={busy === source.id} onClick={() => void mutate(source, 'delete')}><Trash2 size={15} /></IconButton></div></article>)}</div>}
  </>;
}

function CollectionScope({ mode, onModeChange, startDate, endDate, onStartDate, onEndDate, disabled = false }: {
  mode: CollectionMode; onModeChange: (mode: CollectionMode) => void;
  startDate: string; endDate: string; onStartDate: (value: string) => void; onEndDate: (value: string) => void; disabled?: boolean;
}) {
  const name = useId();
  return <fieldset className="collection-scope" disabled={disabled}>
    <legend>采集范围</legend>
    <div className="collection-scope-options">{([['today', '今天'], ['all', '全部'], ['range', '区间']] as const).map(([value, label]) =>
      <label key={value} className={`collection-scope-option ${mode === value ? 'selected' : ''}`}>
        <input type="radio" name={name} value={value} checked={mode === value} onChange={() => onModeChange(value)} /><span>{label}</span>
      </label>)}
    </div>
    <p className="collection-scope-hint">{mode === 'all' ? '采集列表中的全部影片及播放资源。' : mode === 'today' ? '按源站更新时间采集今天的内容。' : '按源站更新时间筛选，开始和结束日期均包含在内。'}</p>
    {mode === 'range' && <div className="form-grid collection-date-fields">
      <Field label="开始日期"><input type="date" value={startDate} min="0001-01-01" max={endDate || '9999-12-31'} required onChange={e => onStartDate(e.target.value)} /></Field>
      <Field label="结束日期"><input type="date" value={endDate} min={startDate || '0001-01-01'} max="9999-12-31" required onChange={e => onEndDate(e.target.value)} /></Field>
    </div>}
  </fieldset>;
}

function CollectionModal({ source, onClose, onStarted }: { source: Source; onClose: () => void; onStarted: () => void }) {
  const [clockReady, setClockReady] = useState(false);
  const [clockRevision, setClockRevision] = useState(0);
  const [mode, setMode] = useState<CollectionMode>('today');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setClockReady(false); setError('');
    api<ServerTime>('/time').then(clock => {
      if (!active) return;
      if (!clock.synchronized || !clock.now) throw new Error('等待网络校时完成后才能开始采集，请稍后重试。');
      const now = new Date(clock.now);
      if (!Number.isFinite(now.getTime())) throw new Error('服务器北京时间无效，请稍后重试。');
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BEIJING_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const today = ['year', 'month', 'day'].map(name => parts.find(part => part.type === name)!.value).join('-');
      setStartDate(value => value || today); setEndDate(value => value || today); setClockReady(true);
    }).catch(e => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [clockRevision]);
  const close = () => { if (!busy) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!clockReady || busy) return;
    if (mode === 'range' && !validDateRange(startDate, endDate)) { setError('请选择有效的日期区间，开始日期不能晚于结束日期。'); return; }
    setBusy(true); setError('');
    try {
      const request: CollectionRequest = mode === 'range' ? { mode, startDate, endDate } : { mode };
      await api<Run>(`/sources/${source.id}/run`, { method: 'POST', body: JSON.stringify(request) });
      onStarted();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={`开始采集 · ${source.name}`} onClose={close}><form onSubmit={submit}>
    <div className="modal-body">
      <p className="form-intro">选择本次采集范围，默认采集今天更新的内容。采集结果自动保存到资料库。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading ? <div className="loading-state"><Spinner />正在读取北京时间…</div> : clockReady ? <>
        <div className="collection-date-heading"><span><Clock3 size={14} />北京时间</span></div>
        <CollectionScope mode={mode} onModeChange={value => { setMode(value); setError(''); }} startDate={startDate} endDate={endDate} onStartDate={setStartDate} onEndDate={setEndDate} disabled={busy} />
        <div className="subtle-note"><Database size={14} /><span>重复采集会更新已有记录，长任务可在“任务记录”查看进度或取消。</span></div>
      </> : <button type="button" className="button secondary" onClick={() => setClockRevision(value => value + 1)}><RefreshCw size={14} />重新检查校时</button>}
    </div>
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={loading || !clockReady || busy}>{busy ? <Spinner /> : <Play size={15} />}开始采集</button></div>
  </form></Modal>;
}

function SourceModal({ source, onClose, onSaved }: { source: Source | 'new'; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<Source>>(() => source === 'new' ? {
    name: '', baseUrl: '', adapter: 'html', enabled: true, collectionMode: 'today', updatesSortedDescending: false,
    listPath: '/', detailLinkSelector: 'a[href*="/voddetail/"]', titleSelector: 'h1', posterSelector: '.module-item-pic img, .vodlist_thumb img',
    descriptionSelector: '.module-info-introduction, .vod_content', resourceSelector: 'a[href*="/vodplay/"], a[href$=".m3u8"], a[href*=".m3u8?"], a[href*=".m3u8#"]',
    nextPageSelector: 'a[title="下一页"]', requestIntervalMs: 2500, concurrency: 1,
  } : { ...source, concurrency: source.concurrency ?? 1 });
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const update = <K extends keyof Source>(key: K, value: Source[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const concurrency = form.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) { setError('并发数必须为 1 至 100 的整数。'); return; }
    setSaving(true); setError('');
    try {
      const input = { ...form, adapter: 'html', concurrency, referer: '' };
      await api(source === 'new' ? '/sources' : `/sources/${source.id}`, { method: source === 'new' ? 'POST' : 'PUT', body: JSON.stringify(input) });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <Modal title={source === 'new' ? '添加采集源' : `编辑 · ${source.name}`} onClose={onClose}><form onSubmit={submit}>
    <div className="modal-body">
      <p className="form-intro">设置网站入口、CSS 选择器和采集并发。采集范围在“立即采集”时选择。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="源名称"><input value={form.name} required maxLength={100} placeholder="例如：我的影视源" onChange={e => update('name', e.target.value)} /></Field>
        <div className="field"><span>解析方式</span><div className="parser-label">HTML / CSS 选择器</div></div>
        <p className="parser-description">通过 CSS 选择器读取公开 HTML 页面的影片资料和播放链接。</p>
        <Field label="网站入口" hint="域名变更后修改这里，已入库资料继续保留。" full><input type="url" value={form.baseUrl} placeholder="https://example.com" required onChange={e => update('baseUrl', e.target.value)} /></Field>
        <Field label="列表路径" hint="相对于网站入口的路径，例如 / 或 /vodshow/1.html。" full><input value={form.listPath} onChange={e => update('listPath', e.target.value)} required /></Field>
        <div className="field full"><div className="collection-sort-setting"><div><strong>列表按更新时间倒序</strong><small>仅当列表保证从新到旧排列时启用；按日期采集时，遇到早于开始日期的影片后停止翻页。</small></div><Toggle label="列表按更新时间倒序" checked={form.updatesSortedDescending ?? false} onChange={value => update('updatesSortedDescending', value)} /></div></div>
        <Field label="详情链接选择器" full><input value={form.detailLinkSelector} onChange={e => update('detailLinkSelector', e.target.value)} required /></Field>
        <Field label="标题选择器"><input value={form.titleSelector} onChange={e => update('titleSelector', e.target.value)} required /></Field>
        <Field label="海报选择器"><input value={form.posterSelector} onChange={e => update('posterSelector', e.target.value)} /></Field>
        <Field label="简介选择器" full><input value={form.descriptionSelector} onChange={e => update('descriptionSelector', e.target.value)} /></Field>
        <Field label="播放链接选择器" full hint="支持直接 m3u8 链接及公开播放页中的播放器地址。"><input value={form.resourceSelector} onChange={e => update('resourceSelector', e.target.value)} /></Field>
        <Field label="下一页选择器" full><input value={form.nextPageSelector} onChange={e => update('nextPageSelector', e.target.value)} /></Field>
        <Field label="请求间隔（秒）" hint="0 表示不额外等待；最多 60 秒，支持三位小数。"><input type="number" min={0} max={60} step={0.001} value={(form.requestIntervalMs ?? 2500) / 1000} onChange={e => update('requestIntervalMs', Math.round(Number(e.target.value) * 1000))} required /></Field>
        <Field label="并发数" hint="同时采集的影片数，范围 1–100；只获取资料和片源，空闲后自动补位。"><input type="number" min={1} max={100} step={1} value={form.concurrency ?? 1} onChange={e => update('concurrency', Number(e.target.value))} required /></Field>
      </div>
    </div>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? <Spinner /> : <Check size={16} />}保存采集源</button></div>
  </form></Modal>;
}

function Runs({ revision }: { revision: number }) {
  const [runs, setRuns] = useState<Run[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [actionError, setActionError] = useState('');
  const [clock, setClock] = useState<{ epoch: number; receivedAt: number } | null>(null);
  useEffect(() => {
    let active = true;
    const sync = async () => {
      try {
        const time = await api<ServerTime>('/time');
        if (active) setClock(time.synchronized && time.now ? { epoch: Date.parse(time.now), receivedAt: performance.now() } : null);
      } catch { if (active) setClock(null); }
    };
    void sync(); const timer = window.setInterval(sync, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [expanded, setExpanded] = useState<string | null>(null); const [canceling, setCanceling] = useState<string[]>([]); const [deleting, setDeleting] = useState<string[]>([]);
  const deletedRuns = useRef(new Set<string>());
  useEffect(() => { let active = true; const load = async () => { try { const result = await api<Run[]>('/runs'); if (active) { setRuns(result.filter(run => !deletedRuns.current.has(run.id))); setError(''); } } catch (e) { if (active) setError((e as Error).message); } finally { if (active) setLoading(false); } }; void load(); const timer = setInterval(load, 4000); return () => { active = false; clearInterval(timer); }; }, [revision]);
  const cancelRun = async (id: string) => {
    if (canceling.includes(id)) return;
    setCanceling(previous => [...previous, id]); setActionError('');
    try {
      const updated = await api<Run>(`/runs/${id}/cancel`, { method: 'POST' });
      setRuns(previous => previous.map(run => run.id === updated.id ? updated : run));
    } catch (e) { setActionError((e as Error).message); }
    finally { setCanceling(previous => previous.filter(item => item !== id)); }
  };
  const deleteRun = async (id: string) => {
    if (deleting.includes(id)) return;
    setDeleting(previous => [...previous, id]); setActionError('');
    try {
      await api(`/runs/${id}`, { method: 'DELETE' });
      deletedRuns.current.add(id);
      setRuns(previous => previous.filter(run => run.id !== id));
      setExpanded(previous => previous === id ? null : previous);
    } catch (e) { setActionError((e as Error).message); }
    finally { setDeleting(previous => previous.filter(item => item !== id)); }
  };
  return <><div className="page-heading"><div><div className="eyebrow">COLLECTION ACTIVITY</div><h1>任务记录</h1><p>跟踪影片采集与资源检测，及时了解进度和异常。</p></div><span className="badge"><RefreshCw size={12} />每 4 秒更新</span></div>{(actionError || error) && <div className="inline-error" role="alert">{actionError || error}</div>}{loading ? <div className="panel loading-state"><Spinner />读取任务记录…</div> : !runs.length ? <div className="panel empty-small"><Activity size={37} /><h3>还没有采集任务</h3><p>在采集源页面运行一次采集，或等待下次定时任务。</p></div> : <RunCards runs={runs} clock={clock} expanded={expanded} canceling={canceling} deleting={deleting} onExpand={id => setExpanded(value => value === id ? null : id)} onCancel={id => void cancelRun(id)} onDelete={id => void deleteRun(id)} />}</>;
}

type ServerTime = { now: string | null; timezone: string; synchronized: boolean; lastSyncedAt: string | null; source: string | null; error: string | null };

function ServerClock() {
  const [sample, setSample] = useState<{ value: ServerTime; receivedAt: number } | null>(null);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await api<ServerTime>('/time');
        if (active) { setSample({ value, receivedAt: performance.now() }); setError(''); }
      } catch (e) { if (active) setError((e as Error).message); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const anchor = sample?.value.now ? Date.parse(sample.value.now) : NaN;
    if (!sample || !Number.isFinite(anchor)) { setClockNow(null); return; }
    const tick = () => setClockNow(anchor + performance.now() - sample.receivedAt);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sample]);
  const synced = !!sample?.value.synchronized && !error;
  const status = synced ? '已同步' : sample || error ? '未同步' : '校时中';
  return <div className="server-clock">
    <div><span className="server-clock-label">当前北京时间</span><strong>{synced && clockNow !== null ? date(new Date(clockNow).toISOString()) : '等待网络校时'}</strong></div>
    <span className={`badge ${synced ? 'success' : 'muted'}`}><span className={`status-dot ${synced ? 'online' : ''}`} />{status}</span>
    <p>{error || sample?.value.error || (sample?.value.lastSyncedAt ? `最近校时：${date(sample.value.lastSyncedAt)}` : '连接网络时间源后显示北京时间。')}</p>
  </div>;
}

function SettingsPage({ dashboard, onSaved }: { dashboard: Dashboard | null; onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [sampleMegabytes, setSampleMegabytes] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('');
  const [newDailyTime, setNewDailyTime] = useState('09:00');
  const loadSettings = (result: Settings) => { const dailyTimes = normalizedDailyTimes(result); setSettings({ ...result, dailyTimes, dailyTime: dailyTimes[0], timezone: BEIJING_TIMEZONE }); setSampleMegabytes(bytesToMegabytes(result.sampleBytes)); setTimeoutSeconds(millisecondsToSeconds(result.probeTimeoutMs)); };
  useEffect(() => { let active = true; api<Settings>('/settings').then(result => { if (active) loadSettings(result); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => previous ? ({ ...previous, [key]: value }) : previous);
  const dailyTimes = settings ? normalizedDailyTimes(settings) : [];
  const updateTimes = (times: string[]) => { if (!times.length) return; const sorted = [...new Set(times)].sort(); setSettings(previous => previous ? { ...previous, dailyTimes: sorted, dailyTime: sorted[0], timezone: BEIJING_TIMEZONE } : previous); };
  const addTime = () => {
    if (!DAILY_TIME_PATTERN.test(newDailyTime)) { setError('请选择有效的每日运行时间。'); return; }
    if (dailyTimes.includes(newDailyTime)) { setError('此运行时间已存在。'); return; }
    if (dailyTimes.length >= MAX_DAILY_TIMES) { setError('每日运行时间最多 24 条。'); return; }
    setError(''); updateTimes([...dailyTimes, newDailyTime]);
  };
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!settings) return; setBusy(true); setError(''); try { const input = { ...settings, probeEnabled: false, dailyTimes, dailyTime: dailyTimes[0], timezone: BEIJING_TIMEZONE, sampleBytes: megabytesToBytes(sampleMegabytes), probeTimeoutMs: secondsToMilliseconds(timeoutSeconds) }; const result = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(input) }); loadSettings(result); onSaved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <><div className="page-heading"><div><div className="eyebrow">SYSTEM PREFERENCES</div><h1>系统设置</h1><p>安排采集节奏，设置播放时的线路检测参数。</p></div></div>{error && <div className="inline-error" role="alert">{error}</div>}{!settings ? <div className="loading-state"><Spinner />读取配置…</div> : <form onSubmit={submit} className="settings-form"><section className="panel settings-section"><div className="settings-section-heading"><span className="section-icon"><Clock3 size={20} /></span><div><h2>每日采集</h2><p>按北京时间的多个时间点，依次更新所有已启用的源。</p></div></div><ServerClock /><div className="setting-toggle-row"><div><strong>启用定时任务</strong><small>下次运行（北京时间）：{dashboard?.schedulerNextAt ? date(dashboard.schedulerNextAt) : '未安排'}</small></div><Toggle checked={settings.schedulerEnabled} label="启用定时任务" onChange={value => update('schedulerEnabled', value)} /></div><div className="daily-times-setting"><div className="daily-times-heading"><strong>每日运行时间</strong><span>北京时间 · 至少 1 条，最多 24 条</span></div><ul className="daily-times-list" aria-label="每日运行时间">{dailyTimes.map(time => <li key={time}><span><Clock3 size={14} />{time}</span><IconButton label={`删除每日运行时间 ${time}`} disabled={busy || dailyTimes.length === 1} onClick={() => updateTimes(dailyTimes.filter(value => value !== time))}><Trash2 size={14} /></IconButton></li>)}</ul><div className="daily-time-add"><div className="field"><span>新增运行时间</span><ScheduleTimePicker value={newDailyTime} onChange={setNewDailyTime} disabled={busy || dailyTimes.length >= MAX_DAILY_TIMES} /></div><button type="button" className="button secondary" onClick={addTime} disabled={busy || dailyTimes.length >= MAX_DAILY_TIMES}><Plus size={14} />添加时间</button></div><p className="daily-times-hint">相同时间只保存一次，按时间先后排列；最后一个时间不可删除。</p></div></section>
      <section className="panel settings-section"><div className="settings-section-heading"><span className="section-icon blue"><Wifi size={20} /></span><div><h2>播放时线路检测</h2><p>点击播放某集时，自动检测该集全部线路的分辨率与下载速度；采集时不检测。</p></div></div><div className="form-grid"><div className="field full"><span>抽测分片数量</span><SegmentCountControl value={settings.sampleSegments} onChange={value => update('sampleSegments', value)} disabled={busy} /></div><Field label="每个分片最多下载（MB）" hint="1 MB = 1,000,000 字节；范围 0.016384–4.194304 MB。"><input type="number" min={0.016384} max={4.194304} step={0.000001} value={sampleMegabytes} onChange={e => setSampleMegabytes(e.target.value)} required /></Field><Field label="单次请求超时（秒）" hint="范围 1–60 秒，支持三位小数。"><input type="number" min={1} max={60} step={0.001} value={timeoutSeconds} onChange={e => setTimeoutSeconds(e.target.value)} required /></Field><Field label="多清晰度优先选择"><select value={settings.preferredQuality} onChange={e => update('preferredQuality', e.target.value as Settings['preferredQuality'])}><option value="highest">最高画质</option><option value="lowest">最低画质</option></select></Field></div><div className="subtle-note"><CircleAlert size={14} />检测在后台进行，不阻挡播放；结果反映部署服务器到播放源的连接情况；分辨率无法可靠识别时显示为未知。</div></section>
      <section className="panel settings-section"><div className="settings-section-heading"><span className="section-icon green"><ShieldCheck size={20} /></span><div><h2>采集请求</h2><p>通过请求间隔、有限重试与退避，控制对源站的访问频率。</p></div></div><div className="form-grid"><Field label="播放地址缓存时长（小时）" hint="仅缓存解析后的播放地址，不缓存视频内容。默认 168 小时（7 天）；地址过期或上次检测失败时重新解析播放页。"><input type="number" min={1} max={720} value={settings.resourceRefreshHours ?? 168} onChange={e => update('resourceRefreshHours', +e.target.value)} required /></Field><Field label="失败最大重试次数"><input type="number" min={0} max={4} value={settings.maxRetries} onChange={e => update('maxRetries', +e.target.value)} required /></Field><Field label="User-Agent" hint="默认使用当前 Chrome 桌面浏览器的 User-Agent，可按需修改。" full><input value={settings.userAgent} onChange={e => update('userAgent', e.target.value)} required maxLength={300} /></Field></div></section><div className="settings-save"><span><Database size={14} />{dashboard?.storage === 'postgres' ? '设置保存在 PostgreSQL' : '设置保存在本地数据文件'}</span><button className="button primary" disabled={busy}>{busy ? <Spinner /> : <Check size={16} />}保存设置</button></div></form>}</>;
}

function Player({ resource, playing, onPlay }: { resource: Resource; playing: boolean; onPlay: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const element = video.current; if (!element) return;
    setError(''); const token = localStorage.getItem(tokenKey); const url = `/api/play/${encodeURIComponent(resource.id)}/index.m3u8${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    let hls: Hls | null = null; let active = true;
    void import('hls.js').then(({ default: HlsPlayer }) => {
      if (!active) return;
      if (HlsPlayer.isSupported()) { hls = new HlsPlayer({ maxBufferLength: 30 }); hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => { if (active) void element.play().catch(() => {}); }); hls.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) { setError(`播放失败：${data.type === 'networkError' ? '无法读取远端播放资源，请更换线路或重新解析地址。' : '当前资源无法解码或格式不受支持。'}`); hls?.destroy(); } }); hls.loadSource(url); hls.attachMedia(element); }
      else if (element.canPlayType('application/vnd.apple.mpegurl')) { element.src = url; void element.play().catch(() => {}); }
      else setError('当前浏览器不支持 HLS 播放，请使用较新的 Chrome、Edge 或 Safari。');
    }).catch(() => { if (active) setError('播放器组件加载失败，请刷新页面重试。'); });
    return () => { active = false; hls?.destroy(); element.pause(); element.removeAttribute('src'); element.load(); };
  }, [resource.id, resource.url, attempt, playing]);
  return <div className="player"><video ref={video} controls={playing} playsInline preload="none" onError={() => setError('播放器无法读取此资源，请更换线路或重新解析地址。')} />{!playing && <div className="player-start"><button type="button" className="button primary" onClick={onPlay}><Play size={19} />播放视频</button><p>播放时同步检测本集各线路，检测不影响视频启动。</p></div>}{error && <div className="player-error"><CircleAlert size={25} /><p>{error}</p><button type="button" className="button secondary" onClick={() => { setAttempt(value => value + 1); onPlay(); }}><RefreshCw size={14} />重新加载</button></div>}</div>;
}
function MovieModal({ id, sources, onClose, onChange }: { id: string; sources: Source[]; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<{ movie: Movie; resources: Resource[] } | null>(null);
  const [error, setError] = useState(''); const [selected, setSelected] = useState(''); const [playing, setPlaying] = useState(false);
  const [checking, setChecking] = useState<string[]>([]); const [refreshing, setRefreshing] = useState(false);
  const [playbackRevision, setPlaybackRevision] = useState(0); const [message, setMessage] = useState('');
  const mounted = useRef(false); const viewId = useRef(id); viewId.current = id;
  const currentEpisode = useRef(''); const currentSelection = useRef(selected); currentSelection.current = selected;
  const [checks] = useState(() => new PlaybackCheckClient(async resourceId => (await api<{ resources: Resource[] }>(`/resources/${resourceId}/check-playback`, { method: 'POST' })).resources));
  useEffect(() => {
    mounted.current = true; setData(null); setPlaying(false); setChecking([]); setRefreshing(false); setError(''); setMessage('');
    let active = true;
    api<{ movie: Movie; resources: Resource[] }>(`/movies/${id}`).then(result => { if (active) { setData(result); setSelected(result.resources[0]?.id ?? ''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; mounted.current = false; };
  }, [id]);
  useEffect(() => {
    if (!checking.length) return;
    let active = true; let busy = false;
    const poll = async () => {
      if (busy) return; busy = true;
      try {
        const result = await api<{ movie: Movie; resources: Resource[] }>(`/movies/${id}`);
        if (active) setData(previous => ({ ...result, resources: result.resources.map(item => {
          const existing = previous?.resources.find(resource => resource.id === item.id);
          return existing && existing.updatedAt > item.updatedAt ? existing : item;
        }) }));
      }
      catch { /* The check request reports failures; polling can recover on the next tick. */ }
      finally { busy = false; }
    };
    const timer = window.setInterval(poll, 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [id, checking.length]);
  const resource = data?.resources.find(item => item.id === selected);
  const selectedEpisode = resource ? episodeKey(resource.episode) : '';
  currentEpisode.current = selectedEpisode;
  const episodes = [...new Map((data?.resources || []).map(item => [episodeKey(item.episode), item.episode || '正片'])).entries()];
  const lines = data?.resources.filter(item => episodeKey(item.episode) === selectedEpisode) || [];
  const beginPlayback = (item: Resource) => {
    currentSelection.current = item.id;
    setSelected(item.id); setPlaying(true); setPlaybackRevision(value => value + 1); setError(''); setMessage('');
    const episode = episodeKey(item.episode); const movieId = id; currentEpisode.current = episode;
    setChecking(previous => previous.includes(episode) ? previous : [...previous, episode]);
    void checks.check(item).then(results => {
      if (!mounted.current || viewId.current !== movieId) return;
      const updates = new Map(results.map(result => [result.id, result]));
      setData(previous => previous && previous.movie.id === movieId ? { ...previous, resources: previous.resources.map(existing => {
        const result = updates.get(existing.id);
        return result && result.updatedAt >= existing.updatedAt ? result : existing;
      }) } : previous);
      if (currentEpisode.current === episode) setMessage(`本集 ${results.length} 条线路已完成检测${results.some(result => result.probe.status === 'error') ? '，部分线路暂不可用。' : '。'}`);
      onChange();
    }).catch(e => { if (mounted.current && viewId.current === movieId && currentEpisode.current === episode) setError((e as Error).message); })
      .finally(() => { if (mounted.current && viewId.current === movieId) setChecking(previous => previous.filter(value => value !== episode)); });
  };
  const chooseResource = (item: Resource) => { if (playing) beginPlayback(item); else { currentSelection.current = item.id; setSelected(item.id); setMessage(''); setError(''); } };
  const refreshResource = async () => {
    if (!resource?.pageUrl) return;
    const movieId = id; const resourceId = resource.id;
    setRefreshing(true); setMessage(''); setError('');
    try {
      const result = await api<Resource>(`/resources/${resourceId}/refresh`, { method: 'POST' });
      if (!mounted.current || viewId.current !== movieId) return;
      setData(previous => previous && previous.movie.id === movieId ? { ...previous, resources: previous.resources.map(item => item.id === result.id && result.updatedAt >= item.updatedAt ? result : item) } : previous);
      if (currentSelection.current === resourceId) { setPlaybackRevision(value => value + 1); setMessage('播放地址已重新解析。'); }
      onChange();
    } catch (e) { if (mounted.current && viewId.current === movieId && currentSelection.current === resourceId) setError((e as Error).message); }
    finally { if (mounted.current && viewId.current === movieId) setRefreshing(false); }
  };
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => { setPosterFailed(false); }, [id, data?.movie.poster]);
  const movie = data?.movie;
  const archivedPoster = localPosterPath(movie?.poster || ''); const posterAvailable = !!archivedPoster && !posterFailed;
  const posterArchive = movie?.posterArchive;
  const posterStatus = posterFailed || posterArchive?.status === 'saved' ? '已归档图片不可用' : posterArchive?.status === 'error' ? '图片归档失败' : posterArchive?.status === 'missing' || (!movie?.poster && !posterArchive) ? '暂无图片' : '图片待归档';
  const resolution = (item: Resource) => item.probe.width && item.probe.height ? `${item.probe.width} × ${item.probe.height}` : '未知';
  return <Modal title={movie?.title ?? '影片详情'} onClose={onClose} wide>{error && <div className="inline-error" role="alert">{error}</div>}{!movie ? <div className="loading-state"><Spinner />读取影片资料…</div> : <div className="movie-detail"><div className="movie-detail-top"><div className="detail-poster-archive"><div className="detail-poster">{posterAvailable ? <img src={archivedPoster} alt={`${movie.title}海报`} referrerPolicy="no-referrer" onError={() => setPosterFailed(true)} /> : <Film size={40} />}</div>{!posterAvailable && <div className="poster-archive-status" role="status"><span>{posterStatus}</span>{posterArchive?.error && <small>{posterArchive.error}</small>}</div>}</div><div><div className="movie-detail-tags">{movieTags(movie).map((tag, index) => <span key={`${tag}-${index}`} className="badge">{tag}</span>)}{hasRating(movie.rating) && <span className="rating-text">★ {movie.rating}</span>}</div>{movie.originalTitle && <p className="original-title">{movie.originalTitle}</p>}{movie.director && <p className="credit"><span>导演</span>{displayCredits(movie.director)}</p>}{!!movie.actors.length && <p className="credit"><span>主演</span>{movie.actors.join(' / ')}</p>}{movie.status && <p className="credit"><span>状态</span>{movie.status}</p>}<p className="movie-description">{movie.description || '暂无剧情简介。'}</p><small className="text-muted">归档时间 {date(movie.createdAt)}</small></div></div>
    <div className="resource-section"><div className="section-heading"><div><h2><ListVideo size={19} />播放资源 <span>{data.resources.length}</span></h2></div>{resource?.pageUrl && sources.some(source => source.id === resource.sourceId) && <button className="button secondary small" title="重新请求原播放页，更新当前线路地址" onClick={() => void refreshResource()} disabled={refreshing}>{refreshing ? <Spinner /> : <ArrowDownToLine size={14} />}重新解析地址</button>}</div>
      {!data.resources.length ? <div className="resource-empty"><Radio size={26} /><p>已保存影片资料，暂未发现可播放的 m3u8 地址。</p></div> : <>
        <div className="episode-heading"><label>选择剧集<select aria-label="选择剧集" value={selectedEpisode} onChange={event => { const next = data.resources.find(item => episodeKey(item.episode) === event.target.value); if (next) chooseResource(next); }}>{episodes.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span>{episodes.length} 集 · 本集 {lines.length} 条线路</span></div>
        {resource && <><div className="resource-options current-episode-lines" aria-label="本集播放线路">{lines.map(item => <button key={item.id} className={`resource-option ${selected === item.id ? 'selected' : ''}`} aria-pressed={selected === item.id} onClick={() => chooseResource(item)}><Play size={13} /><span>{item.name || '默认线路'}</span><small>{item.probe.checkedAt ? resolution(item) : '播放后检测'}</small><i className={`status-dot ${item.probe.status === 'ok' ? 'online' : item.probe.status === 'error' ? 'failed' : ''}`} /></button>)}</div>
          <Player key={`${resource.id}:${resource.url}:${playbackRevision}`} resource={resource} playing={playing} onPlay={() => beginPlayback(resource)} />
          <div className="episode-check-heading"><div><h3>本集线路对比</h3><p>播放时检测全部线路，结果保存在资料库。</p></div>{checking.includes(selectedEpisode) && <span role="status"><Spinner />正在检测 {lines.length} 条线路…</span>}</div>
          <div className="episode-line-table-wrap"><table className="episode-line-table"><thead><tr><th>线路</th><th>分辨率</th><th>下载速度</th><th>最近检测</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{lines.map(item => <tr key={item.id} className={selected === item.id ? 'is-selected' : ''}><td>{item.name || '默认线路'}{selected === item.id && <small>当前线路</small>}</td><td>{resolution(item)}</td><td>{item.probe.speedMbps != null ? `${item.probe.speedMbps.toFixed(2)} Mbps` : '—'}</td><td>{item.probe.checkedAt ? date(item.probe.checkedAt) : '尚未检测'}</td><td><span className={`badge ${item.probe.status === 'ok' ? 'success' : item.probe.status === 'error' ? 'error' : 'muted'}`} title={item.probe.error || undefined}>{item.probe.status === 'ok' ? '可用' : item.probe.status === 'error' ? '暂不可用' : checking.includes(selectedEpisode) ? '检测中' : '播放后检测'}</span></td><td><button type="button" className="text-button" onClick={() => beginPlayback(item)}><Play size={13} />{playing && selected === item.id ? '重新播放' : '播放'}</button></td></tr>)}</tbody></table></div>
          {resource.probe.error && <div className="source-error"><CircleAlert size={14} />{resource.probe.error}</div>}{message && <p className="resource-message" role="status">{message}</p>}<details className="resource-address"><summary>查看已归档的资源地址</summary><code>{resource.url}</code></details>
        </>}
      </>}
    </div></div>}</Modal>;
}
