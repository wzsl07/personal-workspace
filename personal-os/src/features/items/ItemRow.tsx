import { ITEM_TYPES } from '../../core/domain/item';
import { dueLabel, fmtTime } from '../../core/domain/time';
import * as itemRepo from '../../core/repo/itemRepo';
import { anchorTime, isOverdue } from '../../core/domain/item';
import type { ScheduleItem } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';
import { ItemMetaChips, TypeDot } from './ItemEditor';

export function ItemRow({ item, showDate = true }: { item: ScheduleItem; showDate?: boolean }) {
  const openEdit = useUI((s) => s.openEdit);
  const bump = useUI((s) => s.bump);
  const meta = ITEM_TYPES[item.type];
  const done = item.status === 'done';
  const overdue = isOverdue(item);
  const t = anchorTime(item);

  async function toggle() {
    await itemRepo.setStatus(item.id, done ? 'notStarted' : 'done');
    bump();
  }

  return (
    <div
      className="group flex items-start gap-2.5 px-2.5 py-2 rounded-md hover:bg-bg-hover transition-colors cursor-pointer"
      onClick={() => openEdit(item.id)}
    >
      <button
        className="mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center"
        style={{
          borderColor: done ? '#3fb984' : meta.color,
          background: done ? '#3fb984' : 'transparent',
        }}
        onClick={(e) => {
          e.stopPropagation();
          void toggle();
        }}
        aria-label={done ? '标记未完成' : '标记完成'}
      >
        {done && <Icon name="CheckSquare" size={11} color="#0f1115" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <TypeDot type={item.type} />
          <span
            className={`text-sm truncate ${done ? 'line-through text-fg-dim' : 'text-fg'}`}
            title={item.title}
          >
            {item.title}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-[11px] text-fg-dim">{meta.label}</span>
          {showDate && t && (
            <span
              className="text-[11px]"
              style={{ color: overdue ? '#e5484d' : '#6b7590' }}
            >
              {dueLabel(t)}
              {!item.allDay && ` ${fmtTime(t)}`}
            </span>
          )}
          <ItemMetaChips item={item} />
        </div>
      </div>
    </div>
  );
}
