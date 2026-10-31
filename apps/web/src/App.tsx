import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getToken } from './lib/api';
import { DocEditorPage } from './pages/DocEditorPage';
import { DocListPage } from './pages/DocListPage';
import { LoginPage } from './pages/LoginPage';

// Univer 体积很大，按需加载，避免拖慢文档页和列表页的首屏
const SheetEditorPage = lazy(() =>
  import('./pages/SheetEditorPage').then((module) => ({ default: module.SheetEditorPage })),
);

function RequireAuth({ children }: { children: ReactNode }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DocListPage />
          </RequireAuth>
        }
      />
      <Route
        path="/doc/:id"
        element={
          <RequireAuth>
            <DocEditorPage />
          </RequireAuth>
        }
      />
      <Route
        path="/sheet/:id"
        element={
          <RequireAuth>
            <Suspense fallback={<p className="page muted">表格组件加载中…</p>}>
              <SheetEditorPage />
            </Suspense>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
