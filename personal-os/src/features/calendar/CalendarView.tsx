import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { ITEM_TYPES, ITEM_TYPE_LIST, anchorTime, isOverdue } from '../../core/domain/item';
import { fmtTime, monthGrid, weekRange } from '../../core/domain/time';
import * as itemRepo from '../../core/repo/itemRepo';
import { getMeta, setMeta } from '../../core/repo/db';
import type { ItemType, ScheduleItem } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';
import { Segmented } from '../../ui/primitives';
import { DayDetail } from './DayDetail';

type Mode = 'month' | 'week' | 'day';
const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

export function CalendarView() {
  const revision = useUI((s) => s.revision);
  const cursorIso = useUI((s) => s.cursor);
  const setCursor = useUI((s) => s.setCursor);
  const openNew = useUI((s) => s.openNew);
  const openEdit = useUI((s) => s.openEdit);

  const [mode, setMode] = useState<Mode>('month');
  const [hidden, setHidden] = useState<Set<ItemType>>(new Set());
  /** 每格显示条数（0 = 全部）；超出部分点「+N」在当日详情里看 */
  const [perDay, setPerDay] = useState(5);
  /** 紧凑模式：只显示色点+时间+短标题，一格能塞更多 */
  const [compact, setCompact] = useState(false);
  /** 当日详情抽屉 */
  const [detail, setDetail] = useState<Date | null>(null);

  /** 悬浮球迷你日历点某天 → 跳过来并展开当天 */
  const focusIso = useUI((s) => s.calendarFocus);
  const clearFocus = useUI((s) => s.clearCalendarFocus);

  useEffect(() => {
    void getMeta<number>('calendar:perDay', 5).then(setPerDay);
    void getMeta<boolean>('calendar:compact', false).then(setCompact);
  }, []);

  useEffect(() => {
    if (!focusIso) return;
    const d = new Date(focusIso);
    setCursor(d.toISOString());
    setDetail(d);
    clearFocus();
  }, [focusIso, setCursor, clearFocus]);

  async function changePerDay(n: number) {
    setPerDay(n);
    await setMeta('calendar:perDay', n);
  }

  async function toggleCompact() {
    const next = !compact;
    setCompact(next);
    await setMeta('calendar:compact', next);
  }

  const cursor = useMemo(() => new Date(cursorIso), [cursorIso]);

  // 拉取范围：月视图要覆盖网格（含前后补齐的日期），周/日按各自区间
  const range = useMemo(() => {
    if (mode === 'month') {
      const g = monthGrid(cursor);
      const from = new Date(g[0]);
      from.setHours(0, 0, 0, 0);
      const to = new Date(g[g.length - 1]);
      to.setHours(23, 59, 59, 999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    if (mode === 'week') return weekRange(cursor);
    const from = new Date(cursor);
    from.setHours(0, 0, 0, 0);
    const to = new Date(cursor);
    to.setHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [mode, cursor]);

  const items = useLiveQuery(
    () => itemRepo.listItems({ query: { from: range.from, to: range.to } }),
    [range.from, range.to, revision],
  );

  const visible = useMemo(
    () => (items ?? []).filter((i) => !hidden.has(i.type)),
    [items, hidden],
  );

  /** 按"当天 00:00"分组 */
  const byDay = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const it of visible) {
      const t = anchorTime(it);
      if (!t) continue;
      const d = new Date(t);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const arr = m.get(key) ?? [];
      arr.push(it);
      m.set(key, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => {
      const ta = anchorTime(a) ?? '';
      const tb = anchorTime(b) ?? '';
      return ta.localeCompare(tb);
    });
    return m;
  }, [visible]);

  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const noDateCount = useMemo(() => visible.filter((i) => !anchorTime(i)).length, [visible]);

  function shift(n: number) {
    const d = new Date(cursor);
    if (mode === 'month') d.setMonth(d.getMonth() + n);
    else if (mode === 'week') d.setDate(d.getDate() + n * 7);
    else d.setDate(d.getDate() + n);
    setCursor(d.toISOString());
  }

  function toggleType(t: ItemType) {
    setHidden((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  const grid = mode === 'month' ? monthGrid(cursor) : [];
  const weekDays = useMemo(() => {
    if (mode !== 'week') return [];
    const start = new Date(weekRange(cursor).from);
    return Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 86400000));
  }, [mode, cursor]);

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line shrink-0 flex-wrap">
        <button className="btn btn-ghost px-1.5" onClick={() => shift(-1)} aria-label="上一页">
          <Icon name="ChevronLeft" size={16} />
        </button>
        <button className="btn btn-ghost px-1.5" onClick={() => shift(1)} aria-label="下一页">
          <Icon name="ChevronRight" size={16} />
        </button>
        <button
          className="btn text-xs"
          onClick={() => setCursor(new Date().toISOString())}
        >
          今天
        </button>
        <div className="text-sm font-medium min-w-[110px]">
          {mode === 'month'
            ? `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`
            : mode === 'week'
              ? `${cursor.getMonth() + 1}月${cursor.getDate()}日 当周`
              : `${cursor.getMonth() + 1}月${cursor.getDate()}日 ${WEEK_HEAD[(cursor.getDay() + 6) % 7]}`}
        </div>
        <div className="flex-1" />
        <Segmented
          value={mode}
          onChange={(m) => setMode(m)}
          options={[
            { value: 'month', label: '月' },
            { value: 'week', label: '周' },
            { value: 'day', label: '日' },
          ]}
        />
        <button className="btn btn-primary" onClick={() => openNew({ startAt: defaultStart(cursor) })}>
          <Icon name="Plus" size={14} /> 新建
        </button>
      </div>

      {/* 类型筛选：一眼看全 or 只看某类 */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line shrink-0 flex-wrap">
        <span className="text-[11px] text-fg-dim mr-1">显示类型</span>
        {ITEM_TYPE_LIST.map((t) => {
          const m = ITEM_TYPES[t];
          const on = !hidden.has(t);
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              className="chip transition-opacity"
              style={{
                borderColor: on ? m.color : '#2a3145',
                color: on ? m.color : '#4d566e',
                background: on ? `${m.color}1a` : 'transparent',
                opacity: on ? 1 : 0.55,
              }}
            >
              <Icon name={m.icon} size={11} color={on ? m.color : '#4d566e'} />
              {m.label}
            </button>
          );
        })}
        {hidden.size > 0 && (
          <button className="text-[11px] text-fg-dim hover:text-fg ml-1" onClick={() => setHidden(new Set())}>
            全部显示
          </button>
        )}
        {mode === 'month' && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[11px] text-fg-dim">每格显示</span>
            <select
              className="field w-auto py-0.5 text-[11px]"
              value={String(perDay)}
              onChange={(e) => void changePerDay(Number(e.target.value))}
            >
              <option value="3">3 条</option>
              <option value="5">5 条</option>
              <option value="8">8 条</option>
              <option value="0">全部</option>
            </select>
            <button
              className={`chip ${compact ? 'border-accent text-accent' : 'border-line text-fg-muted'}`}
              onClick={() => void toggleCompact()}
              title="紧凑模式：一行更小，一格能显示更多"
            >
              紧凑
            </button>
          </div>
        )}
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-auto">
        {mode === 'month' && (
          <div className="min-h-full">
            <div className="grid grid-cols-7 border-b border-line sticky top-0 bg-bg-base z-10">
              {WEEK_HEAD.map((w) => (
                <div key={w} className="text-center text-[11px] text-fg-dim py-1.5">
                  周{w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 grid-rows-6" style={{ minHeight: 'calc(100vh - 180px)' }}>
              {grid.map((d) => {
                const key = dayKey(d);
                const list = byDay.get(key) ?? [];
                const inMonth = d.getMonth() === cursor.getMonth();
                const isToday = dayKey(d) === dayKey(new Date());
                const limit = perDay === 0 ? list.length : perDay;
                const shown = list.slice(0, limit);
                const rest = list.length - shown.length;
                return (
                  <div
                    key={key}
                    className={`border-b border-r border-line p-1 min-h-[112px] cursor-pointer hover:bg-bg-panel/60 flex flex-col ${
                      inMonth ? '' : 'opacity-40'
                    }`}
                    onClick={() => {
                      const nd = new Date(d);
                      nd.setHours(9, 0, 0, 0);
                      openNew({ startAt: nd.toISOString() });
                    }}
                  >
                    <div className="flex items-center justify-between px-0.5">
                      <button
                        className={`text-[11px] w-5 h-5 flex items-center justify-center rounded-full hover:bg-bg-hover ${
                          isToday ? 'bg-accent text-white' : 'text-fg-dim'
                        }`}
                        title="查看这一天全部安排"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(d);
                        }}
                      >
                        {d.getDate()}
                      </button>
                      {list.length > 0 && (
                        <span className="text-[10px] text-fg-dim">{list.length} 项</span>
                      )}
                    </div>
                    <div
                      className="mt-0.5 space-y-0.5 overflow-y-auto flex-1"
                      style={{
                        maxHeight: perDay === 0 ? undefined : limit * (compact ? 17 : 22),
                      }}
                    >
                      {shown.map((it) => (
                        <div
                          key={it.id}
                          className={`flex items-center gap-1 px-1 rounded truncate ${
                            compact ? 'py-0 text-[10px] leading-4' : 'py-0.5 text-[11px]'
                          }`}
                          style={{
                            background: `${ITEM_TYPES[it.type].color}22`,
                            color: it.status === 'done' ? '#6b7590' : '#e6e9f0',
                            textDecoration: it.status === 'done' ? 'line-through' : undefined,
                          }}
                          title={`${ITEM_TYPES[it.type].label} · ${it.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(it.id);
                          }}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: ITEM_TYPES[it.type].color }}
                          />
                          {!it.allDay && <span className="text-fg-dim">{fmtTime(anchorTime(it))}</span>}
                          <span className="truncate">{it.title}</span>
                        </div>
                      ))}
                    </div>
                    {rest > 0 && (
                      <button
                        className="mt-0.5 w-full text-left px-1 py-0.5 rounded text-[10px] text-accent hover:bg-accent/15"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(d);
                        }}
                      >
                        +{rest} 条，查看全部
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {mode === 'week' && (
          <div className="grid grid-cols-7 gap-px bg-line min-h-full">
            {weekDays.map((d) => {
              const list = byDay.get(dayKey(d)) ?? [];
              const isToday = dayKey(d) === dayKey(new Date());
              return (
                <div key={dayKey(d)} className="bg-bg-base p-1.5 min-h-[240px]">
                  <div
                    className={`text-[11px] mb-1.5 ${isToday ? 'text-accent font-medium' : 'text-fg-dim'}`}
                  >
                    {d.getMonth() + 1}/{d.getDate()} 周{WEEK_HEAD[(d.getDay() + 6) % 7]}
                  </div>
                  <div className="space-y-1">
                    {list.map((it) => (
                      <WeekCard key={it.id} item={it} onOpen={() => openEdit(it.id)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {mode === 'day' && (
          <div className="p-4">
            <div className="card divide-y divide-line">
              {(byDay.get(dayKey(cursor)) ?? []).length === 0 ? (
                <div className="p-6 text-center text-sm text-fg-dim">这一天没有安排</div>
              ) : (
                (byDay.get(dayKey(cursor)) ?? []).map((it) => (
                  <div
                    key={it.id}
                    className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-bg-hover"
                    onClick={() => openEdit(it.id)}
                  >
                    <div className="w-12 text-xs text-fg-dim">{fmtTime(anchorTime(it))}</div>
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: ITEM_TYPES[it.type].color }}
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-sm truncate"
                        style={
                          it.status === 'done'
                            ? { textDecoration: 'line-through', color: '#6b7590' }
                            : undefined
                        }
                      >
                        {it.title}
                      </div>
                      <div className="text-[11px] text-fg-dim">
                        {ITEM_TYPES[it.type].label}
                        {it.location ? ` · ${it.location}` : ''}
                      </div>
                    </div>
                    {isOverdue(it) && <span className="text-[11px] text-[#e5484d]">逾期</span>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {noDateCount > 0 && (
        <div className="px-4 py-1.5 border-t border-line text-[11px] text-fg-dim shrink-0">
          另有 {noDateCount} 条无时间条目未显示在日历（见「今日 · 无期限」）
        </div>
      )}

      {detail && (
        <DayDetail
          date={detail}
          items={byDay.get(dayKey(detail)) ?? []}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function WeekCard({ item, onOpen }: { item: ScheduleItem; onOpen: () => void }) {
  const m = ITEM_TYPES[item.type];
  return (
    <div
      className="px-1.5 py-1 rounded text-[11px] cursor-pointer hover:brightness-125"
      style={{
        background: `${m.color}22`,
        borderLeft: `2px solid ${m.color}`,
        color: item.status === 'done' ? '#6b7590' : '#e6e9f0',
        textDecoration: item.status === 'done' ? 'line-through' : undefined,
      }}
      onClick={onOpen}
    >
      <div className="flex items-center gap-1">
        {!item.allDay && <span className="text-fg-dim">{fmtTime(anchorTime(item))}</span>}
        <span className="truncate">{item.title}</span>
      </div>
    </div>
  );
}

function defaultStart(d: Date): string {
  // 新建时给一个当天 09:00 的默认开始时间，省得手填
  const nd = new Date(d);
  nd.setHours(9, 0, 0, 0);
  return nd.toISOString();
}
