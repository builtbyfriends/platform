import { useEffect } from 'react';
import type { ReactNode } from 'react';
import preventDragging from '../lib/preventDragging.ts';
import '../app.css';

export default function Layout({
  children,
  loading = false,
}: {
  children: ReactNode;
  loading?: boolean;
}) {
  useEffect(() => preventDragging(), []);

  return (
    <>
      {loading && <div className="nav-progress loading" />}
      {children}
    </>
  );
}
