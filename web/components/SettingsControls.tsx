import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Clock3, Minus, Plus } from 'lucide-react';
import './SettingsControls.css';

type ScheduleTimePickerProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

type SegmentCountControlProps = {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
};

const twoDigits = (value: number) => String(value).padStart(2, '0');

function TimePartPicker({ value, count, label, unit, onChange, disabled = false }: {
  value: number; count: number; label: string; unit: string; onChange: (value: number) => void; disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(value);
  const [placement, setPlacement] = useState({ up: false, maxHeight: 245 });
  const columns = count === 24 ? 4 : 6;

  useEffect(() => {
    if (!open) return;
    options.current[focused]?.focus();
  }, [open, focused]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const select = (next: number) => { onChange(next); close(); };
  const openOptions = () => {
    const bounds = trigger.current?.getBoundingClientRect();
    if (bounds) {
      const below = window.innerHeight - bounds.bottom - 16;
      const above = bounds.top - 16;
      const up = below < 310 && above > below;
      setPlacement({ up, maxHeight: Math.max(64, Math.min(245, (up ? above : below) - 55)) });
    }
    setFocused(value); setOpen(true);
  };
  const optionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = Math.min(count - 1, index + 1);
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    if (event.key === 'ArrowDown') next = Math.min(count - 1, index + columns);
    if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = count - 1;
    if (next !== undefined) { event.preventDefault(); setFocused(next); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  };

  return <div className={`cm-time-part ${count === 60 ? 'cm-time-part-minute' : ''} ${placement.up ? 'opens-up' : ''}`} ref={root}
    onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className={`cm-time-part-trigger ${open ? 'is-open' : ''}`} ref={trigger}
      disabled={disabled} aria-label={`${label}，当前 ${twoDigits(value)}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? setOpen(false) : openOptions()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openOptions(); }
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <span className="cm-time-digits">{twoDigits(value)}</span><span className="cm-time-unit">{unit}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <div className="cm-time-popover">
      <div className="cm-time-popover-heading"><span>选择{label}</span><span>{count === 24 ? '00–23' : '00–59'}</span></div>
      <div className={`cm-time-grid ${count === 60 ? 'cm-time-grid-minutes' : ''}`} role="listbox" id={id} aria-label={label} style={{ maxHeight: placement.maxHeight }}>
        {Array.from({ length: count }, (_, index) => <button key={index} type="button" role="option" aria-selected={index === value}
          className={index === value ? 'is-selected' : ''} tabIndex={index === focused ? 0 : -1}
          ref={element => { options.current[index] = element; }} onFocus={() => setFocused(index)}
          onClick={() => select(index)} onKeyDown={event => optionKeyDown(event, index)}>{twoDigits(index)}</button>)}
      </div>
    </div>}
  </div>;
}

/** Controlled HH:mm input with exact minute selection and no native time widget. */
export function ScheduleTimePicker({ value, onChange, disabled = false }: ScheduleTimePickerProps) {
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const [hour, minute] = valid ? value.split(':').map(Number) : [9, 0];
  return <div className="cm-schedule-time-picker" role="group" aria-label="新增运行时间，北京时间">
    <div className={`cm-time-picker-shell ${disabled ? 'is-disabled' : ''}`}>
      <Clock3 className="cm-time-picker-icon" size={16} aria-hidden="true" />
      <TimePartPicker value={hour} count={24} label="小时" unit="时" disabled={disabled} onChange={next => onChange(`${twoDigits(next)}:${twoDigits(minute)}`)} />
      <span className="cm-time-colon" aria-hidden="true">:</span>
      <TimePartPicker value={minute} count={60} label="分钟" unit="分" disabled={disabled} onChange={next => onChange(`${twoDigits(hour)}:${twoDigits(next)}`)} />
    </div>
  </div>;
}

/** Controlled 1–10 segment stepper, including keyboard and common sampling budgets. */
export function SegmentCountControl({ value, onChange, disabled = false }: SegmentCountControlProps) {
  const hintId = useId();
  const change = (next: number) => { if (!disabled) onChange(Math.min(10, Math.max(1, next))); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | undefined;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = value - 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = value + 1;
    if (event.key === 'Home') next = 1;
    if (event.key === 'End') next = 10;
    if (next !== undefined) { event.preventDefault(); change(next); }
  };
  return <div className="cm-segment-count-control" role="group" aria-label="抽测分片数量" aria-describedby={hintId}>
    <div className="cm-segment-control-row">
      <div className={`cm-segment-stepper ${disabled ? 'is-disabled' : ''}`}>
        <button type="button" aria-label="减少抽测分片" disabled={disabled || value <= 1} onClick={() => change(value - 1)}><Minus size={14} aria-hidden="true" /></button>
        <div className="cm-segment-value" role="spinbutton" aria-label="抽测分片数量" aria-valuemin={1} aria-valuemax={10} aria-valuenow={value} aria-valuetext={`${value} 个分片`}
          aria-disabled={disabled} aria-describedby={hintId} tabIndex={disabled ? -1 : 0} onKeyDown={keyDown}><strong>{value}</strong><span>片</span></div>
        <button type="button" aria-label="增加抽测分片" disabled={disabled || value >= 10} onClick={() => change(value + 1)}><Plus size={14} aria-hidden="true" /></button>
      </div>
      <div className="cm-segment-presets" role="group" aria-label="分片数量快捷选择">
        {([1, 3, 5] as const).map(count => <button key={count} type="button" aria-pressed={value === count} disabled={disabled}
          onClick={() => change(count)}>{count}<span>片</span></button>)}
      </div>
    </div>
    <p className="cm-segment-hint" id={hintId}>1 片更省流量，3–5 片可减少波动。数量越多，检测耗时和流量越高。</p>
  </div>;
}
