import { useEffect } from 'react';
import { SliceView } from './components/SliceView';
import { SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import { useStore } from './state/store';

export default function App() {
  const status = useStore((s) => s.status);
  const mode = useStore((s) => s.mode);
  const baseName = useStore((s) => s.base.projectName);
  const compareName = useStore((s) => s.compare.projectName);
  const restoreLastSession = useStore((s) => s.restoreLastSession);

  // 启动时恢复上次会话（单体积工程 或 双体积比较会话）
  useEffect(() => {
    void restoreLastSession();
  }, [restoreLastSession]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>岩芯 CT 体数据浏览器</h1>
        <span className="muted">纯浏览器运行 · 数据不出本机</span>
      </header>
      <div className="app-body">
        {mode === 'compare' ? (
          <main className="views-dual">
            <div className="view-column">
              <div className="column-label">基准 · {baseName}</div>
              <SliceView axis={2} side="base" />
              <SliceView axis={0} side="base" />
              <SliceView axis={1} side="base" />
            </div>
            <div className="view-column">
              <div className="column-label">
                对比 · {compareName}
              </div>
              <SliceView axis={2} side="compare" />
              <SliceView axis={0} side="compare" />
              <SliceView axis={1} side="compare" />
            </div>
          </main>
        ) : (
          <main className="views">
            {status === 'ready' ? (
              <>
                <SliceView axis={2} side="base" />
                <SliceView axis={0} side="base" />
                <SliceView axis={1} side="base" />
              </>
            ) : (
              <div className="empty-state">
                {status === 'loading' ? '正在解码体数据…' : '请在右侧加载样例或导入 .corevol 文件'}
              </div>
            )}
          </main>
        )}
        <SidePanel />
      </div>
      <StatusBar />
    </div>
  );
}
