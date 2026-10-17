import { getMeta, setMeta } from './db';
import * as itemRepo from './itemRepo';
import * as noteRepo from './noteRepo';
import * as tagRepo from './tagRepo';

const SEED_FLAG = 'seeded:v1';

function at(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** 首次启动时写入示例数据，方便立刻看到各视图效果；可在设置里一键清空。 */
export async function seedIfEmpty(): Promise<boolean> {
  if (await getMeta<boolean>(SEED_FLAG, false)) return false;
  const existing = await itemRepo.listItems({ query: {} });
  if (existing.length > 0) {
    await setMeta(SEED_FLAG, true);
    return false;
  }

  const [tMath, tHomework, tClass] = await Promise.all([
    tagRepo.ensureTag('高等数学'),
    tagRepo.ensureTag('作业'),
    tagRepo.ensureTag('班级'),
  ]);

  await itemRepo.createItem({
    title: '高等数学 第三章习题（P78-80）',
    type: 'assignment',
    dueAt: at(1, 23, 59),
    priority: 3,
    tags: [tMath.id, tHomework.id],
    remark: '交到学习委员处，注意写清题号',
  });

  await itemRepo.createItem({
    title: '高等数学A(1)',
    type: 'course',
    startAt: at(1, 8, 0),
    dueAt: at(1, 9, 40),
    allDay: false,
    location: '教学楼 A301',
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 3] },
    tags: [tMath.id],
  });

  await itemRepo.createItem({
    title: '统计并公示本学期班费收支',
    type: 'classAffair',
    dueAt: at(3, 18, 0),
    priority: 2,
    tags: [tClass.id],
    remark: '找生活委员核对收据，公示前先发班群草稿',
  });

  await itemRepo.createItem({
    title: '班级破冰活动',
    type: 'activity',
    startAt: at(5, 14, 0),
    dueAt: at(5, 16, 30),
    allDay: false,
    location: '体育馆二层',
    tags: [tClass.id],
  });

  await itemRepo.createItem({
    title: '大学物理 期中测验',
    type: 'exam',
    startAt: at(14, 9, 0),
    dueAt: at(14, 11, 0),
    allDay: false,
    priority: 4,
    location: '待通知',
  });

  await itemRepo.createItem({
    title: '整理本周错题',
    type: 'todo',
    priority: 1,
  });

  await noteRepo.createNote({
    title: '高等数学',
    path: '/课程/高等数学.md',
    content:
      '# 高等数学 A(1)\n\n任课教师：待确认\n\n## 重点\n\n- 极限与连续\n- 导数与微分\n\n相关：[[学习计划]]\n',
    tags: [tMath.id],
  });

  await noteRepo.createNote({
    title: '学习计划',
    path: '/计划/学习计划.md',
    content:
      '# 学习计划\n\n每周日晚上复盘一次，把下周的作业与考试写进日程。\n\n参见 [[高等数学]]\n',
  });

  await setMeta(SEED_FLAG, true);
  return true;
}
