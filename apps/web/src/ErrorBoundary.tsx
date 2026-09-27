import { Component, type ReactNode } from 'react';

interface State {
  error?: Error;
}

/** 顶层错误边界(上线全检 #22):捕获渲染期异常,替代白屏 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[ledgerone] 渲染异常:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, textAlign: 'center', fontFamily: 'sans-serif', color: '#1a1c23' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>😵</div>
          <h2 style={{ marginBottom: 8 }}>页面出了点问题</h2>
          <p style={{ color: '#8a919f', fontSize: 13, marginBottom: 20 }}>
            {this.state.error.message.slice(0, 200)}
          </p>
          <button
            onClick={() => location.reload()}
            style={{ background: '#4361ee', color: '#fff', border: 'none', borderRadius: 12, padding: '12px 28px', fontSize: 14, cursor: 'pointer' }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
