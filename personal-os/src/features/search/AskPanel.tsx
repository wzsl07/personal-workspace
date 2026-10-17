import { useState } from 'react';
import { ask, describeQuery, type AskResult } from '../../core/adapters/ai/ask';
import { fmtDateTime } from '../../core/domain/time';
import { useUI } from '../../app/store';
import { Empty } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

/**
 * 自然语言问答面板。
 * 回答里带 [1] [2] 引用编号，点引用跳到原条目 / 原笔记。
 */
export function AskPanel() {
  const openEdit = useUI((s) => s.openEdit);
  const openNote = useUI((s) => s.openNote);
  const setView = useUI((s) => s.setView);
  const toast = useUI((s) => s.toast);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);

  async function run() {
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    try {
      setResult(await ask(text));
    } catch (e) {
      toast(`问答失败：${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-3">
        <input
          className="field flex-1"
          placeholder="例如：我这周还有什么作业没交？上个月班级事务里关于班费的内容在哪？"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
        />
        <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !q.trim()}>
          {busy ? '查询中…' : '提问'}
        </button>
      </div>

      {!result ? (
        <Empty
          text="用中文问一句，答案会带上引用来源"
          hint="查询在本地执行，只有命中的那几段才会发给模型总结（设置里可完全关闭）"
        />
      ) : (
        <div className="space-y-3">
          <div className="card p-3">
            <div className="text-sm leading-7 whitespace-pre-wrap">{result.answer}</div>
            <div className="flex items-center gap-2 mt-2 text-[11px] text-fg-dim flex-wrap">
              <span>条件：{describeQuery(result.query)}</span>
              <span>·</span>
              <span>{result.provider}</span>
              {result.usedCloud && <span className="text-[#f0a13c]">· 片段已送模型总结</span>}
              {!result.usedCloud && <span className="text-[#3fb984]">· 纯本地，未出网</span>}
            </div>
            {result.notes.map((n) => (
              <div key={n} className="text-[11px] text-fg-dim mt-0.5">
                {n}
              </div>
            ))}
          </div>

          <div>
            <div className="sec-title mb-2">引用来源 {result.hits.length}</div>
            <div className="card divide-y divide-line">
              {result.hits.map((h, i) => (
                <button
                  key={`${h.kind}:${h.id}`}
                  className="w-full text-left px-3 py-2 hover:bg-bg-hover"
                  onClick={() => {
                    if (h.kind === 'item') openEdit(h.id);
                    else if (h.kind === 'note') openNote(h.id);
                    else setView('attachments');
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="chip border-accent text-accent text-[10px]">[{i + 1}]</span>
                    <span className="chip border-line text-[10px]">{h.typeLabel}</span>
                    <span className="text-sm truncate">{h.title}</span>
                  </div>
                  {h.snippet && (
                    <div className="text-[11px] text-fg-dim mt-0.5 line-clamp-2 break-words">
                      {h.snippet}
                    </div>
                  )}
                  {h.when && (
                    <div className="text-[10px] text-fg-dim mt-0.5">{fmtDateTime(h.when)}</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-fg-dim flex items-center gap-1">
            <Icon name="Search" size={11} />
            点任意一条引用即可跳到原始笔记或日程
          </div>
        </div>
      )}
    </div>
  );
}
