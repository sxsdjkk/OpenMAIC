'use client';

import { Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';

// A single build-time page serves every classroom. Course data stays behind the API.
function ClassroomFromUrl() {
  const params = useSearchParams();
  const pathname = usePathname();
  const id = params.get('id') || /^\/classroom\/([a-zA-Z0-9_-]{1,64})$/.exec(pathname)?.[1];
  return id ? <ClassroomSurface classroomId={id} variant="page" /> : <p>缺少课堂编号</p>;
}

export default function WorkerClassroomPage() {
  return (
    <Suspense fallback={<p>正在加载课堂…</p>}>
      <ClassroomFromUrl />
    </Suspense>
  );
}
