// Taiga: the user's Taiga projects (Project) and the tickets assigned to them (Ticket của tôi), read straight from
// Taiga. A project's progress (by sprint, by epic) is on the Product Owner dashboard.

import { PageHeader, ScreenBody } from '@/components/common.tsx';
import { TicketsCard } from './my-tickets.tsx';
import { ProjectsCard } from './taiga-projects.tsx';

export function TaigaScreen() {
  return (
    <ScreenBody>
      <PageHeader title="Taiga" description="Project trên Taiga và ticket được giao cho bạn, đọc trực tiếp từ Taiga." />
      <ProjectsCard />
      <TicketsCard />
    </ScreenBody>
  );
}
