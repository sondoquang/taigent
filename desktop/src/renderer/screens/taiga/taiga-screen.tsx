// Taiga: the user's Taiga projects (Project), the tickets assigned to them (Ticket của tôi) and a project's progress
// report (Báo cáo), read straight from Taiga. The screen holds the last read of the Project list, which the report's
// project choice follows.

import { useState } from 'react';
import type { TaigaProjectsOverview } from '../../../shared/api.ts';
import { PageHeader, ScreenBody } from '@/components/common.tsx';
import { TicketsCard } from './my-tickets.tsx';
import { ProjectsCard } from './taiga-projects.tsx';
import { ReportCard } from './taiga-report.tsx';

export function TaigaScreen() {
  const [listed, setListed] = useState<TaigaProjectsOverview>();
  return (
    <ScreenBody>
      <PageHeader title="Taiga" description="Project trên Taiga, ticket được giao cho bạn và báo cáo tiến độ, đọc trực tiếp từ Taiga." />
      <ProjectsCard onListed={setListed} />
      <TicketsCard />
      <ReportCard overview={listed} />
    </ScreenBody>
  );
}
