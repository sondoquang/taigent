// The text form of `taigent metrics` (without --json): a header, each Role's section, then warnings and the
// metrics not available yet.

import type { MetricsReport } from './compute.ts';
import { formatDeveloperText } from './developer.ts';

export function formatMetricsText(report: MetricsReport): string {
  const { project, today, cadence, periods, warnings, unavailable } = report;
  const lines = [`Metrics of ${project.name} (${project.slug}) on ${today}, by ${cadence}`];
  lines.push(periods.length === 0 ? 'Periods: none started' : `Periods: ${periods.map((period) => `${period.name} (${period.start} → ${period.finish})`).join(', ')}`);
  lines.push('', ...formatDeveloperText(report.developer, periods));
  if (warnings.length > 0) lines.push('', 'Warnings:', ...warnings.map((warning) => `  ${warning.code}: ${warning.message}`));
  if (unavailable.length > 0) lines.push('', 'Not available yet:', ...unavailable.map((metric) => `  ${metric.metric}: ${metric.message}`));
  return `${lines.join('\n')}\n`;
}
