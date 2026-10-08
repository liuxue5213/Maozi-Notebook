import { useEffect, useState } from 'react';

/**
 * O3 统一弹窗:替代 window.confirm/alert/prompt。
 * promise 式 API——调用点 `await confirmDialog({...})` 即可原语义替换,由 App 根部唯一的
 * <DialogHost/> 渲染;主题化、可聚焦、Enter 确认 / Esc 取消,不再阻塞主线程。
 */

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作:确认按钮用危险色(删除/注销等) */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

type Active =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'alert'; opts: ConfirmOptions; resolve: () => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void; inputValue?: string };

let active: Active | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

function open(a: Active): void {
  active = a;
  emit();
}

function settle(): void {
  active = null;
  emit();
}

export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === 'string' ? { message: opts } : opts;
  return new Promise((resolve) => open({ kind: 'confirm', opts: o, resolve }));
}

export function alertDialog(opts: ConfirmOptions | string): Promise<void> {
  const o = typeof opts === 'string' ? { message: opts } : opts;
  return new Promise((resolve) => open({ kind: 'alert', opts: o, resolve }));
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => open({ kind: 'prompt', opts, resolve }));
}

export function DialogHost() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  if (!active) return null;
  const { kind, opts, resolve } = active;
  const isPrompt = kind === 'prompt';
  const danger = kind === 'confirm' && !!opts.danger;
  const titleText = isPrompt ? (opts as PromptOptions).title : (opts as ConfirmOptions).title;
  const bodyText = isPrompt ? (opts as PromptOptions).message : (opts as ConfirmOptions).message;
  const confirmLabel = opts.confirmText ?? (kind === 'alert' ? '知道了' : '确认');
  const cancelLabel = opts.cancelText ?? '取消';

  const done = (value: boolean | string | null) => {
    resolve(value as never);
    settle();
  };

  return (
    <div
      className="modal-mask"
      style={{ zIndex: 200 }}
      onClick={() => { if (kind !== 'alert') done(false); else done(null); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { if (kind !== 'alert') done(false); else done(null); }
        if (e.key === 'Enter' && kind !== 'prompt') { if (kind === 'confirm') done(true); else done(null); }
      }}
      tabIndex={-1}
      ref={(el) => el?.focus()}
    >
      <div className="modal" style={{ minWidth: 300, maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        {titleText && <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{titleText}</div>}
        {bodyText && <div className="muted" style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{bodyText}</div>}
        {isPrompt && (
          <input
            className="note-input"
            style={{ margin: '12px 0 0' }}
            defaultValue={(opts as PromptOptions).defaultValue ?? ''}
            placeholder={(opts as PromptOptions).placeholder ?? ''}
            autoFocus
            maxLength={50}
            onChange={(e) => { (active as Extract<Active, { kind: 'prompt' }>).inputValue = e.target.value; }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = (active as Extract<Active, { kind: 'prompt' }>).inputValue;
                done(v == null ? null : v);
              }
            }}
          />
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          {kind !== 'alert' && (
            <button className="mini" style={{ flex: 1 }} onClick={() => done(false)}>{cancelLabel}</button>
          )}
          <button
            className={danger ? 'danger' : 'primary'}
            style={{ flex: 1 }}
            autoFocus={kind !== 'prompt'}
            onClick={() => {
              if (kind === 'prompt') {
                const v = (active as Extract<Active, { kind: 'prompt' }>).inputValue;
                done(v == null ? ((opts as PromptOptions).defaultValue ?? '') : v);
              } else if (kind === 'confirm') done(true);
              else done(null);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
