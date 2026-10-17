/** 临时验证脚本：跑中文时间解析与规则解析器（不进构建产物） */
import { parseChineseTime } from '../src/core/domain/nltime.ts';
import { ruleProvider } from '../src/core/adapters/ai/rule.ts';

const now = new Date('2026-10-09T10:00:00'); // 已知"现在"

const cases = [
  '下周三下午3点开班会',
  '高等数学第三章作业 10月15日23:59 前交到学习委员',
  '明天下午3点半学院会议室开会',
  '月底前把班费收支统计表发给辅导员',
  '本周五晚上7点体育馆破冰活动，务必参加',
  '大学物理期中测验 11/3 上午9点 教学楼B201',
];

for (const c of cases) {
  const hits = parseChineseTime(c, now);
  console.log('\n原文：', c);
  for (const h of hits) {
    console.log(
      `  → ${h.raw} | ${new Date(h.iso).toLocaleString('zh-CN')} | 含具体时间=${h.hasTime} | 语义=${h.hint ?? '未判定'}`,
    );
  }
  const r = await ruleProvider.parse(c, now, {
    provider: 'rule',
    baseURL: '',
    model: '',
    apiKey: '',
    allowCloud: false,
    autoFallback: true,
  });
  for (const it of r.items) {
    console.log(
      `  条目：${it.title} | 类型=${it.type} | 开始=${it.startAt ?? '-'} | 截止=${it.dueAt ?? '-'} | 优先级=${it.priority} | 标签=${it.tags.join(',') || '-'} | 地点=${it.location || '-'}`,
    );
  }
}
