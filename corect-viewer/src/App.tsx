import { useEffect } from 'react';
import { SliceView } from './components/SliceView';
import { SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import { useStore } from './state/store';

export default function App() {
  const status = useStore((s) => s.status);
  const compareMode = useStore((s) => s.compareMode);
  const loadLastProject = useStore((s) => s.loadLastProject);

  // 启动时恢复上次打开的工程 / 双体积对比会话（体数据 + 标注 + 映射）
  useEffect(() => {
    void loadLastProject();
  }, [loadLastProject]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>岩芯 CT 体数据浏览器</h1>
        <span className="muted">纯浏览器运行 · 数据不出本机</span>
      </header>
      <div className="app-body">
        <main className={`views${compareMode ? ' compare' : ''}`}>
          {status === 'ready' ? (
            compareMode ? (
              <>
                <div className="view-column">
                  <SliceView axis={2} side="A" />
                  <SliceView axis={0} side="A" />
                  <SliceView axis={1} side="A" />
                </div>
                <div className="view-column">
                  <SliceView axis={2} side="B" />
                  <SliceView axis={0} side="B" />
                  <SliceView axis={1} side="B" />
                </div>
              </>
            ) : (
              <>
                <SliceView axis={2} side="A" />
                <SliceView axis={0} side="A" />
                <SliceView axis={1} side="A" />
              </>
            )
          ) : (
            <div className="empty-state">
              {status === 'loading' ? '正在解码体数据…' : '请在右侧加载样例或导入 .corevol 文件'}
            </div>
          )}
        </main>
        <SidePanel />
      </div>
      <StatusBar />
    </div>
  );
}
