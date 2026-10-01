'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, BookOpen, Clock3, Layers3, Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { listStages, loadStageData, type StageListItem } from '@/lib/utils/stage-storage';
import { loadCursor } from '@/lib/playback/cursor';
import { isWorkerAccountEnabled } from '@/lib/classroom/worker-account';
import { fetchClassroomFromApi } from '@/lib/classroom/load-classroom';

type LearningPosition = { scene: number; total: number } | null;

const copy = {
  zh: {
    back: '返回课程生成',
    eyebrow: '个人学习空间',
    title: '继续你的学习',
    description: '把感兴趣的主题或资料变成互动课堂，随时从上次的位置接着学。',
    courses: '我的课程',
    pages: '课堂页面',
    latest: '最近课程',
    continue: '继续学习',
    create: '创建新课程',
    library: '课程库',
    empty: '还没有课程。输入一个主题或上传资料，创建你的第一堂 AI 课。',
    retry: '课程加载失败，请刷新后重试。',
    loading: '正在加载课程…',
    page: (scene: number, total: number) => `第 ${scene} / ${total} 页`,
    pageCount: (count: number) => `${count} 页`,
  },
  en: {
    back: 'Back to course creation',
    eyebrow: 'Personal learning space',
    title: 'Keep learning',
    description:
      'Turn a topic or your materials into an interactive class, and pick up where you left off.',
    courses: 'My courses',
    pages: 'Classroom pages',
    latest: 'Latest course',
    continue: 'Continue learning',
    create: 'Create a course',
    library: 'Course library',
    empty: 'No courses yet. Enter a topic or upload materials to create your first AI class.',
    retry: 'Could not load your courses. Refresh to try again.',
    loading: 'Loading courses…',
    page: (scene: number, total: number) => `Page ${scene} of ${total}`,
    pageCount: (count: number) => `${count} pages`,
  },
};

export default function LearnPage() {
  const { locale } = useI18n();
  const text = locale.startsWith('zh') ? copy.zh : copy.en;
  const [courses, setCourses] = useState<StageListItem[] | null>(null);
  const [position, setPosition] = useState<LearningPosition>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    listStages()
      .then(async (items) => {
        if (!active) return;
        setCourses(items);
        const latestCourse = items[0];
        if (!latestCourse) return;
        try {
          const [stage, cursor] = await Promise.all([
            isWorkerAccountEnabled()
              ? fetchClassroomFromApi(latestCourse.id).then((result) =>
                  result.outcome === 'found'
                    ? { scenes: result.classroom.scenes, currentSceneId: null }
                    : null,
                )
              : loadStageData(latestCourse.id),
            loadCursor(latestCourse.id).catch(() => null),
          ]);
          if (!active || !stage || !stage.scenes.length) return;
          const sceneId = cursor?.sceneId ?? stage.currentSceneId;
          const index = stage.scenes.findIndex((scene) => scene.id === sceneId);
          setPosition({ scene: Math.max(index, 0) + 1, total: stage.scenes.length });
        } catch {
          // The course list is still usable when the last-page lookup fails.
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const latest = courses?.[0];
  const totalPages = courses?.reduce((sum, course) => sum + course.sceneCount, 0) ?? 0;

  return (
    <main className="min-h-[100dvh] bg-gradient-to-b from-slate-50 to-slate-100 px-5 py-10 text-slate-900 dark:from-slate-950 dark:to-slate-900 dark:text-slate-100 md:px-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white"
        >
          <ArrowLeft className="size-4" /> {text.back}
        </Link>

        <div className="mt-14 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm font-medium text-violet-600 dark:text-violet-400">
              {text.eyebrow}
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">{text.title}</h1>
            <p className="mt-3 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              {text.description}
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700"
          >
            <Plus className="size-4" /> {text.create}
          </Link>
        </div>

        {failed ? (
          <p role="alert" className="mt-12 text-sm text-red-600">
            {text.retry}
          </p>
        ) : courses === null ? (
          <p className="mt-12 text-sm text-slate-500">{text.loading}</p>
        ) : courses.length === 0 ? (
          <div className="mt-12 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-10 text-center dark:border-slate-700 dark:bg-slate-900/60">
            <BookOpen className="mx-auto size-8 text-violet-500" />
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{text.empty}</p>
          </div>
        ) : (
          <>
            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/80">
                <BookOpen className="size-5 text-violet-500" />
                <p className="mt-4 text-3xl font-semibold">{courses.length}</p>
                <p className="mt-1 text-sm text-slate-500">{text.courses}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/80">
                <Layers3 className="size-5 text-blue-500" />
                <p className="mt-4 text-3xl font-semibold">{totalPages}</p>
                <p className="mt-1 text-sm text-slate-500">{text.pages}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/80">
                <Clock3 className="size-5 text-amber-500" />
                <p className="mt-4 truncate text-lg font-semibold">{latest?.name}</p>
                <p className="mt-1 text-sm text-slate-500">{text.latest}</p>
              </div>
            </div>

            {latest && (
              <section className="mt-8 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-700 p-7 text-white">
                <p className="text-xs font-medium text-violet-100">{text.latest}</p>
                <h2 className="mt-2 text-2xl font-semibold">{latest.name}</h2>
                {latest.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-violet-100">{latest.description}</p>
                )}
                {position && (
                  <p className="mt-4 text-sm text-violet-100">
                    {text.page(position.scene, position.total)}
                  </p>
                )}
                <Link
                  href={`/classroom/${encodeURIComponent(latest.id)}`}
                  className="mt-6 inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50"
                >
                  {text.continue} <ArrowRight className="size-4" />
                </Link>
              </section>
            )}

            <section className="mt-12">
              <h2 className="text-xl font-semibold">{text.library}</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {courses.map((course) => (
                  <Link
                    key={course.id}
                    href={`/classroom/${encodeURIComponent(course.id)}`}
                    className="group rounded-xl border border-slate-200 bg-white/80 p-5 hover:border-violet-300 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-violet-700"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-medium">{course.name}</h3>
                        {course.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-slate-500">
                            {course.description}
                          </p>
                        )}
                      </div>
                      <ArrowRight className="size-4 shrink-0 text-slate-400 group-hover:text-violet-600" />
                    </div>
                    <p className="mt-4 text-xs text-slate-500">
                      {text.pageCount(course.sceneCount)}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
