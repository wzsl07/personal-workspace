import { SCOPE_LABEL, type Scope } from './scope';

/**
 * 范围选择（多选）。
 *
 * 计数写在每个 chip 上：光看"信息流"三个字不知道里面有没有东西，
 * 标上条数才知道值不值得勾。
 */
export function ScopeChips({
  value,
  onChange,
  counts,
  disabled = {},
}: {
  value: Scope[];
  onChange: (s: Scope[]) => void;
  counts: Partial<Record<Scope, number>>;
  /** 被禁用的范围（比如网页版用不了信息流），disabled 的同时在 UI 上说明原因 */
  disabled?: Partial<Record<Scope, string>>;
}) {
  const all: Scope[] = ['item', 'note', 'attachment', 'feed'];
  const allOn = all.every((s) => value.includes(s));

  function toggle(s: Scope) {
    if (disabled[s]) return;
    onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        className={`chip text-[11px] ${allOn ? 'border-accent text-accent' : 'border-line text-fg-dim'}`}
        onClick={() => onChange(allOn ? [] : all.filter((s) => !disabled[s]))}
      >
        全选
      </button>
      {all.map((s) => {
        const on = value.includes(s);
        const why = disabled[s];
        return (
          <button
            key={s}
            className={`chip text-[11px] ${
              on ? 'border-accent text-accent' : 'border-line text-fg-dim'
            } ${why ? 'opacity-40 cursor-not-allowed' : ''}`}
            onClick={() => toggle(s)}
            title={why ?? `${SCOPE_LABEL[s]} ${counts[s] ?? 0} 条`}
          >
            {SCOPE_LABEL[s]}
            <span className="ml-1 text-[10px] opacity-70">{counts[s] ?? 0}</span>
            {why ? <span className="ml-1">（不可用）</span> : null}
          </button>
        );
      })}
    </div>
  );
}
