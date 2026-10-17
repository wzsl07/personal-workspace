import { ITEM_TYPES, anchorTime, isOverdue } from '../../core/domain/item';
import { fmtTime } from '../../core/domain/time';
import * as itemRepo from '../../core/repo/itemRepo';
import type { ScheduleItem } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Drawer } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 当日详情：月视图一格放不下时，从这里看当天全部安排。
 * 支持直接勾选完成、点条目编辑、在这一天新建。
 */
export function DayDetail({
  date,
  items,
  onClose,
}: {
  date: Date;
  items: ScheduleItem[];
  onClose: () => void;
}) {
  const openEdit = useUI((s) => s.openEdit);
  const openNew = useUI((s) => s.openNew);
  const bump = useUI((s) => s.bump);

  const sorted = [...items].sort((a, b) => {
    const ta = anchorTime(a) ?? '';
    const tb = anchorTime(b) ?? '';
    if (ta === tb) return b.priority - a.priority;
    return ta.localeCompare(tb);
  });

  async function toggle(it: ScheduleItem) {
    await itemRepo.setStatus(it.id, it.status === 'done' ? 'notStarted' : 'done');
    bump();
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={420}
      title={
        <span>
          {date.getMonth() + 1}月{date.getDate()}日 周{WEEKDAYS[date.getDay()]}
          <span className="ml-2 text-fg-dim font-normal">共 {items.length} 项</span>
        </span>
      }
    >
      <div className="space-y-2">
        {sorted.length === 0 ? (
          <div className="text-center py-10 text-sm text-fg-dim">这一天没有安排</div>
        ) : (
          sorted.map((it) => {
            const m = ITEM_TYPES[it.type];
            const done = it.status === 'done';
            return (
              <div
                key={it.id}
                className="flex items-start gap-2.5 p-2 rounded-md border border-line hover:bg-bg-hover cursor-pointer"
                onClick={() => openEdit(it.id)}
              >
                <button
                  className="mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center"
                  style={{
                    borderColor: done ? '#3fb984' : m.color,
                    background: done ? '#3fb984' : 'transparent',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggle(it);
                  }}
                  aria-label={done ? '标记未完成' : '标记完成'}
                >
                  {done && <Icon name="CheckSquare" size={11} color="#0f1115" />}
                </button>
                <span
                  className="w-2 h-2 rounded-full shrink-0 mt-1.5"
                  style={{ background: m.color }}
                />
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm truncate ${done ? 'line-through text-fg-dim' : ''}`}
                    title={it.title}
                  >
                    {it.title}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-fg-dim flex-wrap">
                    <span>{m.label}</span>
                    <span style={{ color: isOverdue(it) ? '#e5484d' : undefined }}>
                      {fmtTime(anchorTime(it)) || '全天'}
                    </span>
                    {it.location && <span>{it.location}</span>}
                    {it.priority > 0 && (
                      <span className="text-[#f0a13c]">P{it.priority}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        <button
          className="btn w-full justify-center mt-2"
          onClick={() => {
            const d = new Date(date);
            d.setHours(9, 0, 0, 0);
            openNew({ startAt: d.toISOString() });
            onClose();
          }}
        >
          <Icon name="Plus" size={14} /> 在这一天新建
        </button>
      </div>
    </Drawer>
  );
}
