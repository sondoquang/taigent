// The text form of `taigent metrics` (without --json): a header, each Role's section, then warnings and the
// metrics not available yet.

import { formatBusinessAnalystText } from './business-analyst.ts';
import type { MetricsReport } from './compute.ts';
import { formatBugTrendText, formatDeveloperBugsText } from './bugs.ts';
import { formatDeveloperText } from './developer.ts';
import { formatReleaseText } from './releases.ts';

export function formatMetricsText(report: MetricsReport): string {
  const { project, today, cadence, periods, warnings, unavailable } = report;
  const lines = [`Metrics of ${project.name} (${project.slug}) on ${today}, by ${cadence}`];
  lines.push(periods.length === 0 ? 'Periods: none started' : `Periods: ${periods.map((period) => `${period.name} (${period.start} → ${period.finish})`).join(', ')}`);
  lines.push('', ...formatDeveloperText(report.developer, periods), ...formatDeveloperBugsText(report.developer.bugs, periods));
  lines.push('', ...formatBugTrendText(report.productOwner.bugTrend, periods));
  lines.push('', ...formatReleaseText(report.productOwner.releaseBurndown));
  lines.push('', ...formatBusinessAnalystText(report.businessAnalyst));
  if (warnings.length > 0) lines.push('', 'Warnings:', ...warnings.map((warning) => `  ${warning.code}: ${warning.message}`));
  if (unavailable.length > 0) lines.push('', 'Not available yet:', ...unavailable.map((metric) => `  ${metric.metric}: ${metric.message}`));
  return `${lines.join('\n')}\n`;
}
