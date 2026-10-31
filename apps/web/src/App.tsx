import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DocEditorPage } from './pages/DocEditorPage';
import { DocListPage } from './pages/DocListPage';

// Univer 体积很大，按需加载，避免拖慢文档页和列表页的首屏
const SheetEditorPage = lazy(() =>
  import('./pages/SheetEditorPage').then((module) => ({ default: module.SheetEditorPage })),
);

export function App() {
  return (
    <Routes>
      <Route path="/" element={<DocListPage />} />
      <Route path="/doc/:id" element={<DocEditorPage />} />
      <Route
        path="/sheet/:id"
        element={
          <Suspense fallback={<p className="page muted">表格组件加载中…</p>}>
            <SheetEditorPage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
