import { useEffect, useId, useState } from 'react';
import { Activity, Check, CheckCheck, ChevronDown, CircleAlert, Clock3, Film, Globe2, Layers3, LoaderCircle, Search, Trash2, Wifi, X } from 'lucide-react';
import type { Run } from '../../shared/types';
import { BEIJING_TIMEZONE } from '../../shared/schedule-settings';
import { discoveredProgress, errorCategory, formatRunDuration, hasRunIssues, isRunActive, runFailureCount } from './run-display';
import './RunCards.css';

const number = (value: number) => value.toLocaleString('zh-CN');
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: BEIJING_TIMEZONE, hour12: false });
const statusNames: Record<Run['status'], string> = { queued: '等待执行', running: '正在采集', success: '采集完成', error: '任务失败', interrupted: '已中断' };
type Filter = 'all' | 'active' | 'issues' | 'ended';
type Props = {
  runs: Run[]; expanded: string | null; canceling: string[]; deleting: string[];
  clock: { epoch: number; receivedAt: number } | null;
  onExpand: (id: string) => void; onCancel: (id: string) => void; onDelete: (id: string) => void;
};

export function RunCards(props: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [tick, setTick] = useState(performance.now());
  useEffect(() => { const timer = window.setInterval(() => setTick(performance.now()), 1000); return () => window.clearInterval(timer); }, []);
  const now = props.clock ? props.clock.epoch + Math.max(0, tick - props.clock.receivedAt) : NaN;
  const active = props.runs.filter(isRunActive).length;
  const issues = props.runs.filter(hasRunIssues).length;
  const completed = props.runs.filter(run => run.status === 'success').length;
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: '全部记录', count: props.runs.length }, { key: 'active', label: '进行中', count: active },
    { key: 'issues', label: '有异常', count: issues }, { key: 'ended', label: '已结束', count: props.runs.length - active },
  ];
  const visible = props.runs.filter(run => filter === 'active' ? isRunActive(run) : filter === 'issues' ? hasRunIssues(run) : filter === 'ended' ? !isRunActive(run) : true);
  return <div className="activity-workspace">
    <div className="activity-overview" aria-label="任务概况">
      <div><span className="overview-icon purple"><Activity size={18} /></span><div><span>进行中</span><strong>{active}<small>个任务</small></strong></div></div>
      <div><span className="overview-icon green"><CheckCheck size={18} /></span><div><span>已完成</span><strong>{completed}<small>个任务</small></strong></div></div>
      <div><span className="overview-icon amber"><CircleAlert size={18} /></span><div><span>有异常</span><strong>{issues}<small>个任务</small></strong></div></div>
    </div>
    <div className="activity-toolbar"><div className="activity-filters" role="group" aria-label="筛选任务">{filters.map(item => <button key={item.key} type="button" className={filter === item.key ? 'selected' : ''} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}</div><span>按创建时间倒序 · 北京时间</span></div>
    <div className="activity-list">{visible.length ? visible.map(run => <RunCard key={run.id} run={run} now={now} expanded={props.expanded === run.id} canceling={props.canceling.includes(run.id)} deleting={props.deleting.includes(run.id)} onExpand={() => props.onExpand(run.id)} onCancel={() => props.onCancel(run.id)} onDelete={() => props.onDelete(run.id)} />) : <div className="panel empty-small"><Activity size={30} /><h3>没有符合条件的任务</h3><button className="button secondary small" onClick={() => setFilter('all')}>查看全部记录</button></div>}</div>
    <p className="activity-retention"><Layers3 size={13} />删除已结束的任务记录后，影片、播放资源和海报仍保留在数据库。</p>
  </div>;
}

type CardProps = { run: Run; now: number; expanded: boolean; canceling: boolean; deleting: boolean; onExpand: () => void; onCancel: () => void; onDelete: () => void };
export function RunCard({ run, now, expanded, canceling, deleting, onExpand, onCancel, onDelete }: CardProps) {
  const detailId = useId();
  const active = isRunActive(run);
  const progress = run.progress;
  const failures = runFailureCount(run);
  const percent = discoveredProgress(run);
  const issues = hasRunIssues(run);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const categories = [...new Set(run.errors.map(errorCategory))];
  const samples = run.errors.filter(message => (category === '全部' || errorCategory(message) === category) && message.toLowerCase().includes(search.toLowerCase()));
  const statusClass = run.status === 'error' ? 'error' : run.status === 'success' ? 'success' : active ? 'active' : 'muted';
  const activity = progress ? active ? progress.activeMovies : 0 : null;
  return <article className={`activity-card ${active ? 'is-active' : ''}`} aria-label={`${run.sourceName}，${statusNames[run.status]}`}>
    <header className="activity-card-head"><div className="activity-source-icon"><Globe2 size={21} /></div><div className="activity-title"><div><h2>{run.sourceName}</h2><span className={`activity-status ${statusClass}`}>{run.status === 'running' ? <LoaderCircle size={13} className="spin" /> : run.status === 'success' ? <Check size={13} /> : run.status === 'error' ? <CircleAlert size={13} /> : <Clock3 size={13} />}{statusNames[run.status]}{run.status === 'success' && issues ? ' · 有异常' : ''}</span></div><p><span>{date(run.startedAt)}</span><span className="activity-separator">·</span><span>{run.status === 'queued' ? '已等待' : active ? '已运行' : '耗时'} {formatRunDuration(run, now)}</span></p></div><span className="activity-scope">{run.dateRange ? run.dateRange.startDate === run.dateRange.endDate ? `更新日期 ${run.dateRange.startDate}` : `${run.dateRange.startDate} 至 ${run.dateRange.endDate}` : '全部日期'}</span></header>
    <div className="activity-metrics">
      <div className="activity-metric"><span><Film size={14} />影片处理</span><strong>{progress ? number(progress.completedMovies) : number(run.scanned)}<small>{progress ? ` / ${number(progress.discoveredMovies)} 部` : ' 部已入库'}</small></strong><p>新增 <b>{number(run.added)}</b> · 更新 <b>{number(run.updated)}</b></p></div>
      <div className="activity-metric"><span><Activity size={14} />{active ? '当前影片并发' : '影片并发'}</span><strong>{activity === null ? '—' : activity}<small>{progress ? ` / ${progress.concurrency} 个槽位` : ' 暂无详细数据'}</small></strong>{progress ? <div className="activity-slots" aria-label={`${activity} 个使用中，上限 ${progress.concurrency}`}>{Array.from({ length: progress.concurrency }, (_, i) => <i key={i} className={i < (activity ?? 0) ? 'used' : ''} />)}</div> : <p>此记录未记录实时并发</p>}</div>
      <div className="activity-metric"><span><Layers3 size={14} />播放资源</span><strong>{number(run.resourceCount)}<small>条已入库</small></strong><p>{progress ? <>检测中 <b>{active ? progress.probes.active : 0}</b> · 待检测 <b>{active ? number(progress.probes.queued) : 0}</b></> : '检测明细未记录'}</p></div>
      <div className={`activity-metric ${issues ? 'has-issues' : ''}`}><span><CircleAlert size={14} />异常情况</span><strong>{failures === null ? (run.errors.length ? `${run.errors.length}` : '—') : number(failures)}<small>{failures === null ? run.errors.length ? '条异常样本' : ' 未记录计数' : '次异常'}</small></strong><p>{progress ? `检测失败 ${number(progress.failures.probe)} · 采集异常 ${number(progress.failures.collection)}` : run.errors.length ? '展开详情查看原因' : '此记录没有异常样本'}</p></div>
    </div>
    <div className="activity-progress"><div><span>{progress ? '已发现影片的处理进度' : '运行状态'}</span><span>{progress ? <>{number(progress.completedMovies)} / {number(progress.discoveredMovies)} 部{active && !progress.paginationComplete ? ' · 仍在发现影片' : ''}</> : '历史记录未采集详细进度'}</span></div><div className={`activity-progress-track ${active && percent === null ? 'is-discovering' : ''}`} role="progressbar" aria-label="已发现影片的处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={progress ? `已完成 ${progress.completedMovies} 部，已发现 ${progress.discoveredMovies} 部。${progress.paginationComplete ? '分页已结束' : active ? '仍可能发现更多影片' : '分页已停止'}` : '无详细进度数据'}><i style={{ width: percent !== null ? `${percent}%` : '0%' }} /></div></div>
    <footer className="activity-card-footer"><p><span className={`status-dot ${active ? 'online' : ''}`} />{run.message || (run.status === 'queued' ? '等待前序任务完成' : '暂无运行消息')}</p><div className="activity-actions"><button type="button" className="activity-detail-toggle" aria-expanded={expanded} aria-controls={detailId} onClick={onExpand}>{expanded ? '收起详情' : '任务详情'}<ChevronDown size={15} className={expanded ? 'rotated' : ''} /></button>{active ? <button type="button" className="activity-secondary-action" onClick={onCancel} disabled={canceling} title="停止任务，保留已保存的采集结果">{canceling ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}{canceling ? '取消中…' : '取消任务'}</button> : <button type="button" className="activity-secondary-action" onClick={onDelete} disabled={deleting} aria-label={`删除${run.sourceName}的任务记录`}>{deleting ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}{deleting ? '删除中…' : '删除记录'}</button>}</div></footer>
    {expanded && <div id={detailId} className="activity-expanded">
      <div className="activity-detail-grid"><section><h3><Activity size={15} />影片流水线</h3><dl className="activity-facts"><div><dt>列表分页</dt><dd>{progress ? `第 ${Math.max(1, progress.currentPage)} 页${progress.paginationComplete ? ' · 已结束' : active ? ' · 持续发现' : ' · 已停止'}` : '未记录'}</dd></div><div><dt>发现 / 完成</dt><dd>{progress ? `${progress.discoveredMovies} / ${progress.completedMovies} 部` : '未记录'}</dd></div><div><dt>结束时间</dt><dd>{run.finishedAt ? date(run.finishedAt) : '尚未结束'}</dd></div></dl><p className="activity-detail-hint">每个影片槽涵盖资料、资源解析与检测，释放后自动补位。</p>{active && progress && <div className="activity-movie-titles"><span>正在处理的影片</span>{progress.activeMovieTitles.length ? <div>{progress.activeMovieTitles.map((title, index) => <span key={`${title}-${index}`}>{title}</span>)}</div> : <p>{progress.activeMovies > 0 ? '正在读取影片详情…' : '当前没有活动影片槽'}</p>}</div>}</section>
      <section><h3><Wifi size={15} />资源检测</h3>{progress ? <><div className="activity-probe-stats"><div><span>待检测</span><strong>{active ? number(progress.probes.queued) : 0}</strong></div><div><span>检测中</span><strong>{active ? progress.probes.active : 0}</strong></div><div className="passed"><span>已通过</span><strong>{number(progress.probes.passed)}</strong></div><div className="failed"><span>未通过</span><strong>{number(progress.probes.failed)}</strong></div></div><p className="activity-detail-hint">仅统计本次实际执行的检测；复用已有检测结果不重复计数。</p></> : <div className="activity-legacy-note">该任务未记录检测明细。新任务会显示实时检测队列和结果。</div>}</section></div>
      <section className="activity-failures"><div className="activity-failure-heading"><div><h3><CircleAlert size={15} />异常与失败</h3><p>{failures !== null ? `累计 ${number(failures)} 次异常 · 保留 ${run.errors.length} 条样本。同一影片可能发生多次异常。` : `保留 ${run.errors.length} 条异常样本，历史记录没有完整失败计数。`}</p></div>{progress && <div className="activity-failure-counts"><span>采集 <b>{progress.failures.collection}</b></span><span>检测 <b>{progress.failures.probe}</b></span><span>海报 <b>{progress.failures.poster}</b></span><span>任务 <b>{progress.failures.runtime}</b></span></div>}</div>
      {run.errors.length ? <><div className="activity-error-tools"><div className="activity-error-filters" role="group" aria-label="筛选异常样本">{['全部', ...categories].map(item => <button key={item} type="button" aria-pressed={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div><label className="activity-error-search"><Search size={14} /><input aria-label="搜索异常样本" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索影片或错误…" /></label></div><ul className="activity-error-samples" aria-label="异常样本">{samples.map((message, index) => <li key={index}><span>{errorCategory(message)}</span><p>{message}</p></li>)}{!samples.length && <li className="activity-no-errors">没有符合条件的异常样本</li>}</ul></> : <p className="activity-no-errors"><Check size={15} />{failures ? '本次异常未保留文本样本。' : '尚未记录到异常。'}</p>}
      </section><p className="activity-run-id">任务 ID · {run.id}</p>
    </div>}
  </article>;
}
