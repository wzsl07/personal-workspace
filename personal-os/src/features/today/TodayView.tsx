import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import * as itemRepo from '../../core/repo/itemRepo';
import { ITEM_TYPES } from '../../core/domain/item';
import type { ScheduleItem } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Empty, SectionHeader } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';
import { ItemRow } from '../items/ItemRow';

export function TodayView() {
  const revision = useUI((s) => s.revision);
  const openNew = useUI((s) => s.openNew);
  const [tick, setTick] = useState(0);

  const buckets = useLiveQuery(() => itemRepo.todayBuckets(), [revision, tick]);
  const counts = useLiveQuery(() => itemRepo.countByType(), [revision, tick]);

  const total = buckets
    ? buckets.overdue.length + buckets.today.length + buckets.soon.length + buckets.noDate.length
    : 0;

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">今日</h1>
          <div className="text-xs text-fg-dim mt-0.5">
            {new Date().toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            })}
            {total > 0 && ` · 未完成 ${total} 项`}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => openNew()}>
          <Icon name="Plus" size={14} /> 新建
        </button>
      </div>

      {counts && Object.keys(counts).length > 0 && (
        <div className="card p-3 mb-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-muted">
          {Object.entries(counts).map(([k, v]) => (
            <span key={k}>
              {ITEM_TYPES[k as keyof typeof ITEM_TYPES]?.label ?? k}{' '}
              <b className="text-fg">{v}</b>
            </span>
          ))}
        </div>
      )}

      {!buckets ? (
        <Empty text="加载中…" />
      ) : total === 0 ? (
        <Empty text="今天没有待办" hint="点右上角「新建」，或去收集箱丢一条待整理的内容" />
      ) : (
        <div className="space-y-5">
          {buckets.overdue.length > 0 && (
            <section>
              <SectionHeader title="已逾期" count={buckets.overdue.length} />
              <div className="card divide-y divide-line">
                {buckets.overdue.map((i) => (
                  <ItemRow key={i.id} item={i} />
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionHeader title="今天" count={buckets.today.length} />
            <div className="card divide-y divide-line">
              {buckets.today.length ? (
                buckets.today.map((i) => <ItemRow key={i.id} item={i} />)
              ) : (
                <Empty text="今天没有安排" />
              )}
            </div>
          </section>

          {buckets.soon.length > 0 && (
            <section>
              <SectionHeader title="未来 7 天" count={buckets.soon.length} />
              <div className="card divide-y divide-line">
                {buckets.soon.map((i) => <ItemRow key={i.id} item={i} />)}
              </div>
            </section>
          )}

          {buckets.noDate.length > 0 && (
            <section>
              <SectionHeader
                title="无期限"
                count={buckets.noDate.length}
                action={
                  <button
                    className="text-[11px] text-fg-dim hover:text-fg"
                    onClick={() => setTick((t) => t + 1)}
                  >
                    刷新
                  </button>
                }
              />
              <div className="card divide-y divide-line">
                {buckets.noDate.slice(0, 30).map((i: ScheduleItem) => (
                  <ItemRow key={i.id} item={i} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
