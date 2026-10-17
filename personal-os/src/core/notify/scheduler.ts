import { db } from '../repo/db';
import { newId, nowISO } from '../domain/id';
import { getMeta, setMeta } from '../repo/db';
import { notify, notifyPermission, requestNotifyPermission } from '../adapters/desktop';
import type { ItemType, Reminder, ScheduleItem } from '../domain/types';

/**
 * 提醒调度器。
 *
 * 诚实说明：浏览器没有后台常驻能力，所以这是**应用打开时轮询**（默认 30 秒一次）。
 * 关掉页面就不会提醒。真正可靠的定时提醒要等 Tauri 桌面壳
 * （那里用 Rust 侧的定时器，系统常驻）。代码路径已经预留好，届时无需改动。
 */

const ENABLED_KEY = 'notify:enabled';
const LEAD_KEY = 'notify:leadMinutes';
const LAST_KEY = 'notify:lastScan';

let timer: number | null = null;

export { notifyPermission, requestNotifyPermission };

export async function notifyEnabled(): Promise<boolean> {
  return getMeta<boolean>(ENABLED_KEY, true);
}

export async function setNotifyEnabled(v: boolean): Promise<void> {
  await setMeta(ENABLED_KEY, v);
}

export async function defaultLead(): Promise<number> {
  return getMeta<number>(LEAD_KEY, 30);
}

export async function setDefaultLead(minutes: number): Promise<void> {
  await setMeta(LEAD_KEY, minutes);
}

/** 为条目创建/更新提醒（提前 minutes 分钟，默认 30） */
export async function ensureReminder(
  item: ScheduleItem,
  leadMinutes: number,
): Promise<Reminder | null> {
  const base = item.dueAt ?? item.startAt;
  if (!base) return null;
  const trigger = new Date(base).getTime() - leadMinutes * 60000;
  const now = nowISO();

  const existing = (await db.reminders.where('itemId').equals(item.id).toArray()).filter(
    (r) => !r.fired,
  );

  const row: Reminder = {
    id: existing[0]?.id ?? newId(),
    createdAt: existing[0]?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
    rev: (existing[0]?.rev ?? 0) + 1,
    itemId: item.id,
    triggerAt: new Date(trigger).toISOString(),
    offsetMinutes: leadMinutes,
    fired: false,
    channel: 'web',
  };
  await db.reminders.put(row);
  return row;
}

export async function clearReminders(itemId: string): Promise<void> {
  const rows = await db.reminders.where('itemId').equals(itemId).toArray();
  for (const r of rows) {
    await db.reminders.put({ ...r, fired: true, updatedAt: nowISO(), rev: r.rev + 1 });
  }
}

const TYPE_LABEL: Record<ItemType, string> = {
  task: '任务',
  todo: '待办',
  assignment: '作业',
  course: '课程',
  classAffair: '班级事务',
  activity: '活动',
  exam: '考试',
  meeting: '会议',
  custom: '自定义',
};

/** 扫一遍到期提醒并发送；返回本次发出几条 */
export async function scanAndFire(): Promise<number> {
  if (!(await notifyEnabled())) return 0;
  const perm = notifyPermission();
  if (perm !== 'granted') return 0;

  const now = Date.now();
  const rows = (await db.reminders.toArray()).filter((r) => !r.fired && !r.deletedAt);
  let sent = 0;

  for (const r of rows) {
    if (new Date(r.triggerAt).getTime() > now) continue;
    const item = await db.items.get(r.itemId);
    if (!item || item.deletedAt || item.status === 'done' || item.status === 'cancelled') {
      await db.reminders.put({ ...r, fired: true, updatedAt: nowISO(), rev: r.rev + 1 });
      continue;
    }
    const when = item.dueAt ?? item.startAt ?? '';
    const timeStr = when
      ? new Date(when).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    const ok = await notify(
      `${TYPE_LABEL[item.type]}：${item.title}`,
      timeStr ? `时间 ${timeStr}${item.location ? ` · ${item.location}` : ''}` : '到时间了',
    );
    if (!ok) continue;

    // 重复条目：算出下一次触发；否则标记已触发
    if (item.recurrence && (item.dueAt || item.startAt)) {
      const base = new Date(item.dueAt ?? item.startAt!).getTime();
      const step =
        item.recurrence.freq === 'daily'
          ? 86400000
          : item.recurrence.freq === 'weekly'
            ? 7 * 86400000
            : 30 * 86400000;
      const next = base + step * (item.recurrence.interval || 1);
      await db.reminders.put({
        ...r,
        triggerAt: new Date(next - r.offsetMinutes * 60000).toISOString(),
        updatedAt: nowISO(),
        rev: r.rev + 1,
      });
    } else {
      await db.reminders.put({ ...r, fired: true, updatedAt: nowISO(), rev: r.rev + 1 });
    }
    sent += 1;
  }

  await setMeta(LAST_KEY, nowISO());
  return sent;
}

/** 启动轮询（页面打开期间）；返回停止函数 */
export function startScheduler(intervalMs = 30_000): () => void {
  if (timer !== null) return () => undefined;
  void scanAndFire();
  timer = window.setInterval(() => {
    void scanAndFire();
  }, intervalMs);
  return () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export async function lastScan(): Promise<string> {
  return getMeta<string>(LAST_KEY, '');
}

/** 待触发提醒数量（设置页显示） */
export async function pendingCount(): Promise<number> {
  const rows = (await db.reminders.toArray()).filter((r) => !r.fired && !r.deletedAt);
  return rows.length;
}
