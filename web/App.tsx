import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type Hls from 'hls.js';
import { Activity, ArrowDownToLine, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3, Clapperboard, Database, ExternalLink, Film, Globe2, Layers3, ListVideo, LoaderCircle, LockKeyhole, Pencil, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2, Wifi, X } from 'lucide-react';
import type { CollectionRequest, Dashboard, Movie, Resource, Run, Settings, Source } from '../shared/types';
import { localPosterPath } from '../shared/poster-path';

type Page = 'library' | 'sources' | 'runs' | 'settings';
type MovieList = { items: (Movie & { resourceCount: number })[]; total: number; page: number; limit: number; types: string[]; years: string[] };
type CollectionMode = 'today' | 'all' | 'range';
const collectionMode = (source: Partial<Source>): CollectionMode => source.collectionMode === 'updates' ? 'today' : source.collectionMode || 'all';
const validCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validDateRange = (startDate: string, endDate: string) => validCalendarDate(startDate) && validCalendarDate(endDate) && startDate <= endDate;
const tokenKey = 'cloudmedia-token';
const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未运行';
const statusNames: Record<Run['status'], string> = { queued: '等待中', running: '采集中', success: '已完成', error: '失败', interrupted: '已中断' };
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
  const [type, setType] = useState(''); const [year, setYear] = useState(''); const [sourceId, setSourceId] = useState('');
  const [page, setPage] = useState(1); const [list, setList] = useState<MovieList | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let active = true; setLoading(true);
    const query = new URLSearchParams({ search: debouncedSearch, type, year, sourceId, page: String(page), limit: '24' });
    api<MovieList>(`/movies?${query}`).then(result => { if (active) { setList(result); setError(''); } }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [debouncedSearch, type, year, sourceId, page, revision, dashboard?.movieCount, dashboard?.resourceCount, dashboard?.runningCount]);
  const stats = [
    { label: '已归档影片', value: dashboard?.movieCount, unit: '部', icon: Film, color: 'purple', note: '本地保存的电影与剧集' },
    { label: '播放资源', value: dashboard?.resourceCount, unit: '条', icon: Layers3, color: 'blue', note: `${dashboard?.healthyResources ?? 0} 条已通过检测` },
    { label: '采集源', value: dashboard?.sourceCount, unit: '个', icon: Globe2, color: 'green', note: `${dashboard?.enabledSourceCount ?? 0} 个源已启用` },
    { label: '平均下载速度', value: dashboard?.averageSpeedMbps != null ? dashboard.averageSpeedMbps.toFixed(1) : '—', unit: 'Mbps', icon: Wifi, color: 'orange', note: '基于已完成的视频分片抽测' },
  ];
  const filtered = !!(search || type || year || sourceId);
  return <>
    <section className="library-intro"><div><div className="eyebrow"><span /> PRIVATE FILM COLLECTION</div><h1>每一部好片，<span>都有归处。</span></h1><p>汇集电影与剧集，让你的私人片库持续生长。</p></div><button className="button primary" onClick={onSource}><Plus size={17} />添加采集源</button></section>
    <section className="stats-grid" aria-label="资料库统计">{stats.map(item => <div className="stat-card" key={item.label}><div className="stat-top"><span>{item.label}</span><span className={`stat-icon ${item.color}`}><item.icon size={17} /></span></div><div className="stat-value">{item.value ?? '—'}<small>{item.unit}</small></div><div className="stat-note">{item.note}</div></div>)}</section>
    <section className="catalogue"><div className="section-heading"><div><h2>我的影视库 <span>{list?.total ?? 0}</span></h2><p>你收藏的故事，都在这里。</p></div><span className="archive-label"><span className="status-dot online" />持续归档</span></div>
      <div className="filter-bar"><div className="search-field"><Search size={18} /><input aria-label="搜索影片名称、导演或演员" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索片名、导演、演员…" />{search && <IconButton label="清除搜索" onClick={() => setSearch('')}><X size={15} /></IconButton>}</div><div className="filter-select"><select aria-label="影片类型" value={type} onChange={e => { setType(e.target.value); setPage(1); }}><option value="">全部类型</option>{list?.types.map(item => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></div><div className="filter-select"><select aria-label="影片年份" value={year} onChange={e => { setYear(e.target.value); setPage(1); }}><option value="">全部年份</option>{list?.years.map(item => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></div><div className="filter-select source-filter"><select aria-label="采集源筛选" value={sourceId} onChange={e => { setSourceId(e.target.value); setPage(1); }}><option value="">全部来源</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><ChevronDown size={13} /></div></div>
      {error ? <div className="inline-error" role="alert"><CircleAlert size={18} />{error}</div> : loading && !list ? <div className="loading-state"><Spinner />正在读取影视库…</div> : !list?.items.length ? <div className="library-empty"><div className="empty-art" aria-hidden="true"><div className="empty-poster p-left"><Film size={31} /></div><div className="empty-poster p-center"><Clapperboard size={40} /><span>CLOUDMEDIA</span></div><div className="empty-poster p-right"><Play size={29} /></div><span className="art-spark spark-one" /><span className="art-spark spark-two" /></div><h3>{filtered ? '暂时没有符合条件的影片' : '你的私人影院，从一个源开始'}</h3><p>{filtered ? '试试其他片名，或调整类型、年份与来源筛选。' : '添加采集源并运行一次采集，影片资料与播放资源就会出现在这里。'}</p>{filtered ? <button className="button secondary" onClick={() => { setSearch(''); setType(''); setYear(''); setSourceId(''); setPage(1); }}>清除筛选</button> : <button className="button secondary" onClick={onNavigateSources}>管理采集源 <ArrowRight size={16} /></button>}<div className="empty-hint"><ShieldCheck size={13} />影片资料保存在本地，源站变更后仍可查看</div></div> : <><div className={`movie-grid ${loading ? 'refreshing' : ''}`}>{list.items.map(movie => <button className="movie-card" key={movie.id} onClick={() => onMovie(movie.id)}><div className="poster">{localPosterPath(movie.poster) ? <img src={localPosterPath(movie.poster)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} /> : null}<div className="poster-fallback"><Film size={35} /><span>{movie.title}</span></div><span className="poster-type">{movie.type || '影片'}</span>{hasRating(movie.rating) && <span className="rating">★ {movie.rating}</span>}<div className="poster-hover"><span><Play size={22} fill="currentColor" /></span></div></div><div className="movie-card-title">{movie.title}</div><div className="movie-card-meta"><span>{[movie.year, movie.region].filter(Boolean).join(' · ') || '资料待完善'}</span><span>{movie.resourceCount} 资源</span></div></button>)}</div>{list.total > list.limit && <div className="pagination"><span>共 {list.total} 部影片</span><div><IconButton label="上一页" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /></IconButton><span>{page} / {Math.ceil(list.total / list.limit)}</span><IconButton label="下一页" disabled={page * list.limit >= list.total} onClick={() => setPage(value => value + 1)}><ChevronRight size={17} /></IconButton></div></div>}</>}
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
    {!sources.length ? <div className="panel empty-small"><Globe2 size={36} /><h3>连接你的第一个内容源</h3><p>设置站点入口和 CSS 选择器，然后手动采集验证结果。</p><button className="button secondary" onClick={() => onEdit('new')}><Plus size={16} />添加采集源</button></div> : <div className="source-grid">{sources.map(source => <article className="source-card" key={source.id}><div className="source-card-head"><span className="source-icon"><Globe2 size={22} /></span><div><h3>{source.name}</h3><span className={`badge ${source.enabled ? 'success' : 'muted'}`}>{source.enabled ? '已启用' : '已暂停'}</span></div><div className="source-toggle"><Toggle checked={source.enabled} label={`${source.name}启用状态`} onChange={() => void mutate(source, 'toggle')} /></div></div><a className="source-url" href={source.baseUrl} target="_blank" rel="noreferrer">{source.baseUrl}<ExternalLink size={12} /></a><div className="source-details"><div><span>解析方式</span><strong>HTML / CSS 选择器</strong></div><div><span>请求间隔</span><strong>{source.requestIntervalMs / 1000} 秒</strong></div><div><span>并发数</span><strong>{source.concurrency ?? 1}</strong></div><div><span>默认采集范围</span><strong>{collectionMode(source) === 'today' ? '今天' : collectionMode(source) === 'range' ? `${source.startDate || '待设置'} 至 ${source.endDate || '待设置'}` : '全部'}</strong></div><div><span>最近采集</span><strong>{date(source.lastRunAt)}</strong></div></div>{source.lastError && <div className="source-error"><CircleAlert size={13} /><span>{source.lastError}</span></div>}<div className="source-actions"><button className="button secondary" disabled={busy === source.id} onClick={() => void onRun(source)}>{busy === source.id ? <Spinner /> : <Play size={14} />}立即采集</button><button className="text-button" onClick={() => onEdit(source)}><Pencil size={14} />编辑</button><IconButton label={`删除${source.name}`} disabled={busy === source.id} onClick={() => void mutate(source, 'delete')}><Trash2 size={15} /></IconButton></div></article>)}</div>}
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
  const [timezone, setTimezone] = useState<string | null>(null);
  const [mode, setMode] = useState<CollectionMode>(() => collectionMode(source));
  const [startDate, setStartDate] = useState(source.startDate || '');
  const [endDate, setEndDate] = useState(source.endDate || '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const todayIn = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    return ['year', 'month', 'day'].map(name => parts.find(part => part.type === name)!.value).join('-');
  };
  useEffect(() => {
    let active = true;
    api<Settings>('/settings').then(settings => {
      if (active) { const today = todayIn(settings.timezone); setTimezone(settings.timezone); setStartDate(value => value || today); setEndDate(value => value || today); }
    }).catch(e => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const close = () => { if (!busy) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!timezone || busy) return;
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
      <p className="form-intro">本次可临时调整采集范围，源的默认设置保持不变。采集结果自动保存到资料库。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading ? <div className="loading-state"><Spinner />正在读取采集时区…</div> : timezone && <>
        <div className="collection-date-heading"><span><Clock3 size={14} />{timezone}</span></div>
        <CollectionScope mode={mode} onModeChange={value => { setMode(value); setError(''); }} startDate={startDate} endDate={endDate} onStartDate={setStartDate} onEndDate={setEndDate} disabled={busy} />
        <div className="subtle-note"><Database size={14} /><span>重复采集会更新已有记录，长任务可在“任务记录”查看进度或取消。</span></div>
      </>}
    </div>
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={loading || !timezone || busy}>{busy ? <Spinner /> : <Play size={15} />}开始采集</button></div>
  </form></Modal>;
}

function SourceModal({ source, onClose, onSaved }: { source: Source | 'new'; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<Source>>(() => source === 'new' ? {
    name: '', baseUrl: '', adapter: 'html', enabled: true, collectionMode: 'all', updatesSortedDescending: false,
    listPath: '/', detailLinkSelector: 'a[href*="/voddetail/"]', titleSelector: 'h1', posterSelector: '.module-item-pic img, .vodlist_thumb img',
    descriptionSelector: '.module-info-introduction, .vod_content', resourceSelector: 'a[href*="/vodplay/"], a[href$=".m3u8"], a[href*=".m3u8?"], a[href*=".m3u8#"]',
    nextPageSelector: 'a[title="下一页"]', requestIntervalMs: 2500, concurrency: 1,
  } : { ...source, collectionMode: collectionMode(source), concurrency: source.concurrency ?? 1 });
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const update = <K extends keyof Source>(key: K, value: Source[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const mode = collectionMode(form);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'range' && !validDateRange(form.startDate || '', form.endDate || '')) { setError('请选择有效的日期区间，开始日期不能晚于结束日期。'); return; }
    const concurrency = form.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) { setError('并发数必须为 1 至 20 的整数。'); return; }
    setSaving(true); setError('');
    try {
      const input = { ...form, adapter: 'html', concurrency, collectionMode: mode, startDate: mode === 'range' ? form.startDate : undefined, endDate: mode === 'range' ? form.endDate : undefined, referer: '' };
      await api(source === 'new' ? '/sources' : `/sources/${source.id}`, { method: source === 'new' ? 'POST' : 'PUT', body: JSON.stringify(input) });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <Modal title={source === 'new' ? '添加采集源' : `编辑 · ${source.name}`} onClose={onClose}><form onSubmit={submit}>
    <div className="modal-body">
      <p className="form-intro">设置网站入口、CSS 选择器和默认采集范围。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-grid">
        <Field label="源名称"><input value={form.name} required maxLength={100} placeholder="例如：我的影视源" onChange={e => update('name', e.target.value)} /></Field>
        <div className="field"><span>解析方式</span><div className="parser-label">HTML / CSS 选择器</div></div>
        <p className="parser-description">通过 CSS 选择器读取公开 HTML 页面的影片资料和播放链接。</p>
        <Field label="网站入口" hint="域名变更后修改这里，已入库资料继续保留。" full><input type="url" value={form.baseUrl} placeholder="https://example.com" required onChange={e => update('baseUrl', e.target.value)} /></Field>
        <Field label="列表路径" hint="相对于网站入口的路径，例如 / 或 /vodshow/1.html。" full><input value={form.listPath} onChange={e => update('listPath', e.target.value)} required /></Field>
        <div className="field full"><CollectionScope mode={mode} onModeChange={value => { update('collectionMode', value); setError(''); }} startDate={form.startDate || ''} endDate={form.endDate || ''} onStartDate={value => update('startDate', value)} onEndDate={value => update('endDate', value)} disabled={saving} /></div>
        {mode !== 'all' && <div className="field full"><div className="collection-sort-setting"><div><strong>列表按更新时间倒序</strong><small>仅当列表保证从新到旧排列时启用；遇到早于开始日期的影片后停止翻页。</small></div><Toggle label="列表按更新时间倒序" checked={form.updatesSortedDescending ?? false} onChange={value => update('updatesSortedDescending', value)} /></div></div>}
        <Field label="详情链接选择器" full><input value={form.detailLinkSelector} onChange={e => update('detailLinkSelector', e.target.value)} required /></Field>
        <Field label="标题选择器"><input value={form.titleSelector} onChange={e => update('titleSelector', e.target.value)} required /></Field>
        <Field label="海报选择器"><input value={form.posterSelector} onChange={e => update('posterSelector', e.target.value)} /></Field>
        <Field label="简介选择器" full><input value={form.descriptionSelector} onChange={e => update('descriptionSelector', e.target.value)} /></Field>
        <Field label="播放链接选择器" full hint="支持直接 m3u8 链接及公开播放页中的播放器地址。"><input value={form.resourceSelector} onChange={e => update('resourceSelector', e.target.value)} /></Field>
        <Field label="下一页选择器" full><input value={form.nextPageSelector} onChange={e => update('nextPageSelector', e.target.value)} /></Field>
        <Field label="请求间隔（秒）" hint="0 表示不额外等待；最多 60 秒，支持三位小数。"><input type="number" min={0} max={60} step={0.001} value={(form.requestIntervalMs ?? 2500) / 1000} onChange={e => update('requestIntervalMs', Math.round(Number(e.target.value) * 1000))} required /></Field>
        <Field label="并发数" hint="同时获取详情、播放地址和检测分辨率的任务数；1 为串行。"><input type="number" min={1} max={20} step={1} value={form.concurrency ?? 1} onChange={e => update('concurrency', Number(e.target.value))} required /></Field>
      </div>
    </div>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? <Spinner /> : <Check size={16} />}保存采集源</button></div>
  </form></Modal>;
}

function Runs({ revision }: { revision: number }) {
  const [runs, setRuns] = useState<Run[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [expanded, setExpanded] = useState<string | null>(null); const [canceling, setCanceling] = useState<string[]>([]);
  useEffect(() => { let active = true; const load = async () => { try { const result = await api<Run[]>('/runs'); if (active) { setRuns(result); setError(''); } } catch (e) { if (active) setError((e as Error).message); } finally { if (active) setLoading(false); } }; void load(); const timer = setInterval(load, 4000); return () => { active = false; clearInterval(timer); }; }, [revision]);
  const cancelRun = async (id: string) => {
    if (canceling.includes(id)) return;
    setCanceling(previous => [...previous, id]); setError('');
    try {
      const updated = await api<Run>(`/runs/${id}/cancel`, { method: 'POST' });
      setRuns(previous => previous.map(run => run.id === updated.id ? updated : run));
    } catch (e) { setError((e as Error).message); }
    finally { setCanceling(previous => previous.filter(item => item !== id)); }
  };
  return <><div className="page-heading"><div><div className="eyebrow">COLLECTION ACTIVITY</div><h1>任务记录</h1><p>每一次发现、更新与异常，都有迹可循。</p></div><span className="badge"><RefreshCw size={12} />每 4 秒更新</span></div>{error && <div className="inline-error" role="alert">{error}</div>}<div className="panel runs-panel">{loading ? <div className="loading-state"><Spinner />读取任务记录…</div> : !runs.length ? <div className="empty-small"><Activity size={37} /><h3>还没有采集任务</h3><p>在采集源页面运行一次采集，或等待下次定时任务。</p></div> : <div className="table-scroll"><table className="runs-table"><thead><tr><th>采集源 / 时间</th><th>状态</th><th>扫描</th><th>新增 / 更新</th><th>播放资源</th><th>详情</th></tr></thead><tbody>{runs.map(run => <RunRow key={run.id} run={run} canceling={canceling.includes(run.id)} onCancel={() => void cancelRun(run.id)} expanded={expanded === run.id} onExpand={() => setExpanded(value => value === run.id ? null : run.id)} />)}</tbody></table></div>}</div></>;
}
function RunRow({ run, expanded, onExpand, canceling, onCancel }: { run: Run; expanded: boolean; onExpand: () => void; canceling: boolean; onCancel: () => void }) {
  return <><tr><td><strong>{run.sourceName}</strong><small>{date(run.startedAt)}</small>{run.dateRange && <small className="run-date-range">更新日期：{run.dateRange.startDate}{run.dateRange.endDate !== run.dateRange.startDate ? ' 至 ' + run.dateRange.endDate : ''}<br />{run.dateRange.timezone}</small>}{(run.status === 'running' || run.status === 'queued') && <small style={{ display: 'block', maxWidth: 320, marginTop: 8, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.7 }}>{run.message || '等待采集'}</small>}</td><td><span className={`badge ${run.status === 'success' ? 'success' : run.status === 'error' ? 'danger' : run.status === 'running' ? 'working' : 'muted'}`}>{run.status === 'running' && <Spinner />}{statusNames[run.status]}</span></td><td>{run.scanned}</td><td><span className="text-green">+{run.added}</span><span className="text-muted"> / {run.updated}</span></td><td>{run.resourceCount}</td><td><div style={{ display: 'flex', alignItems: 'center', gap: 14, whiteSpace: 'nowrap' }}><button className="text-button" onClick={onExpand} aria-expanded={expanded}>{expanded ? '收起' : '查看'}<ChevronDown size={13} /></button>{(run.status === 'queued' || run.status === 'running') && <button className="text-button" onClick={onCancel} disabled={canceling} title="停止任务，保留已保存的采集结果">{canceling ? <Spinner /> : <X size={13} />}{canceling ? '取消中' : '取消'}</button>}</div></td></tr>{expanded && <tr className="run-details"><td colSpan={6}><div><strong>运行信息</strong><p>{run.message || '任务已创建，等待执行。'}</p><span>完成时间：{run.finishedAt ? date(run.finishedAt) : '进行中'}</span>{run.errors.length > 0 && <div className="run-error-list">{run.errors.map((message, index) => <p key={index}><CircleAlert size={13} />{message}</p>)}</div>}</div></td></tr>}</>;
}

type PosterArchiveSummary = { total: number; saved: number; pending: number; error: number; missing: number; running: boolean };

function PosterArchiveSettings({ storage }: { storage: Dashboard['storage'] | undefined }) {
  const [summary, setSummary] = useState<PosterArchiveSummary | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; let timer: number | undefined;
    const load = async () => {
      try {
        const result = await api<PosterArchiveSummary>('/archive/posters');
        if (!active) return;
        setSummary(result); setError('');
        if (result.running || result.pending > 0) timer = window.setTimeout(() => { void load(); }, 5000);
      } catch (e) { if (active) setError((e as Error).message); }
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [revision]);
  const retry = async () => {
    setBusy(true); setError('');
    try { setSummary(await api<PosterArchiveSummary>('/archive/posters/retry', { method: 'POST' })); setRevision(value => value + 1); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-section poster-archive-settings">
    <div className="settings-section-heading"><span className="section-icon green"><ArrowDownToLine size={20} /></span><div><h2>图片永久归档</h2><p>{storage === 'postgres' ? '影片资料与资源检测结果保存在 PostgreSQL，图片以实际文件保存在 data/posters。' : '影片资料与资源检测结果保存在本地 JSON 文件，图片以实际文件保存在 data/posters。'}</p></div></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {summary ? <dl className="poster-archive-counts" aria-label="图片归档统计">{[
      ['影片总数', summary.total], ['已保存', summary.saved], ['待保存', summary.pending], ['失败', summary.error], ['无图片', summary.missing],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : !error && <p className="poster-archive-loading"><Spinner />读取图片归档状态…</p>}
    <div className="poster-archive-actions"><span role="status">{summary?.running ? <><Spinner />正在保存图片，每 5 秒更新进度</> : '补存历史图片，失败后可再次重试。'}</span><button type="button" className="button secondary" disabled={busy || summary?.running} onClick={() => void retry()}>{busy ? <Spinner /> : <ArrowDownToLine size={15} />}补存 / 重试图片</button></div>
    <div className="subtle-note"><Database size={14} /><span>备份时请同时保存{storage === 'postgres' ? ' PostgreSQL 数据库' : '本地 JSON 数据文件'}和 data/posters 图片目录。浏览资料使用已归档图片；视频在点击播放后连接视频源。</span></div>
  </section>;
}

function SettingsPage({ dashboard, onSaved }: { dashboard: Dashboard | null; onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; api<Settings>('/settings').then(result => { if (active) setSettings(result); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => previous ? ({ ...previous, [key]: value }) : previous);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }); setSettings(result); onSaved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <><div className="page-heading"><div><div className="eyebrow">SYSTEM PREFERENCES</div><h1>系统设置</h1><p>安排采集节奏，配置符合实际需求的资源检测。</p></div></div>{error && <div className="inline-error" role="alert">{error}</div>}{!settings ? <div className="loading-state"><Spinner />读取配置…</div> : <form onSubmit={submit} className="settings-form"><section className="panel settings-section"><div className="settings-section-heading"><span className="section-icon"><Clock3 size={20} /></span><div><h2>每日采集</h2><p>在指定时区的固定时间，依次更新所有已启用的源。</p></div></div><div className="setting-toggle-row"><div><strong>启用定时任务</strong><small>下次运行：{dashboard?.schedulerNextAt ? date(dashboard.schedulerNextAt) : '未安排'}</small></div><Toggle checked={settings.schedulerEnabled} label="启用定时任务" onChange={value => update('schedulerEnabled', value)} /></div><div className="form-grid"><Field label="每日运行时间"><input type="time" value={settings.dailyTime} onChange={e => update('dailyTime', e.target.value)} required /></Field><Field label="时区"><input value={settings.timezone} onChange={e => update('timezone', e.target.value)} placeholder="Asia/Shanghai" required /></Field></div></section>
      <section className="panel settings-section"><div className="settings-section-heading"><span className="section-icon blue"><Wifi size={20} /></span><div><h2>m3u8 资源检测</h2><p>从采集服务器抽样下载视频分片，记录分辨率和真实下载速度。</p></div></div><div className="setting-toggle-row"><div><strong>采集后自动检测</strong><small>保存播放地址后，自动检测新增或变更的资源。</small></div><Toggle checked={settings.probeEnabled} label="采集后自动检测" onChange={value => update('probeEnabled', value)} /></div><div className="form-grid"><Field label="抽测分片数量" hint="默认 1 个；增加数量可减少单次波动。"><input type="number" min={1} max={10} value={settings.sampleSegments} onChange={e => update('sampleSegments', +e.target.value)} required /></Field><Field label="每个分片最多下载字节" hint="262144 字节 = 256 KiB，控制探测流量。"><input type="number" min={16384} max={4194304} step={1024} value={settings.sampleBytes} onChange={e => update('sampleBytes', +e.target.value)} required /></Field><Field label="单次请求超时（毫秒）"><input type="number" min={1000} max={60000} step={1000} value={settings.probeTimeoutMs} onChange={e => update('probeTimeoutMs', +e.target.value)} required /></Field><Field label="多清晰度优先选择"><select value={settings.preferredQuality} onChange={e => update('preferredQuality', e.target.value as Settings['preferredQuality'])}><option value="highest">最高画质</option><option value="lowest">最低画质</option></select></Field></div><div className="subtle-note"><CircleAlert size={14} />检测结果反映采集服务器到播放源的连接情况；分辨率无法可靠识别时显示为未知。</div></section>
      <section className="panel settings-section"><div className="settings-section-heading"><span className="section-icon green"><ShieldCheck size={20} /></span><div><h2>采集请求</h2><p>通过请求间隔、有限重试与退避，控制对源站的访问频率。</p></div></div><div className="form-grid"><Field label="播放地址缓存时长（小时）" hint="默认 168 小时（7 天）。未过期的播放页复用已采集地址；缓存过期或上次检测失败时重新读取。"><input type="number" min={1} max={720} value={settings.resourceRefreshHours ?? 168} onChange={e => update('resourceRefreshHours', +e.target.value)} required /></Field><Field label="失败最大重试次数"><input type="number" min={0} max={4} value={settings.maxRetries} onChange={e => update('maxRetries', +e.target.value)} required /></Field><Field label="User-Agent" hint="建议保留明确的采集器标识。" full><input value={settings.userAgent} onChange={e => update('userAgent', e.target.value)} required maxLength={300} /></Field></div></section><PosterArchiveSettings storage={dashboard?.storage} /><div className="settings-save"><span><Database size={14} />{dashboard?.storage === 'postgres' ? '设置保存在 PostgreSQL' : '设置保存在本地数据文件'}</span><button className="button primary" disabled={busy}>{busy ? <Spinner /> : <Check size={16} />}保存设置</button></div></form>}</>;
}

function Player({ resource }: { resource: Resource }) {
  const video = useRef<HTMLVideoElement>(null); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0); const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!started) return;
    const element = video.current; if (!element) return;
    setError(''); const token = localStorage.getItem(tokenKey); const url = `/api/play/${encodeURIComponent(resource.id)}/index.m3u8${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    let hls: Hls | null = null; let active = true;
    void import('hls.js').then(({ default: HlsPlayer }) => {
      if (!active) return;
      if (HlsPlayer.isSupported()) { hls = new HlsPlayer({ maxBufferLength: 30 }); hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => { if (active) void element.play().catch(() => {}); }); hls.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) { setError(`播放失败：${data.type === 'networkError' ? '无法读取远端播放资源，请检测地址是否仍然有效。' : '当前资源无法解码或格式不受支持。'}`); hls?.destroy(); } }); hls.loadSource(url); hls.attachMedia(element); }
      else if (element.canPlayType('application/vnd.apple.mpegurl')) { element.src = url; void element.play().catch(() => {}); }
      else setError('当前浏览器不支持 HLS 播放，请使用较新的 Chrome、Edge 或 Safari。');
    }).catch(() => { if (active) setError('播放器组件加载失败，请刷新页面重试。'); });
    return () => { active = false; hls?.destroy(); element.pause(); element.removeAttribute('src'); element.load(); };
  }, [resource.id, resource.url, attempt, started]);
  return <div className="player"><video ref={video} controls={started} playsInline preload="none" onError={() => setError('播放器无法读取此资源，请重新检测或更换线路。')} />{!started && <div className="player-start"><button type="button" className="button primary" onClick={() => setStarted(true)}><Play size={19} />播放视频</button><p>点击后连接视频源，开始在线播放。</p></div>}{error && <div className="player-error"><CircleAlert size={25} /><p>{error}</p><button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />重新加载</button></div>}</div>;
}
function MovieModal({ id, sources, onClose, onChange }: { id: string; sources: Source[]; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<{ movie: Movie; resources: Resource[] } | null>(null); const [error, setError] = useState(''); const [selected, setSelected] = useState<string>(''); const [probing, setProbing] = useState(false); const [refreshing, setRefreshing] = useState(false); const [playbackRevision, setPlaybackRevision] = useState(0); const [message, setMessage] = useState('');
  useEffect(() => { let active = true; api<{ movie: Movie; resources: Resource[] }>(`/movies/${id}`).then(result => { if (active) { setData(result); setSelected(result.resources[0]?.id ?? ''); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [id]);
  const resource = data?.resources.find(item => item.id === selected);
  const probe = async () => { if (!resource) return; setProbing(true); setMessage(''); setError(''); try { const result = await api<Resource>(`/resources/${resource.id}/probe`, { method: 'POST' }); setData(previous => previous ? { ...previous, resources: previous.resources.map(item => item.id === result.id ? result : item) } : previous); setMessage(result.probe.status === 'error' ? '检测完成：资源暂不可用' : '检测完成'); onChange(); } catch (e) { setError((e as Error).message); } finally { setProbing(false); } };
  const refreshResource = async () => {
    if (!resource?.pageUrl) return;
    setRefreshing(true); setMessage(''); setError('');
    try {
      const result = await api<Resource>(`/resources/${resource.id}/refresh`, { method: 'POST' });
      setData(previous => previous ? { ...previous, resources: previous.resources.map(item => item.id === result.id ? result : item) } : previous);
      setPlaybackRevision(value => value + 1);
      setMessage(result.probe.status === 'error' ? '已重新解析播放地址，资源检测暂未通过。' : result.probe.status === 'ok' ? '播放地址已重新解析并检测，播放器已重新加载。' : '播放地址已重新解析，播放器已重新加载。');
      onChange();
    } catch (e) { setError((e as Error).message); }
    finally { setRefreshing(false); }
  };
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => { setPosterFailed(false); }, [id, data?.movie.poster]);
  const movie = data?.movie;
  const archivedPoster = localPosterPath(movie?.poster || ''); const posterAvailable = !!archivedPoster && !posterFailed;
  const posterArchive = movie?.posterArchive;
  const posterStatus = posterFailed || posterArchive?.status === 'saved' ? '本地图片文件不可用' : posterArchive?.status === 'error' ? '图片归档失败' : posterArchive?.status === 'missing' || (!movie?.poster && !posterArchive) ? '暂无图片' : '图片待归档';
  return <Modal title={movie?.title ?? '影片详情'} onClose={onClose} wide>{error && <div className="inline-error" role="alert">{error}</div>}{!movie ? <div className="loading-state"><Spinner />读取影片资料…</div> : <div className="movie-detail"><div className="movie-detail-top"><div className="detail-poster-archive"><div className="detail-poster">{posterAvailable ? <img src={archivedPoster} alt={`${movie.title}海报`} referrerPolicy="no-referrer" onError={() => setPosterFailed(true)} /> : <Film size={40} />}</div>{!posterAvailable && <div className="poster-archive-status" role="status"><span>{posterStatus}</span>{posterArchive?.error && <small>{posterArchive.error}</small>}</div>}</div><div><div className="movie-detail-tags">{movieTags(movie).map((tag, index) => <span key={`${tag}-${index}`} className="badge">{tag}</span>)}{hasRating(movie.rating) && <span className="rating-text">★ {movie.rating}</span>}</div>{movie.originalTitle && <p className="original-title">{movie.originalTitle}</p>}{movie.director && <p className="credit"><span>导演</span>{displayCredits(movie.director)}</p>}{!!movie.actors.length && <p className="credit"><span>主演</span>{movie.actors.join(' / ')}</p>}{movie.status && <p className="credit"><span>状态</span>{movie.status}</p>}<p className="movie-description">{movie.description || '暂无剧情简介。'}</p><small className="text-muted">归档时间 {date(movie.createdAt)}</small></div></div>
    <div className="resource-section"><div className="section-heading"><div><h2><ListVideo size={19} />播放资源 <span>{data.resources.length}</span></h2></div>{resource && <div className="resource-controls">{resource.pageUrl && sources.some(source => source.id === resource.sourceId) && <button className="button secondary small" title="重新请求原播放页，获取新的播放地址并检测" onClick={() => void refreshResource()} disabled={probing || refreshing}>{refreshing ? <Spinner /> : <ArrowDownToLine size={14} />}重新解析地址</button>}<button className="button secondary small" title="对当前保存的播放地址进行检测" onClick={() => void probe()} disabled={probing || refreshing}>{probing ? <Spinner /> : <RefreshCw size={14} />}检测当前资源</button></div>}</div>{!data.resources.length ? <div className="resource-empty"><Radio size={26} /><p>已保存影片资料，暂未发现可播放的 m3u8 地址。</p></div> : <><div className="resource-options">{data.resources.map(item => <button key={item.id} className={`resource-option ${selected === item.id ? 'selected' : ''}`} onClick={() => { setSelected(item.id); setMessage(''); }}><Play size={13} /><span>{item.episode || item.name || '正片'}</span><small>{item.name !== item.episode ? item.name : sources.find(source => source.id === item.sourceId)?.name || '资源'}</small><i className={`status-dot ${item.probe.status === 'ok' ? 'online' : item.probe.status === 'error' ? 'failed' : ''}`} /></button>)}</div>{resource && <><Player key={`${resource.id}:${resource.url}:${playbackRevision}`} resource={resource} /><div className="probe-grid"><div><span>分辨率</span><strong>{resource.probe.width && resource.probe.height ? `${resource.probe.width} × ${resource.probe.height}` : '未知'}</strong></div><div><span>实测下载速度</span><strong>{resource.probe.speedMbps != null ? `${resource.probe.speedMbps.toFixed(2)} Mbps` : '未检测'}</strong></div><div><span>抽样数据</span><strong>{resource.probe.bytesRead ? `${(resource.probe.bytesRead / 1024).toFixed(0)} KiB / ${resource.probe.sampledSegments} 片` : '—'}</strong></div><div><span>检测时间</span><strong>{resource.probe.checkedAt ? date(resource.probe.checkedAt) : '尚未检测'}</strong></div></div>{resource.probe.error && <div className="source-error"><CircleAlert size={14} />{resource.probe.error}</div>}{message && <p className="resource-message" role="status">{message}</p>}<details className="resource-address"><summary>查看已归档的资源地址</summary><code>{resource.url}</code></details></>}</>}</div></div>}</Modal>;
}
